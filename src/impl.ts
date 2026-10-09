import { access } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Build } from "./build";
import { configDir } from "./claude";
import { defaultBranch, gitCommonDir, gitError, listWorktrees, mergeDefaultInto, moveCurrent, syncToMain, visitedWorktree, type Log } from "./git";
import { StateStore } from "./state";
import { WorktreesView, worksIn, type ListedSession, type Target } from "./view";

export interface Loaded {
  resolve(view: vscode.WebviewView): void;
  setUpdate(build: Build | undefined): void;
  dispose(): void;
}

interface PendingOpen {
  folder: string;
  id: string;
}

const pollMs = 5000;
const pendingOpenKey = "pendingOpen";
const claudeReadyMs = 1500;

export async function activate(context: vscode.ExtensionContext, dir: string, running: Build): Promise<Loaded> {
  const view = new WorktreesView(vscode.Uri.file(path.join(dir, "media")), running, new StateStore(context.globalState));
  const refresh = debounce(() => void view.refresh(), 300);
  const watchers = (await watchPatterns()).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
  for (const watcher of watchers) {
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
  }
  const poll = setInterval(refresh, pollMs).unref();
  const update = (target: Target) => transition(view, target, (root, log) => mergeDefaultInto(root, target.branch, log));
  const disposables: vscode.Disposable[] = [
    ...watchers,
    { dispose: () => clearInterval(poll) },
    vscode.commands.registerCommand("worktreeHub.refresh", () => view.refresh(true)),
    vscode.commands.registerCommand("worktreeHub.open", (session: ListedSession) => openSession(session)),
    vscode.commands.registerCommand("worktreeHub.openInWindow", (session: ListedSession) => openInWindow(context, session)),
    vscode.commands.registerCommand("worktreeHub.newSession", (target: Target) => prefill(`/worktree ${target.branch}`)),
    vscode.commands.registerCommand("worktreeHub.mergeDefault", update),
    vscode.commands.registerCommand("worktreeHub.mergeDefaultAll", async (targets: Target[]) => {
      for (const target of targets) await update(target);
    }),
    vscode.commands.registerCommand("worktreeHub.goto", (target: Target) => goto(view, target)),
    vscode.commands.registerCommand("worktreeHub.gotoDefault", (target: Target) => transition(view, target, async (root, log) => {
      await moveCurrent(root, { branch: target.branch, worktree: target.path }, { branch: await defaultBranch(root) }, log);
    })),
    vscode.commands.registerCommand("worktreeHub.sync", (target: Target) => transition(view, target, (root, log) => syncToMain(root, target.path, log, true))),
  ];
  void openPending(context);
  return {
    resolve: (webviewView) => view.resolveWebviewView(webviewView),
    setUpdate: (build) => view.setUpdate(build),
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
      view.dispose();
    },
  };
}

async function watchPatterns(): Promise<vscode.RelativePattern[]> {
  const patterns = [new vscode.RelativePattern(vscode.Uri.file(path.join(configDir(), "projects")), "**/*.jsonl"), new vscode.RelativePattern(vscode.Uri.file(path.join(configDir(), "sessions")), "*.json")];
  const root = workspaceRoot();
  const common = root ? await gitCommonDir(root).catch(() => undefined) : undefined;
  if (common) patterns.push(new vscode.RelativePattern(vscode.Uri.file(common), "{HEAD,worktrees/**,refs/**}"));
  return patterns;
}

async function goto(view: WorktreesView, target: Target): Promise<void> {
  const moved = await transition(view, target, async (root, log) => {
    const trees = await listWorktrees(root);
    const current = trees[0].branch;
    if (!current) throw new Error("current n'est sur aucune branche (HEAD détaché) : rien n'a été déplacé");
    await moveCurrent(root, { branch: current, worktree: visitedWorktree(trees)?.path }, { branch: target.branch, worktree: target.path }, log);
  });
  const root = workspaceRoot();
  if (!moved || !root || !target.session) return;
  await openSession({ ...target.session, follow: worksIn(target.session.location, root, root) ? undefined : `/worktree here ${target.branch}` });
}

async function transition(view: WorktreesView, target: Target, run: (root: string, log: Log) => Promise<unknown>): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) return false;
  const lines: string[] = [];
  const log: Log = (line) => {
    lines.push(line);
    view.transition(target.path, lines, "running");
  };
  const succeeded = await view.exclusive(async () => {
    try {
      await run(root, log);
      view.transition(target.path, lines, "done");
      return true;
    } catch (error) {
      lines.push(gitError(error));
      view.transition(target.path, lines, "error");
      void vscode.window.showErrorMessage(`Worktree Hub : ${gitError(error)}`);
      return false;
    }
  });
  await view.refresh(true);
  return succeeded;
}

async function openSession(session: ListedSession): Promise<void> {
  if (!(await exists(session.file))) {
    void vscode.window.showErrorMessage(`Worktree Hub : transcript introuvable, la conversation n'existe plus (${session.file})`);
    return;
  }
  await vscode.commands.executeCommand("claude-vscode.editor.open", session.id, session.follow);
}

async function prefill(prompt: string): Promise<void> {
  await vscode.commands.executeCommand("claude-vscode.editor.open", undefined, prompt);
}

async function openInWindow(context: vscode.ExtensionContext, session: ListedSession): Promise<void> {
  await context.globalState.update(pendingOpenKey, { folder: session.location, id: session.id } satisfies PendingOpen);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(session.location), { forceNewWindow: true });
}

async function openPending(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<PendingOpen>(pendingOpenKey);
  const root = workspaceRoot();
  if (!pending || !root || pending.folder !== root) return;
  await context.globalState.update(pendingOpenKey, undefined);
  await vscode.extensions.getExtension("anthropic.claude-code")?.activate();
  await new Promise((resolve) => setTimeout(resolve, claudeReadyMs));
  await vscode.commands.executeCommand("claude-vscode.editor.open", pending.id);
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

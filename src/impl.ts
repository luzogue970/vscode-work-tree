import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Build } from "./build";
import { projectDir, type Session } from "./claude";
import { defaultBranch, gitCommonDir, gitError, listWorktrees, moveBranchToMain, moveBranchToWorktree } from "./git";
import { WorktreesView, type Target } from "./view";

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
const openInWorktreeWindow = "Ouvrir une fenêtre sur le worktree";
const tryHere = "Essayer ici quand même";

export async function activate(context: vscode.ExtensionContext, dir: string, running: Build): Promise<Loaded> {
  const view = new WorktreesView(vscode.Uri.file(path.join(dir, "media")), running);
  const refresh = debounce(() => void view.refresh(), 300);
  const watchers = (await watchPatterns()).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
  for (const watcher of watchers) {
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
  }
  const poll = setInterval(refresh, pollMs);
  const disposables: vscode.Disposable[] = [
    ...watchers,
    { dispose: () => clearInterval(poll) },
    vscode.commands.registerCommand("worktreeHub.refresh", () => view.refresh(true)),
    vscode.commands.registerCommand("worktreeHub.open", (session: Session) => openSession(context, session)),
    vscode.commands.registerCommand("worktreeHub.goto", (target: Target) => moveBranch(context, view, target, "toMain")),
    vscode.commands.registerCommand("worktreeHub.giveBack", (target: Target) => moveBranch(context, view, target, "toWorktree")),
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
  const projects = vscode.Uri.file(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects"));
  const patterns = [new vscode.RelativePattern(projects, "**/*.jsonl")];
  const root = workspaceRoot();
  const common = root ? await gitCommonDir(root).catch(() => undefined) : undefined;
  if (common) patterns.push(new vscode.RelativePattern(vscode.Uri.file(common), "{HEAD,worktrees/**}"));
  return patterns;
}

async function openSession(context: vscode.ExtensionContext, session: Session): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  if (!(await exists(session.file))) {
    void vscode.window.showErrorMessage(`Worktree Hub : transcript introuvable, la conversation n'existe plus (${session.file})`);
    return;
  }
  if (path.dirname(session.file) === projectDir(root)) {
    await vscode.commands.executeCommand("claude-vscode.editor.open", session.id);
    return;
  }
  const worktree = path.basename(session.cwd);
  const choice = await vscode.window.showWarningMessage(`Cette conversation vit dans le worktree ${worktree}. Depuis cette fenêtre, Claude Code risque d'ouvrir une conversation vide à la place.`, { modal: true }, openInWorktreeWindow, tryHere);
  if (choice === openInWorktreeWindow) {
    await context.globalState.update(pendingOpenKey, { folder: session.cwd, id: session.id } satisfies PendingOpen);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(session.cwd), { forceNewWindow: true });
  } else if (choice === tryHere) {
    await vscode.commands.executeCommand("claude-vscode.editor.open", session.id);
  }
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

async function moveBranch(context: vscode.ExtensionContext, view: WorktreesView, target: Target, direction: "toMain" | "toWorktree"): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const previousKey = `previous:${target.branch}`;
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    view.transition(target.path, lines, "running");
  };
  try {
    const main = (await listWorktrees(root))[0];
    if (direction === "toMain") {
      await context.workspaceState.update(previousKey, main.branch);
      await moveBranchToMain(main.path, target.path, target.branch, log);
    } else {
      await moveBranchToWorktree(main.path, target.path, target.branch, context.workspaceState.get<string>(previousKey) ?? (await defaultBranch(root)), log);
    }
    view.transition(target.path, lines, "done");
  } catch (error) {
    lines.push(gitError(error));
    view.transition(target.path, lines, "error");
    void vscode.window.showErrorMessage(`Worktree Hub : ${gitError(error)}`);
  }
  await view.refresh(true);
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

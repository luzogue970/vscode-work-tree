import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { newestBuild, readBuild, type Build } from "./build";
import { defaultBranch, gitCommonDir, gitError, listWorktrees, moveBranchToMain, moveBranchToWorktree } from "./git";
import { WorktreesView, type Target } from "./view";

const pollMs = 5000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const running = (await readBuild(context.extensionPath)) ?? { version: context.extension.packageJSON.version as string, builtAt: "" };
  const view = new WorktreesView(vscode.Uri.joinPath(context.extensionUri, "media"), running);
  const refresh = debounce(() => void view.refresh(), 300);
  const checkUpdate = () => void detectUpdate(context, running, view);

  const watchers = (await watchPatterns()).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
  for (const watcher of watchers) {
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
  }
  const poll = setInterval(() => {
    refresh();
    checkUpdate();
  }, pollMs);

  context.subscriptions.push(
    ...watchers,
    { dispose: () => clearInterval(poll) },
    vscode.window.registerWebviewViewProvider(WorktreesView.id, view),
    vscode.commands.registerCommand("worktreeHub.refresh", () => view.refresh(true)),
    vscode.commands.registerCommand("worktreeHub.update", restartExtensions),
    vscode.commands.registerCommand("worktreeHub.goto", (target: Target) => moveBranch(context, view, target, "toMain")),
    vscode.commands.registerCommand("worktreeHub.giveBack", (target: Target) => moveBranch(context, view, target, "toWorktree")),
  );
  checkUpdate();
}

async function watchPatterns(): Promise<vscode.RelativePattern[]> {
  const projects = vscode.Uri.file(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects"));
  const patterns = [new vscode.RelativePattern(projects, "**/*.jsonl")];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const common = root ? await gitCommonDir(root).catch(() => undefined) : undefined;
  if (common) patterns.push(new vscode.RelativePattern(vscode.Uri.file(common), "{HEAD,worktrees/**}"));
  return patterns;
}

async function moveBranch(context: vscode.ExtensionContext, view: WorktreesView, target: Target, direction: "toMain" | "toWorktree"): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  const previousKey = `previous:${target.branch}`;
  try {
    const main = (await listWorktrees(root))[0];
    if (direction === "toMain") {
      await context.workspaceState.update(previousKey, main.branch);
      await moveBranchToMain(main.path, target.path, target.branch);
    } else {
      await moveBranchToWorktree(main.path, target.path, target.branch, context.workspaceState.get<string>(previousKey) ?? (await defaultBranch(root)));
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Worktree Hub : ${gitError(error)}`);
  }
  await view.refresh(true);
}

async function detectUpdate(context: vscode.ExtensionContext, running: Build, view: WorktreesView): Promise<void> {
  const newest = await newestBuild(context.extensionPath, context.extension.id);
  const update = newest && newest.builtAt > running.builtAt ? newest : undefined;
  await vscode.commands.executeCommand("setContext", "worktreeHub.updateAvailable", update !== undefined);
  view.setUpdate(update);
}

async function restartExtensions(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  } catch {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

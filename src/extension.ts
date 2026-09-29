import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { newestBuild, readBuild, type Build } from "./build";
import { WorktreesView } from "./view";

const updatePollMs = 5000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const running = (await readBuild(context.extensionPath)) ?? { version: context.extension.packageJSON.version as string, builtAt: "" };
  const view = new WorktreesView(vscode.Uri.joinPath(context.extensionUri, "media"), running);
  const refresh = debounce(() => void view.refresh(), 500);
  const checkUpdate = () => void detectUpdate(context, running, view);

  const projects = vscode.Uri.file(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects"));
  const watchers = [
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projects, "*/*.jsonl")),
    vscode.workspace.createFileSystemWatcher("**/.git/worktrees/**"),
  ];
  for (const watcher of watchers) {
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
  }
  const poll = setInterval(checkUpdate, updatePollMs);

  context.subscriptions.push(
    ...watchers,
    { dispose: () => clearInterval(poll) },
    vscode.window.registerWebviewViewProvider(WorktreesView.id, view),
    vscode.commands.registerCommand("worktreeHub.refresh", () => view.refresh()),
    vscode.commands.registerCommand("worktreeHub.update", restartExtensions),
  );
  checkUpdate();
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

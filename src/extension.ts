import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { WorktreesView } from "./view";

export function activate(context: vscode.ExtensionContext): void {
  const view = new WorktreesView(vscode.Uri.joinPath(context.extensionUri, "media"));
  const refresh = debounce(() => void view.refresh(), 500);
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
  context.subscriptions.push(
    ...watchers,
    vscode.window.registerWebviewViewProvider(WorktreesView.id, view),
    vscode.commands.registerCommand("worktreeHub.refresh", () => view.refresh()),
  );
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

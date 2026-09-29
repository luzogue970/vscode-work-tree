import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { listSessions, type Session } from "./claude";
import { listWorktrees } from "./git";

interface Group {
  name: string;
  branch: string;
  path: string;
  main: boolean;
  sessions: Session[];
}

type Incoming = { type: "ready" } | { type: "open"; id: string };

export class WorktreesView implements vscode.WebviewViewProvider {
  static readonly id = "claudeWorktrees.view";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly media: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: Incoming) => {
      if (message.type === "ready") void this.refresh();
      if (message.type === "open") void vscode.commands.executeCommand("claude-vscode.editor.open", message.id);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      await this.view.webview.postMessage({ type: "data", groups: [], error: "Aucun dossier ouvert" });
      return;
    }
    try {
      await this.view.webview.postMessage({ type: "data", groups: await buildGroups(root) });
    } catch (error) {
      await this.view.webview.postMessage({ type: "data", groups: [], error: String(error) });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.media, "view.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.media, "view.js"));
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

async function buildGroups(root: string): Promise<Group[]> {
  const worktrees = await listWorktrees(root);
  const groups: Group[] = worktrees.map((tree) => ({ name: path.basename(tree.path), branch: tree.branch, path: tree.path, main: tree.main, sessions: [] }));
  const byDepth = [...groups].sort((a, b) => b.path.length - a.path.length);
  for (const session of await listSessions(worktrees.map((tree) => tree.path))) {
    const group = byDepth.find((candidate) => session.cwd === candidate.path || session.cwd.startsWith(candidate.path + path.sep)) ?? groups[0];
    group.sessions.push(session);
  }
  return groups;
}

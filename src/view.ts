import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Build } from "./build";
import { listSessions, type Session } from "./claude";
import { listWorktrees } from "./git";

interface Group {
  name: string;
  branch: string;
  path: string;
  main: boolean;
  sessions: Session[];
}

interface Payload {
  groups: Group[];
  error?: string;
}

type Incoming = { type: "ready" } | { type: "refresh" } | { type: "update" } | { type: "open"; id: string };

export class WorktreesView implements vscode.WebviewViewProvider {
  static readonly id = "worktreeHub.view";
  private view: vscode.WebviewView | undefined;
  private update: Build | undefined;
  private lastPosted = "";

  constructor(private readonly media: vscode.Uri, private readonly running: Build) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: Incoming) => {
      if (message.type === "ready" || message.type === "refresh") void this.refresh(true);
      if (message.type === "open") void vscode.commands.executeCommand("claude-vscode.editor.open", message.id);
      if (message.type === "update") void vscode.commands.executeCommand("worktreeHub.update");
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
  }

  setUpdate(update: Build | undefined): void {
    if (update?.builtAt === this.update?.builtAt) return;
    this.update = update;
    void this.refresh(true);
  }

  async refresh(force = false): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;
    if (force) await webview.postMessage({ type: "loading" });
    const payload = force ? await vscode.window.withProgress({ location: { viewId: WorktreesView.id } }, () => load()) : await load();
    const serialized = JSON.stringify(payload);
    if (!force && serialized === this.lastPosted) return;
    this.lastPosted = serialized;
    await webview.postMessage({ type: "data", running: this.running, update: this.update, refreshedAt: Date.now(), ...payload });
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
<div id="progress" class="progress"></div>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

async function load(): Promise<Payload> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return { groups: [], error: "Aucun dossier ouvert" };
  try {
    return { groups: await buildGroups(root) };
  } catch (error) {
    return { groups: [], error: String(error) };
  }
}

async function buildGroups(root: string): Promise<Group[]> {
  const worktrees = await listWorktrees(root);
  const groups: Group[] = worktrees.map((tree) => ({ name: path.basename(tree.path), branch: tree.branch, path: tree.path, main: tree.main, sessions: [] }));
  const byDepth = [...groups].sort((a, b) => b.path.length - a.path.length);
  for (const session of await listSessions(worktrees.map((tree) => tree.path))) {
    const group = byDepth.find((candidate) => session.cwd === candidate.path || session.cwd.startsWith(candidate.path + path.sep));
    group?.sessions.push(session);
  }
  return groups;
}

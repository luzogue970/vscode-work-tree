import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Build } from "./build";
import { listSessions, mirrorTranscripts, type Session } from "./claude";
import { countChanges, defaultBranch, isMerged, listBranches, listWorktrees, mergeTarget } from "./git";

export interface Target {
  path: string;
  branch: string;
}

type GroupState = "owned" | "taken" | "detached";

interface Group extends Target {
  name: string;
  main: boolean;
  state: GroupState;
  changes: number;
  merged: boolean;
  sessions: Session[];
}

interface Payload {
  groups: Group[];
  defaultBranch?: string;
  error?: string;
}

type Incoming =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "update" }
  | { type: "open"; session: Session }
  | { type: "openInWindow"; session: Session }
  | { type: "goto"; target: Target }
  | { type: "gotoDefault"; target: Target }
  | { type: "sync"; target: Target }
  | { type: "newSession"; target: Target };

const commands: Record<Exclude<Incoming["type"], "ready" | "refresh">, string> = {
  update: "worktreeHub.update",
  open: "worktreeHub.open",
  openInWindow: "worktreeHub.openInWindow",
  goto: "worktreeHub.goto",
  gotoDefault: "worktreeHub.gotoDefault",
  sync: "worktreeHub.sync",
  newSession: "worktreeHub.newSession",
};

export class WorktreesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = "worktreeHub.view";
  private view: vscode.WebviewView | undefined;
  private update: Build | undefined;
  private lastPosted = "";
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly media: vscode.Uri, private readonly running: Build) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    this.lastPosted = "";
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview);
    this.listeners.push(
      view.webview.onDidReceiveMessage((message: Incoming) => {
        if (message.type === "ready" || message.type === "refresh") {
          void this.refresh(true);
          return;
        }
        const argument = "session" in message ? message.session : "target" in message ? message.target : undefined;
        void vscode.commands.executeCommand(commands[message.type], argument);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
  }

  dispose(): void {
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }

  transition(path: string, lines: string[], status: "running" | "done" | "error"): void {
    void this.view?.webview.postMessage({ type: "transition", path, lines, status });
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
    return { groups: await buildGroups(root), defaultBranch: await defaultBranch(root) };
  } catch (error) {
    return { groups: [], error: String(error) };
  }
}

async function buildGroups(root: string): Promise<Group[]> {
  const worktrees = await listWorktrees(root);
  const branches = await listBranches(root);
  const mainBranch = worktrees[0]?.branch;
  const target = await mergeTarget(root);
  const groups: Group[] = await Promise.all(worktrees.map(async (tree) => {
    const name = path.basename(tree.path);
    const branch = tree.branch ?? branches.find((candidate) => candidate.replaceAll("/", "-") === name);
    const state: GroupState = tree.branch ? "owned" : branch !== undefined && branch === mainBranch ? "taken" : "detached";
    const changes = tree.main ? 0 : await countChanges(tree.path);
    const merged = !tree.main && branch !== undefined && (await isMerged(root, branch, target));
    return { name, branch: branch ?? "(détaché)", path: tree.path, main: tree.main, state, changes, merged, sessions: [] };
  }));
  const linked = groups.filter((group) => !group.main).sort((a, b) => b.path.length - a.path.length);
  const sessions = await listSessions(linked.map((group) => group.path));
  await mirrorTranscripts(sessions, root);
  for (const session of sessions) {
    const group = linked.find((candidate) => session.cwd === candidate.path || session.cwd.startsWith(candidate.path + path.sep));
    group?.sessions.push(session);
  }
  return groups;
}

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Build } from "./build";
import { listRepoSessions, liveSessions, mirrorTranscripts, projectDir, scanWorktreeEntries, type Session } from "./claude";
import { behindCount, countChanges, defaultBranch, isMerged, listBranches, listWorktrees, mergeTarget, worktreeName } from "./git";
import type { StateStore } from "./state";

export interface Target {
  path: string;
  branch: string;
  session?: ListedSession;
}

type GroupState = "owned" | "taken" | "detached" | "removed";

export interface ListedSession extends Session {
  location: string;
  live: boolean;
  follow?: string;
}

interface Group {
  name: string;
  branch: string;
  path: string;
  home: string;
  main: boolean;
  state: GroupState;
  changes: number;
  merged: boolean;
  behind: number;
  sessions: ListedSession[];
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
  | { type: "open"; session: ListedSession }
  | { type: "openInWindow"; session: ListedSession }
  | { type: "goto"; target: Target }
  | { type: "gotoDefault"; target: Target }
  | { type: "sync"; target: Target }
  | { type: "newSession"; target: Target }
  | { type: "mergeDefault"; target: Target }
  | { type: "mergeDefaultAll"; targets: Target[] };

const commands: Record<Exclude<Incoming["type"], "ready" | "refresh">, string> = {
  update: "worktreeHub.update",
  open: "worktreeHub.open",
  openInWindow: "worktreeHub.openInWindow",
  goto: "worktreeHub.goto",
  gotoDefault: "worktreeHub.gotoDefault",
  sync: "worktreeHub.sync",
  newSession: "worktreeHub.newSession",
  mergeDefault: "worktreeHub.mergeDefault",
  mergeDefaultAll: "worktreeHub.mergeDefaultAll",
};

export class WorktreesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = "worktreeHub.view";
  private view: vscode.WebviewView | undefined;
  private update: Build | undefined;
  private lastPosted = "";
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly media: vscode.Uri, private readonly running: Build, private readonly store: StateStore) {}

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
        const argument = "session" in message ? message.session : "target" in message ? message.target : "targets" in message ? message.targets : undefined;
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
    const payload = force ? await vscode.window.withProgress({ location: { viewId: WorktreesView.id } }, () => this.load()) : await this.load();
    const serialized = JSON.stringify(payload);
    if (!force && serialized === this.lastPosted) return;
    this.lastPosted = serialized;
    await webview.postMessage({ type: "data", running: this.running, update: this.update, refreshedAt: Date.now(), ...payload });
  }

  async load(): Promise<Payload> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return { groups: [], error: "Aucun dossier ouvert" };
    try {
      return { groups: await buildGroups(root, this.store), defaultBranch: await defaultBranch(root) };
    } catch (error) {
      return { groups: [], error: String(error) };
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
<div id="progress" class="progress"></div>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export function worksIn(location: string, home: string, root: string): boolean {
  if (!isInside(location, home)) return false;
  return home !== root || !isInside(location, path.join(root, ".claude", "worktrees"));
}

function isInside(location: string, dir: string): boolean {
  return location === dir || location.startsWith(dir + path.sep);
}

async function buildGroups(root: string, store: StateStore): Promise<Group[]> {
  const state = store.get(root);
  const worktrees = await listWorktrees(root);
  const branches = await listBranches(root);
  const mainBranch = worktrees[0]?.branch;
  const target = await mergeTarget(root);
  const groups: Group[] = await Promise.all(worktrees.map(async (tree) => {
    const name = path.basename(tree.path);
    const branch = tree.branch ?? branches.find((candidate) => worktreeName(candidate) === name);
    const state: GroupState = tree.branch ? "owned" : branch !== undefined && branch === mainBranch ? "taken" : "detached";
    const changes = tree.main ? 0 : await countChanges(tree.path);
    const merged = !tree.main && branch !== undefined && (await isMerged(root, branch, target));
    const behind = tree.main || merged || branch === undefined ? 0 : await behindCount(root, branch, target);
    const home = state === "taken" ? root : tree.path;
    return { name, branch: branch ?? "(détaché)", path: tree.path, home, main: tree.main, state, changes, merged, behind, sessions: [] };
  }));
  for (const group of groups) if (!group.main && group.branch !== "(détaché)") state.worktrees[group.path] = group.branch;

  const sessions = await listRepoSessions(root);
  const scanned = await scanWorktreeEntries(sessions, root, state);
  const live = await liveSessions();
  const bound = sessions.filter((session) => state.bindings[session.id] !== undefined);
  await mirrorTranscripts(bound.filter((session) => path.dirname(session.file) !== projectDir(root)), root);
  for (const session of bound) {
    const worktree = state.bindings[session.id];
    const group = groups.find((candidate) => candidate.path === worktree) ?? removedGroup(groups, worktree, state.worktrees[worktree]);
    if (!group) continue;
    const location = live.get(session.id) ?? session.resumeCwd;
    const follow = group.state === "removed" || worksIn(location, group.home, root) ? undefined : `/worktree here ${group.branch}`;
    group.sessions.push({ ...session, location, live: live.has(session.id), follow });
  }
  if (scanned) await store.save(root, state);
  return groups;
}

function removedGroup(groups: Group[], worktree: string, branch: string | undefined): Group | undefined {
  if (branch === undefined) return undefined;
  const group: Group = { name: path.basename(worktree), branch, path: worktree, home: worktree, main: false, state: "removed", changes: 0, merged: true, behind: 0, sessions: [] };
  groups.push(group);
  return group;
}

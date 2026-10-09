import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { Build } from "../src/build";
import { activate, type Loaded } from "../src/impl";
import { StateStore } from "../src/state";
import { WorktreesView, type ListedSession } from "../src/view";
import { addWorktree, branchWithCommit, enterWorktreeLine, git, initRepo, projectDirOf, tempDir, userLine, waitFor, write, writeTranscript } from "./helpers";
import { FakeWebviewView, Memento, calls, makeContext, messages, reset, state } from "./stubs/vscode";

interface Group {
  name: string;
  branch: string;
  path: string;
  home: string;
  main: boolean;
  current: boolean;
  state: string;
  changes: number;
  syncError?: string;
  merged: boolean;
  behind: number;
  sessions: ListedSession[];
}

const running: Build = { dir: "/ext", version: "9.9.9", builtAt: "2026-01-01T00:00:00Z", contributes: "{}" };

interface Fixture {
  root: string;
  worktree: string;
  file: string;
  configDir: string;
  context: ReturnType<typeof makeContext>;
  loaded: Loaded;
  view: FakeWebviewView;
}

async function fixture(options: { pending?: boolean; second?: boolean } = {}): Promise<Fixture> {
  reset();
  const configDir = tempDir("cfg");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const root = initRepo();
  branchWithCommit(root, "feat/x", "g", "x");
  const worktree = addWorktree(root, "feat/x");
  if (options.second) {
    branchWithCommit(root, "feat/y", "h", "y");
    const other = addWorktree(root, "feat/y");
    writeTranscript(configDir, other, "sess-y", [userLine(root, "start y"), enterWorktreeLine({ path: other }), userLine(other, "in y", { gitBranch: "feat/y" })]);
  }
  const file = writeTranscript(configDir, worktree, "sess-1", [userLine(root, "hello"), enterWorktreeLine({ path: worktree }), userLine(worktree, "in the worktree", { gitBranch: "feat/x" }), { type: "relocated", relocatedCwd: worktree }, { type: "ai-title", aiTitle: "Worktree talk" }]);
  writeTranscript(configDir, root, "sess-main", [userLine(root, "main talk")]);
  writeTranscript(configDir, worktree, "sess-cd-only", [userLine(worktree, "cd'd there without /worktree")]);
  state.workspaceFolders = [root];
  const context = makeContext("/ext");
  if (options.pending) await context.globalState.update("pendingOpen", { folder: root, id: "pending-id" });
  const loaded = await activate(context as never, "/ext", running);
  const view = new FakeWebviewView();
  loaded.resolve(view as never);
  view.send({ type: "ready" });
  await waitFor(() => view.last("data") !== undefined);
  return { root, worktree, file, configDir, context, loaded, view };
}

function groups(view: FakeWebviewView): Group[] {
  return view.last("data")?.groups as Group[];
}

function group(view: FakeWebviewView, name: string): Group {
  const found = groups(view).find((candidate) => candidate.name === name);
  assert.ok(found, `group ${name}`);
  return found;
}

async function nextData(view: FakeWebviewView, after: number): Promise<Group[]> {
  await waitFor(() => view.posted.filter((message) => message.type === "data").length > after);
  return groups(view);
}

async function refreshed(view: FakeWebviewView): Promise<Group[]> {
  const count = view.posted.filter((message) => message.type === "data").length;
  view.send({ type: "refresh" });
  return nextData(view, count);
}

async function until(view: FakeWebviewView, predicate: (list: Group[]) => boolean): Promise<Group[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await refreshed(view);
    if (predicate(list)) return list;
  }
  throw new Error("until: condition not met after 20 refreshes");
}

async function transition(view: FakeWebviewView, message: unknown): Promise<{ lines: string[]; status: string }> {
  const dataBefore = view.posted.filter((m) => m.type === "data").length;
  view.send(message);
  await waitFor(() => ["done", "error"].includes(view.last("transition")?.status as string));
  await nextData(view, dataBefore);
  const last = view.last("transition") as { lines: string[]; status: string };
  return { lines: last.lines, status: last.status };
}

function opened(): unknown[][] {
  return calls.filter((call) => call.command === "claude-vscode.editor.open").map((call) => call.args);
}

describe("activation and listing", () => {
  test("lists only the conversations that entered the worktree, and mirrors their transcript", async () => {
    const f = await fixture();
    const list = groups(f.view);
    assert.deepEqual(list.map((candidate) => [candidate.name, candidate.branch, candidate.main, candidate.current, candidate.state, candidate.sessions.map((session) => session.id)]), [[path.basename(f.root), "main", true, true, "owned", []], ["feat-x", "feat/x", false, false, "owned", ["sess-1"]]]);
    const session = list[1].sessions[0];
    assert.equal(session.title, "Worktree talk");
    assert.equal(session.location, f.worktree);
    assert.equal(session.live, false);
    assert.equal(session.follow, undefined);
    const mirror = path.join(projectDirOf(f.configDir, f.root), "sess-1.jsonl");
    assert.ok(existsSync(mirror));
    assert.equal(statSync(mirror).ino, statSync(f.file).ino);
    const data = f.view.last("data") as { running: Build; update?: Build; refreshedAt: number; defaultBranch: string };
    assert.equal(data.running.version, "9.9.9");
    assert.equal(data.update, undefined);
    assert.equal(data.defaultBranch, "main");
    assert.ok(data.refreshedAt > 0);
  });

  test("the binding is saved and survives Claude Code refiling the conversation under the main checkout", async () => {
    const f = await fixture();
    assert.equal((f.context.globalState.get(`repo:${f.root}`) as { bindings: Record<string, string> }).bindings["sess-1"], f.worktree);
    const mainCopy = path.join(projectDirOf(f.configDir, f.root), "sess-1.jsonl");
    unlinkSync(f.file);
    appendFileSync(mainCopy, [userLine(f.root, "now working in the main checkout"), { type: "relocated", relocatedCwd: f.root }].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const list = await refreshed(f.view);
    const session = list[1].sessions[0];
    assert.equal(session.id, "sess-1");
    assert.equal(session.file, mainCopy);
    assert.equal(session.location, f.root);
    assert.equal(session.follow, "/worktree here feat/x");
  });

  test("a live session is flagged and located from Claude Code's session registry", async () => {
    const f = await fixture();
    mkdirSync(path.join(f.configDir, "sessions"), { recursive: true });
    writeFileSync(path.join(f.configDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "sess-1", cwd: f.root }));
    const session = (await refreshed(f.view))[1].sessions[0];
    assert.equal(session.live, true);
    assert.equal(session.location, f.root);
    assert.equal(session.follow, "/worktree here feat/x");
  });

  test("a removed worktree stays in the archive with its conversations", async () => {
    const f = await fixture();
    for (const name of ["sess-1.jsonl", "sess-cd-only.jsonl"]) unlinkSync(path.join(projectDirOf(f.configDir, f.worktree), name));
    git(f.root, "worktree", "remove", f.worktree);
    const removed = (await refreshed(f.view)).find((candidate) => candidate.path === f.worktree);
    assert.ok(removed);
    assert.equal(removed.state, "removed");
    assert.equal(removed.merged, true);
    assert.equal(removed.branch, "feat/x");
    assert.deepEqual(removed.sessions.map((session) => session.id), ["sess-1"]);
    assert.equal(removed.sessions[0].follow, undefined);
  });

  test("a worktree behind the default branch says by how much", async () => {
    const f = await fixture();
    write(f.root, "m", "on main");
    git(f.root, "add", "m");
    git(f.root, "commit", "-qm", "main moved");
    assert.equal((await refreshed(f.view))[1].behind, 1);
  });

  test("ready posts a loading message before the data", async () => {
    const f = await fixture();
    assert.deepEqual(f.view.posted.map((message) => message.type).slice(0, 2), ["loading", "data"]);
  });

  test("setUpdate re-posts the data with the available build", async () => {
    const f = await fixture();
    const count = f.view.posted.filter((m) => m.type === "data").length;
    f.loaded.setUpdate({ ...running, version: "10.0.0", builtAt: "2027-01-01T00:00:00Z" });
    await nextData(f.view, count);
    assert.equal((f.view.last("data")?.update as Build).version, "10.0.0");
  });

  test("without a workspace folder the view reports an error", async () => {
    reset();
    const loaded = await activate(makeContext("/ext") as never, "/ext", running);
    const view = new FakeWebviewView();
    loaded.resolve(view as never);
    view.send({ type: "ready" });
    await waitFor(() => view.last("data") !== undefined);
    assert.equal(view.last("data")?.error, "Aucun dossier ouvert");
    loaded.dispose();
  });

  test("dispose unregisters the commands", async () => {
    const f = await fixture();
    f.loaded.dispose();
    calls.length = 0;
    f.view.send({ type: "refresh" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.view.posted.filter((m) => m.type === "loading").length, 1);
  });
});

describe("opening conversations", () => {
  const cases = [
    { name: "a conversation where its branch is opens as is", away: false, missing: false, want: [["sess-1", undefined]], wantError: false },
    { name: "a conversation away from its branch opens with /worktree here pre-filled", away: true, missing: false, want: [["sess-1", "/worktree here feat/x"]], wantError: false },
    { name: "a missing transcript raises an error and opens nothing", away: false, missing: true, want: [], wantError: true },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const f = await fixture();
      const session = { ...group(f.view, "feat-x").sessions[0] };
      if (tc.away) session.follow = "/worktree here feat/x";
      if (tc.missing) session.file = "/nowhere.jsonl";
      calls.length = 0;
      f.view.send({ type: "open", session });
      await waitFor(() => opened().length > 0 || messages.length > 0);
      assert.deepEqual(opened(), tc.want);
      assert.equal(messages.some((message) => message.kind === "error"), tc.wantError);
    });
  }

  const prefills = [
    { name: "a new conversation runs /worktree in a fresh Claude tab", message: (target: unknown) => ({ type: "newSession", target }), want: [[undefined, "/worktree feat/x"]] },
  ];
  for (const tc of prefills) {
    test(tc.name, async () => {
      const f = await fixture();
      calls.length = 0;
      f.view.send(tc.message({ path: f.worktree, branch: "feat/x" }));
      await waitFor(() => opened().length === tc.want.length);
      assert.deepEqual(opened(), tc.want);
    });
  }

  const updates = [
    { name: "Mettre à jour merges main in the background, without a conversation", message: (x: unknown, _y: unknown) => ({ type: "mergeDefault", target: x }), wantMerged: ["feat/x"] },
    { name: "updating every late worktree merges them one after the other", message: (x: unknown, y: unknown) => ({ type: "mergeDefaultAll", targets: [x, y] }), wantMerged: ["feat/x", "feat/y"] },
  ];
  for (const tc of updates) {
    test(tc.name, async () => {
      const f = await fixture({ second: true });
      write(f.root, "m", "main\n");
      git(f.root, "add", "m");
      git(f.root, "commit", "-qm", "main advance");
      await until(f.view, (list) => list.filter((candidate) => candidate.behind > 0).length === 2);
      calls.length = 0;
      const other = path.join(path.dirname(f.worktree), "feat-y");
      f.view.send(tc.message({ path: f.worktree, branch: "feat/x" }, { path: other, branch: "feat/y" }));
      const merged = () => ["feat/x", "feat/y"].filter((branch) => git(f.root, "rev-list", "--count", `${branch}..main`) === "0");
      await waitFor(() => merged().length === tc.wantMerged.length && f.view.last("transition")?.status === "done", 30000);
      assert.deepEqual(merged(), tc.wantMerged);
      assert.deepEqual((await refreshed(f.view)).filter((one) => !one.main && one.behind === 0).map((one) => one.branch), tc.wantMerged);
      assert.deepEqual(opened(), []);
      assert.equal(messages.length, 0);
    });
  }

  test("open in window stores the pending session and opens the folder it works in", async () => {
    const f = await fixture();
    const session = group(f.view, "feat-x").sessions[0];
    f.view.send({ type: "openInWindow", session });
    await waitFor(() => calls.some((call) => call.command === "vscode.openFolder"));
    const call = calls.find((candidate) => candidate.command === "vscode.openFolder");
    assert.equal((call?.args[0] as { fsPath: string }).fsPath, f.worktree);
    assert.deepEqual(call?.args[1], { forceNewWindow: true });
    assert.deepEqual(f.context.globalState.get("pendingOpen"), { folder: f.worktree, id: "sess-1" });
  });

  test("a pending session for this folder is opened at activation", async () => {
    const f = await fixture({ pending: true });
    await waitFor(() => calls.some((call) => call.command === "claude-vscode.editor.open" && call.args[0] === "pending-id"), 4000);
    assert.equal(f.context.globalState.get("pendingOpen"), undefined);
  });
});

describe("moving branches from the view", () => {
  test("Aller, the automatic bring-back and Aller sur main drive git, log every step and open the conversation", async () => {
    const f = await fixture();
    const session = group(f.view, "feat-x").sessions[0];
    const target = { path: f.worktree, branch: "feat/x", session };
    write(f.worktree, "n", "uncommitted");
    calls.length = 0;

    const goto = await transition(f.view, { type: "goto", target });
    assert.equal(goto.status, "done");
    assert.match(goto.lines.join("\n"), /git switch feat\/x[\s\S]*staged/);
    assert.equal(git(f.root, "branch", "--show-current"), "feat/x");
    assert.equal(git(f.root, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(git(f.root, "diff", "--cached", "--name-only"), "n");
    assert.equal(group(f.view, "feat-x").state, "taken");
    assert.equal(group(f.view, "feat-x").home, f.root);
    assert.deepEqual(groups(f.view).map((candidate) => [candidate.name, candidate.current]), [["feat-x", true]]);
    assert.equal(group(f.view, "feat-x").sessions[0].follow, "/worktree here feat/x");
    await waitFor(() => opened().length === 1);
    assert.deepEqual(opened(), [["sess-1", "/worktree here feat/x"]]);
    assert.equal(messages.length, 0);

    write(f.worktree, "bg", "background work");
    await until(f.view, () => git(f.root, "diff", "--cached", "--name-only").includes("bg"));
    assert.equal(readFileSync(path.join(f.root, "bg"), "utf8"), "background work");
    assert.deepEqual(git(f.root, "diff", "--cached", "--name-only").split("\n"), ["bg", "n"]);
    assert.equal(git(f.worktree, "status", "--porcelain"), "");
    assert.equal(git(f.root, "log", "-1", "--format=%s"), "commit on feat/x");

    const back = await transition(f.view, { type: "gotoDefault", target });
    assert.equal(back.status, "done");
    assert.match(back.lines.join("\n"), /git switch main[\s\S]*feat-x reprend feat\/x/);
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(group(f.view, "feat-x").state, "owned");
    assert.deepEqual(groups(f.view).map((candidate) => [candidate.main, candidate.current]), [[true, true], [false, false]]);
    const worktreeStatus = git(f.worktree, "status", "--porcelain");
    assert.match(worktreeStatus, /\?\? bg/);
    assert.match(worktreeStatus, /\?\? n/);
  });

  test("work landing in the visited worktree is brought back to current on its own", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    assert.equal((await transition(f.view, { type: "goto", target })).status, "done");
    write(f.worktree, "late", "written in the worktree after Aller");
    await until(f.view, () => git(f.root, "status", "--porcelain").includes("A  late"));
    const box = f.view.last("transition") as { path: string; lines: string[]; status: string };
    assert.equal(box.path, f.worktree);
    assert.equal(box.status, "done");
    assert.equal(box.lines[0], "Rapatriement automatique vers current");
    assert.equal(git(f.worktree, "status", "--porcelain"), "");
    assert.equal(group(f.view, "feat-x").syncError, undefined);
    assert.equal(messages.length, 0);
  });

  test("a blocked bring-back is flagged quietly, and the retry works once the conflict is gone", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    assert.equal((await transition(f.view, { type: "goto", target })).status, "done");
    write(f.root, "g", "edited on current");
    write(f.worktree, "g", "edited in the worktree");
    await until(f.view, () => group(f.view, "feat-x").syncError !== undefined);
    assert.equal(messages.length, 0);
    assert.equal(readFileSync(path.join(f.root, "g"), "utf8"), "edited on current");
    git(f.root, "checkout", "--", "g");
    const retry = await transition(f.view, { type: "sync", target });
    assert.equal(retry.status, "done");
    assert.equal(readFileSync(path.join(f.root, "g"), "utf8"), "edited in the worktree");
    await until(f.view, () => group(f.view, "feat-x").syncError === undefined);
  });

  test("the current block counts the uncommitted changes of current", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    assert.equal((await transition(f.view, { type: "goto", target })).status, "done");
    write(f.root, "on-current-1", "a");
    write(f.root, "on-current-2", "b");
    await until(f.view, () => group(f.view, "feat-x").changes === 2);
  });

  test("Aller from another worktree's branch swaps the two", async () => {
    const f = await fixture({ second: true });
    const other = group(f.view, "feat-y");
    assert.equal((await transition(f.view, { type: "goto", target: { path: f.worktree, branch: "feat/x" } })).status, "done");
    write(f.root, "made-on-current", "c");
    const swap = await transition(f.view, { type: "goto", target: { path: other.path, branch: "feat/y", session: other.sessions[0] } });
    assert.equal(swap.status, "done");
    assert.equal(git(f.root, "branch", "--show-current"), "feat/y");
    assert.equal(group(f.view, "feat-x").state, "owned");
    assert.equal(group(f.view, "feat-y").state, "taken");
    assert.deepEqual(groups(f.view).map((candidate) => [candidate.name, candidate.current]), [["feat-y", true], ["feat-x", false]]);
    assert.match(git(f.worktree, "status", "--porcelain"), /\?\? made-on-current/);
    await waitFor(() => opened().some((args) => args[0] === "sess-y"));
  });

  test("main's own work is parked on Aller and back after Aller sur main", async () => {
    const f = await fixture();
    write(f.root, "wip-on-main", "mine");
    const target = { path: f.worktree, branch: "feat/x" };
    const goto = await transition(f.view, { type: "goto", target });
    assert.match(goto.lines.join("\n"), /garé/);
    assert.equal(git(f.root, "status", "--porcelain"), "");
    const back = await transition(f.view, { type: "gotoDefault", target });
    assert.match(back.lines.join("\n"), /restauré/);
    assert.match(git(f.root, "status", "--porcelain"), /\?\? wip-on-main/);
    assert.equal(git(f.root, "stash", "list"), "");
  });

  test("a refused Aller sur main ends in error, shows it and leaves git untouched", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    assert.equal((await transition(f.view, { type: "goto", target })).status, "done");
    write(f.root, "g", "edited on current");
    write(f.worktree, "g", "edited in the worktree");
    const result = await transition(f.view, { type: "gotoDefault", target });
    assert.equal(result.status, "error");
    assert.equal(messages[0]?.kind, "error");
    assert.equal(git(f.root, "branch", "--show-current"), "feat/x");
    assert.equal(readFileSync(path.join(f.root, "g"), "utf8"), "edited on current");
    assert.equal(group(f.view, "feat-x").state, "taken");
  });

  test("Aller refuses a detached current and moves nothing", async () => {
    const f = await fixture();
    git(f.root, "switch", "-q", "--detach");
    const result = await transition(f.view, { type: "goto", target: { path: f.worktree, branch: "feat/x" } });
    assert.equal(result.status, "error");
    assert.match(result.lines.at(-1) as string, /aucune branche/);
    assert.equal(git(f.worktree, "branch", "--show-current"), "feat/x");
  });

  test("a merged worktree is flagged", async () => {
    const f = await fixture();
    git(f.root, "merge", "-q", "--no-ff", "-m", "merge", "feat/x");
    await until(f.view, () => group(f.view, "feat-x").merged);
  });
});

describe("WorktreesView refresh", () => {
  beforeEach(() => reset());

  test("unchanged data is not re-posted unless forced", async () => {
    const root = initRepo();
    state.workspaceFolders = [root];
    process.env.CLAUDE_CONFIG_DIR = tempDir("cfg");
    const view = new WorktreesView({ fsPath: "/media" } as never, running, new StateStore(new Memento()));
    const fake = new FakeWebviewView();
    view.resolveWebviewView(fake as never);
    await view.refresh(true);
    await view.refresh();
    await view.refresh();
    assert.equal(fake.posted.filter((m) => m.type === "data").length, 1);
    await view.refresh(true);
    assert.equal(fake.posted.filter((m) => m.type === "data").length, 2);
    fake.dispose();
    await view.refresh(true);
    assert.equal(fake.posted.filter((m) => m.type === "data").length, 2);
  });

  test("becoming visible refreshes", async () => {
    const root = initRepo();
    state.workspaceFolders = [root];
    const view = new WorktreesView({ fsPath: "/media" } as never, running, new StateStore(new Memento()));
    const fake = new FakeWebviewView();
    view.resolveWebviewView(fake as never);
    fake.show(true);
    await waitFor(() => fake.last("data") !== undefined);
  });
});

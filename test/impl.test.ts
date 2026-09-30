import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { Build } from "../src/build";
import type { Session } from "../src/claude";
import { activate, type Loaded } from "../src/impl";
import { WorktreesView } from "../src/view";
import { addWorktree, branchWithCommit, git, initRepo, projectDirOf, tempDir, userLine, waitFor, write, writeTranscript } from "./helpers";
import { FakeWebviewView, calls, makeContext, messages, reset, state } from "./stubs/vscode";

interface Group {
  name: string;
  branch: string;
  path: string;
  main: boolean;
  state: string;
  changes: number;
  merged: boolean;
  sessions: Session[];
}

const running: Build = { dir: "/ext", version: "9.9.9", builtAt: "2026-01-01T00:00:00Z", contributes: "{}" };

interface Fixture {
  root: string;
  worktree: string;
  file: string;
  context: ReturnType<typeof makeContext>;
  loaded: Loaded;
  view: FakeWebviewView;
}

async function fixture(options: { pending?: boolean } = {}): Promise<Fixture> {
  reset();
  const configDir = tempDir("cfg");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const root = initRepo();
  branchWithCommit(root, "feat/x", "g", "x");
  const worktree = addWorktree(root, "feat/x");
  const file = writeTranscript(configDir, worktree, "sess-1", [userLine(worktree, "hello", { gitBranch: "feat/x" }), { type: "ai-title", aiTitle: "Worktree talk" }]);
  writeTranscript(configDir, root, "sess-main", [userLine(root, "main talk")]);
  state.workspaceFolders = [root];
  const context = makeContext("/ext");
  if (options.pending) await context.globalState.update("pendingOpen", { folder: root, id: "pending-id" });
  const loaded = await activate(context as never, "/ext", running);
  const view = new FakeWebviewView();
  loaded.resolve(view as never);
  view.send({ type: "ready" });
  await waitFor(() => view.last("data") !== undefined);
  return { root, worktree, file, context, loaded, view };
}

function groups(view: FakeWebviewView): Group[] {
  return view.last("data")?.groups as Group[];
}

async function nextData(view: FakeWebviewView, after: number): Promise<Group[]> {
  await waitFor(() => view.posted.filter((message) => message.type === "data").length > after);
  return groups(view);
}

async function transition(view: FakeWebviewView, message: unknown): Promise<{ lines: string[]; status: string }> {
  const dataBefore = view.posted.filter((m) => m.type === "data").length;
  view.send(message);
  await waitFor(() => ["done", "error"].includes(view.last("transition")?.status as string));
  await nextData(view, dataBefore);
  const last = view.last("transition") as { lines: string[]; status: string };
  return { lines: last.lines, status: last.status };
}

describe("activation and listing", () => {
  test("lists worktrees, attributes sessions, mirrors the transcript", async () => {
    const f = await fixture();
    const list = groups(f.view);
    assert.deepEqual(list.map((group) => [group.name, group.branch, group.main, group.state, group.sessions.length]), [[path.basename(f.root), "main", true, "owned", 0], ["feat-x", "feat/x", false, "owned", 1]]);
    assert.equal(list[1].sessions[0].title, "Worktree talk");
    const mirror = path.join(projectDirOf(process.env.CLAUDE_CONFIG_DIR as string, f.root), "sess-1.jsonl");
    assert.ok(existsSync(mirror));
    assert.equal(statSync(mirror).ino, statSync(f.file).ino);
    const data = f.view.last("data") as { running: Build; update?: Build; refreshedAt: number };
    assert.equal(data.running.version, "9.9.9");
    assert.equal(data.update, undefined);
    assert.ok(data.refreshedAt > 0);
  });

  test("a worktree conversation moved by Claude Code to the main project stays under the worktree", async () => {
    const f = await fixture();
    const mainCopy = path.join(projectDirOf(process.env.CLAUDE_CONFIG_DIR as string, f.root), "sess-1.jsonl");
    unlinkSync(f.file);
    appendFileSync(mainCopy, JSON.stringify({ type: "relocated", relocatedCwd: f.root, sessionId: "sess-1" }) + "\n");
    f.view.send({ type: "refresh" });
    await waitFor(() => groups(f.view)[1].sessions.length === 1 && groups(f.view)[1].sessions[0].file === mainCopy);
    assert.equal(groups(f.view)[1].sessions[0].id, "sess-1");
    assert.equal(groups(f.view)[0].sessions.length, 0);
  });

  test("a conversation working in the main checkout is never listed", async () => {
    const f = await fixture();
    const listed = groups(f.view).flatMap((group) => group.sessions.map((session) => session.id));
    assert.deepEqual(listed, ["sess-1"]);
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
    { name: "an existing transcript opens through Claude Code", missing: false, wantCommand: "claude-vscode.editor.open", wantError: false },
    { name: "a missing transcript raises an error and opens nothing", missing: true, wantCommand: undefined, wantError: true },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const f = await fixture();
      const session = groups(f.view)[1].sessions[0];
      if (tc.missing) session.file = "/nowhere.jsonl";
      calls.length = 0;
      f.view.send({ type: "open", session });
      await waitFor(() => calls.some((call) => call.command === "claude-vscode.editor.open") || messages.length > 0);
      assert.equal(calls.find((call) => call.command === "claude-vscode.editor.open")?.args[0], tc.wantCommand === undefined ? undefined : "sess-1");
      assert.equal(messages.some((message) => message.kind === "error"), tc.wantError);
    });
  }

  test("a new session runs /worktree in a fresh Claude tab", async () => {
    const f = await fixture();
    f.view.send({ type: "newSession", target: { path: f.worktree, branch: "feat/x" } });
    await waitFor(() => calls.some((call) => call.command === "claude-vscode.editor.open"));
    assert.deepEqual(calls.find((call) => call.command === "claude-vscode.editor.open")?.args, [undefined, "/worktree feat/x"]);
  });

  test("open in window stores the pending session and opens the folder", async () => {
    const f = await fixture();
    const session = groups(f.view)[1].sessions[0];
    f.view.send({ type: "openInWindow", session });
    await waitFor(() => calls.some((call) => call.command === "vscode.openFolder"));
    const call = calls.find((call) => call.command === "vscode.openFolder");
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

describe("branch transfer from the view", () => {
  test("goto, sync and gotoDefault drive git and log every step", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    write(f.worktree, "n", "uncommitted");

    const goto = await transition(f.view, { type: "goto", target });
    assert.equal(goto.status, "done");
    assert.match(goto.lines.join("\n"), /git switch feat\/x[\s\S]*staged/);
    assert.equal(git(f.root, "branch", "--show-current"), "feat/x");
    assert.equal(git(f.root, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(git(f.root, "diff", "--cached", "--name-only"), "n");
    assert.equal(groups(f.view)[1].state, "taken");
    assert.equal(f.view.last("data")?.defaultBranch, "main");
    assert.ok(messages.length === 0);

    write(f.worktree, "bg", "background work");
    f.view.send({ type: "refresh" });
    await waitFor(() => groups(f.view)[1].changes === 1);
    const sync = await transition(f.view, { type: "sync", target });
    assert.equal(sync.status, "done");
    assert.equal(readFileSync(path.join(f.root, "bg"), "utf8"), "background work");
    assert.deepEqual(git(f.root, "diff", "--cached", "--name-only").split("\n"), ["bg", "n"]);
    assert.equal(git(f.root, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(groups(f.view)[1].changes, 0);

    const back = await transition(f.view, { type: "gotoDefault", target });
    assert.equal(back.status, "done");
    assert.match(back.lines.join("\n"), /1 commit\(s\) "wip" défait\(s\)/);
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(groups(f.view)[1].state, "owned");
    assert.match(git(f.worktree, "status", "--porcelain"), /\?\? bg/);
    assert.match(git(f.worktree, "status", "--porcelain"), /\?\? n/);
  });

  test("gotoDefault lands current on the default branch, not on the branch it came from", async () => {
    const f = await fixture();
    const target = { path: f.worktree, branch: "feat/x" };
    git(f.root, "switch", "-qc", "feat/elsewhere");
    assert.equal((await transition(f.view, { type: "goto", target })).status, "done");
    const back = await transition(f.view, { type: "gotoDefault", target });
    assert.equal(back.status, "done");
    assert.match(back.lines.join("\n"), /git switch main/);
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(git(f.worktree, "branch", "--show-current"), "feat/x");
  });

  test("a refused goto ends in error, shows it and leaves git untouched", async () => {
    const f = await fixture();
    write(f.root, "g", "conflict on current");
    const result = await transition(f.view, { type: "goto", target: { path: f.worktree, branch: "feat/x" } });
    assert.equal(result.status, "error");
    assert.match(result.lines.at(-1) as string, /overwritten/);
    assert.equal(messages[0]?.kind, "error");
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(groups(f.view)[1].state, "owned");
  });

  test("a merged worktree is flagged", async () => {
    const f = await fixture();
    git(f.root, "merge", "-q", "--no-ff", "-m", "merge", "feat/x");
    f.view.send({ type: "refresh" });
    await waitFor(() => groups(f.view)[1].merged);
  });
});

describe("WorktreesView refresh", () => {
  beforeEach(() => reset());

  test("unchanged data is not re-posted unless forced", async () => {
    const root = initRepo();
    state.workspaceFolders = [root];
    process.env.CLAUDE_CONFIG_DIR = tempDir("cfg");
    const view = new WorktreesView({ fsPath: "/media" } as never, running);
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
    const view = new WorktreesView({ fsPath: "/media" } as never, running);
    const fake = new FakeWebviewView();
    view.resolveWebviewView(fake as never);
    fake.show(true);
    await waitFor(() => fake.last("data") !== undefined);
  });
});

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { before, describe, test } from "node:test";
import { listRepoSessions, listSessions, liveSessions, mirrorTranscripts, projectDir, scanWorktreeEntries, type ScanState, type Session } from "../src/claude";
import { enterWorktreeLine, projectDirOf, tempDir, userLine, writeTranscript } from "./helpers";

const main = "/work/main";
const worktree = "/work/main/.claude/worktrees/feat-x";
let configDir: string;

before(() => {
  configDir = tempDir("claude");
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

describe("projectDir", () => {
  const cases = [
    { name: "slashes become dashes", cwd: "/home/u/proj", want: "-home-u-proj" },
    { name: "dots and underscores become dashes too", cwd: "/a/b.c_d", want: "-a-b-c-d" },
  ];
  for (const tc of cases) test(tc.name, () => assert.equal(projectDir(tc.cwd), path.join(configDir, "projects", tc.want)));
});

describe("listSessions reads one transcript", () => {
  const cases: { name: string; lines: unknown[] | string; want?: Partial<Session>; titleStartsWith?: string; skipped?: boolean }[] = [
    {
      name: "custom title wins over everything",
      lines: [userLine(main, "hello"), { type: "ai-title", aiTitle: "AI" }, { type: "custom-title", customTitle: "Custom" }, { type: "last-prompt", lastPrompt: "later" }],
      want: { title: "Custom", cwd: main, branch: "main" },
    },
    {
      name: "ai title wins over last prompt",
      lines: [userLine(main, "hello"), { type: "last-prompt", lastPrompt: "later" }, { type: "ai-title", aiTitle: "AI" }],
      want: { title: "AI" },
    },
    {
      name: "last prompt wins over first prompt",
      lines: [userLine(main, "hello"), { type: "last-prompt", lastPrompt: "later" }],
      want: { title: "later" },
    },
    {
      name: "first prompt strips tags",
      lines: [userLine(main, "<command-name>/x</command-name> real prompt")],
      titleStartsWith: "/x",
    },
    {
      name: "first prompt is truncated to 80 chars",
      lines: [userLine(main, "a".repeat(200))],
      want: { title: "a".repeat(80) },
    },
    {
      name: "array content uses its first text block",
      lines: [userLine(main, [{ type: "tool_result", content: "x" }, { type: "text", text: "from array" }])],
      want: { title: "from array" },
    },
    {
      name: "later message cwd wins",
      lines: [userLine(main, "a"), userLine(worktree, "b")],
      want: { cwd: worktree },
    },
    {
      name: "a relocation to the window's project does not move a worktree session",
      lines: [userLine(worktree, "a"), { type: "relocated", relocatedCwd: main }],
      want: { cwd: worktree },
    },
    {
      name: "a relocation is used when the tail has no message cwd",
      lines: [userLine(main, "first"), ...Array.from({ length: 2000 }, () => ({ type: "summary", summary: "x".repeat(100) })), { type: "relocated", relocatedCwd: worktree }],
      want: { cwd: worktree },
    },
    {
      name: "message after a relocation wins",
      lines: [userLine(main, "a"), { type: "relocated", relocatedCwd: worktree }, userLine(main, "b")],
      want: { cwd: main },
    },
    {
      name: "escaped characters are decoded",
      lines: [userLine("/work/dir with \"quotes\"", "a")],
      want: { cwd: "/work/dir with \"quotes\"" },
    },
    {
      name: "last branch wins",
      lines: [userLine(main, "a", { gitBranch: "main" }), userLine(main, "b", { gitBranch: "feat/x" })],
      want: { branch: "feat/x" },
    },
    {
      name: "sidechain transcript is skipped",
      lines: [userLine(main, "a", { isSidechain: true })],
      skipped: true,
    },
    {
      name: "transcript without user message is skipped",
      lines: [{ type: "ai-title", aiTitle: "x" }],
      skipped: true,
    },
    {
      name: "tool result only user messages are skipped",
      lines: [userLine(main, [{ type: "tool_result", content: "x" }])],
      skipped: true,
    },
    {
      name: "malformed lines are ignored",
      lines: '{"type":"user" broken\n' + JSON.stringify(userLine(main, "ok")) + "\n",
      want: { title: "ok" },
    },
    {
      name: "big transcript reads the head and the tail",
      lines: [userLine(main, "first"), ...Array.from({ length: 2000 }, () => userLine(main, "x".repeat(100))), userLine(worktree, "last", { gitBranch: "feat/x" }), { type: "ai-title", aiTitle: "Big" }],
      want: { title: "Big", cwd: worktree, branch: "feat/x" },
    },
  ];
  for (const [index, tc] of cases.entries()) {
    test(tc.name, async () => {
      const cwd = `/case/${index}`;
      const file = writeTranscript(configDir, cwd, `id-${index}`, tc.lines);
      const sessions = await listSessions([cwd]);
      if (tc.skipped) {
        assert.equal(sessions.length, 0);
        return;
      }
      assert.equal(sessions.length, 1);
      const session = sessions[0];
      assert.equal(session.id, `id-${index}`);
      assert.equal(session.file, file);
      assert.equal(session.modified, statSync(file).mtimeMs);
      if (tc.titleStartsWith !== undefined) assert.ok(session.title.startsWith(tc.titleStartsWith), session.title);
      for (const [key, value] of Object.entries(tc.want ?? {})) assert.equal(session[key as keyof Session], value, key);
    });
  }
});

describe("listSessions over a project", () => {
  test("missing project dir yields no session", async () => {
    assert.deepEqual(await listSessions(["/nowhere/at/all"]), []);
  });

  test("sessions are sorted by modification time, newest first", async () => {
    const cwd = "/sorted";
    const older = writeTranscript(configDir, cwd, "older", [userLine(cwd, "old")]);
    writeTranscript(configDir, cwd, "newer", [userLine(cwd, "new")]);
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.deepEqual((await listSessions([cwd])).map((session) => session.id), ["newer", "older"]);
  });

  test("duplicate cwds are scanned once", async () => {
    const cwd = "/dup";
    writeTranscript(configDir, cwd, "one", [userLine(cwd, "x")]);
    assert.equal((await listSessions([cwd, cwd])).length, 1);
  });

  test("a session filed in two project dirs is listed once, newest copy first", async () => {
    const older = writeTranscript(configDir, "/twice/a", "same", [userLine("/twice/a", "old copy")]);
    writeTranscript(configDir, "/twice/b", "same", [userLine("/twice/b", "new copy")]);
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const sessions = await listSessions(["/twice/a", "/twice/b"]);
    assert.deepEqual(sessions.map((session) => [session.id, session.title]), [["same", "new copy"]]);
  });

  test("superseded copies left by Claude Code are ignored", async () => {
    const file = writeTranscript(configDir, "/superseded", "kept", [userLine("/superseded", "x")]);
    writeFileSync(`${file}.superseded-1790690992768`, JSON.stringify(userLine("/superseded", "stale")) + "\n");
    assert.deepEqual((await listSessions(["/superseded"])).map((session) => session.title), ["x"]);
  });

  test("a transcript is re-read only when its mtime changes", async () => {
    const cwd = "/cached";
    const file = writeTranscript(configDir, cwd, "c", [userLine(cwd, "v1")]);
    const first = (await listSessions([cwd]))[0];
    const second = (await listSessions([cwd]))[0];
    assert.equal(second, first);
    writeFileSync(file, JSON.stringify(userLine(cwd, "v2")) + "\n");
    utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    assert.equal((await listSessions([cwd]))[0].title, "v2");
  });
});

describe("resumeCwd", () => {
  const cases = [
    { name: "the last relocation decides where Claude Code resumes", lines: [userLine(worktree, "a"), { type: "relocated", relocatedCwd: main }, userLine(worktree, "b")], want: main },
    { name: "without relocation it resumes in the first cwd", lines: [userLine(main, "a"), userLine(worktree, "b")], want: main },
  ];
  for (const [index, tc] of cases.entries()) {
    test(tc.name, async () => {
      const cwd = `/resume/${index}`;
      writeTranscript(configDir, cwd, `r-${index}`, tc.lines);
      assert.equal((await listSessions([cwd]))[0].resumeCwd, tc.want);
    });
  }
});

describe("listRepoSessions", () => {
  test("reads the main project, its subdirectories and its worktrees, not other repos", async () => {
    const root = "/repo/app";
    writeTranscript(configDir, root, "in-main", [userLine(root, "x")]);
    writeTranscript(configDir, `${root}/frontend`, "in-subdir", [userLine(root, "x")]);
    writeTranscript(configDir, `${root}/.claude/worktrees/feat-x`, "in-worktree", [userLine(root, "x")]);
    writeTranscript(configDir, "/repo/apple", "other-repo", [userLine("/repo/apple", "x")]);
    assert.deepEqual((await listRepoSessions(root)).map((session) => session.id).sort(), ["in-main", "in-subdir", "in-worktree"]);
  });

  test("a missing projects dir yields nothing", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/nowhere/config";
    assert.deepEqual(await listRepoSessions("/repo/app"), []);
    process.env.CLAUDE_CONFIG_DIR = saved;
  });
});

describe("scanWorktreeEntries", () => {
  const root = "/scan/repo";
  const worktreeX = `${root}/.claude/worktrees/feat-x`;
  const worktreeY = `${root}/.claude/worktrees/feat-y`;
  const cases: { name: string; lines: unknown[]; want: string | undefined }[] = [
    { name: "an EnterWorktree call by path binds the session", lines: [userLine(root, "a"), enterWorktreeLine({ path: worktreeX })], want: worktreeX },
    { name: "an EnterWorktree call by name binds to .claude/worktrees/<name>", lines: [userLine(root, "a"), enterWorktreeLine({ name: "feat-y" })], want: worktreeY },
    { name: "the last EnterWorktree call wins", lines: [userLine(root, "a"), enterWorktreeLine({ path: worktreeX }), enterWorktreeLine({ path: worktreeY })], want: worktreeY },
    { name: "working in a worktree without EnterWorktree does not bind", lines: [userLine(worktreeX, "a")], want: undefined },
    { name: "EnterWorktree quoted inside a message does not bind", lines: [userLine(root, 'I ran "name":"EnterWorktree","input":{"path":"/x"}')], want: undefined },
  ];
  for (const [index, tc] of cases.entries()) {
    test(tc.name, async () => {
      const cwd = `/scan/case-${index}`;
      writeTranscript(configDir, cwd, `s-${index}`, tc.lines);
      const state: ScanState = { offsets: {}, bindings: {} };
      await scanWorktreeEntries(await listSessions([cwd]), root, state);
      assert.equal(state.bindings[`s-${index}`], tc.want);
    });
  }

  test("only the appended part is read, and a binding survives later lines", async () => {
    const cwd = "/scan/incremental";
    const file = writeTranscript(configDir, cwd, "inc", [userLine(root, "a"), enterWorktreeLine({ path: worktreeX })]);
    const state: ScanState = { offsets: {}, bindings: {} };
    assert.equal(await scanWorktreeEntries(await listSessions([cwd]), root, state), true);
    const firstOffset = state.offsets[file];
    assert.equal(firstOffset, statSync(file).size);
    assert.equal(await scanWorktreeEntries(await listSessions([cwd]), root, state), false);
    appendFileSync(file, JSON.stringify(userLine(root, "later, back in the main checkout")) + "\n");
    utimesSync(file, new Date(2031, 0, 1), new Date(2031, 0, 1));
    assert.equal(await scanWorktreeEntries(await listSessions([cwd]), root, state), true);
    assert.ok(state.offsets[file] > firstOffset);
    assert.equal(state.bindings.inc, worktreeX);
  });

  test("a line still being written is left for the next scan", async () => {
    const cwd = "/scan/partial";
    const file = writeTranscript(configDir, cwd, "part", [userLine(root, "a")]);
    appendFileSync(file, JSON.stringify(enterWorktreeLine({ path: worktreeX })).slice(0, 40));
    const state: ScanState = { offsets: {}, bindings: {} };
    await scanWorktreeEntries(await listSessions([cwd]), root, state);
    assert.equal(state.bindings.part, undefined);
    appendFileSync(file, JSON.stringify(enterWorktreeLine({ path: worktreeX })).slice(40) + "\n");
    utimesSync(file, new Date(2031, 0, 2), new Date(2031, 0, 2));
    await scanWorktreeEntries(await listSessions([cwd]), root, state);
    assert.equal(state.bindings.part, worktreeX);
  });

  test("a rewritten, shorter file is scanned again from the start", async () => {
    const cwd = "/scan/rewritten";
    const file = writeTranscript(configDir, cwd, "rw", [userLine(root, "x".repeat(500))]);
    const state: ScanState = { offsets: {}, bindings: {} };
    await scanWorktreeEntries(await listSessions([cwd]), root, state);
    writeFileSync(file, [userLine(root, "a"), enterWorktreeLine({ path: worktreeY })].map((line) => JSON.stringify(line)).join("\n") + "\n");
    utimesSync(file, new Date(2031, 0, 3), new Date(2031, 0, 3));
    await scanWorktreeEntries(await listSessions([cwd]), root, state);
    assert.equal(state.bindings.rw, worktreeY);
  });
});

describe("liveSessions", () => {
  test("keeps the sessions whose process is alive, with their cwd", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir("live");
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "alive", cwd: "/work/here" }));
    writeFileSync(path.join(dir, "999999999.json"), JSON.stringify({ pid: 999999999, sessionId: "dead", cwd: "/work/gone" }));
    writeFileSync(path.join(dir, "broken.json"), "{oops");
    writeFileSync(path.join(dir, "1.key"), "not a session");
    assert.deepEqual([...(await liveSessions()).entries()], [["alive", "/work/here"]]);
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  test("no sessions dir means no live session", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/nowhere/config";
    assert.equal((await liveSessions()).size, 0);
    process.env.CLAUDE_CONFIG_DIR = saved;
  });
});

describe("mirrorTranscripts", () => {
  const cases = [
    { name: "links a worktree transcript into the workspace project dir", prepare: () => undefined, wantLinked: 1, sameInode: true },
    { name: "is idempotent", prepare: (root: string, file: string) => mirrorTranscripts([fake(file, root)], root), wantLinked: 0, sameInode: true },
    { name: "keeps an unrelated file with the same name", prepare: (root: string, file: string) => { mkdirSync(projectDirOf(configDir, root), { recursive: true }); writeFileSync(path.join(projectDirOf(configDir, root), path.basename(file)), "other"); }, wantLinked: 0, sameInode: false },
    { name: "ignores a transcript already in the workspace project dir", prepare: undefined, own: true, wantLinked: 0, sameInode: true },
  ];
  for (const [index, tc] of cases.entries()) {
    test(tc.name, async () => {
      const root = `/mirror/${index}`;
      const source = tc.own ? root : `${root}/.claude/worktrees/feat-x`;
      const file = writeTranscript(configDir, source, "m", [userLine(source, "x")]);
      await tc.prepare?.(root, file);
      assert.equal(await mirrorTranscripts([fake(file, root)], root), tc.wantLinked);
      const mirror = path.join(projectDirOf(configDir, root), "m.jsonl");
      assert.ok(existsSync(mirror));
      assert.equal(statSync(mirror).ino === statSync(file).ino, tc.sameInode);
    });
  }
});

function fake(file: string, cwd: string): Session {
  return { id: "m", file, size: 0, title: "t", cwd, resumeCwd: cwd, branch: "main", modified: 0 };
}

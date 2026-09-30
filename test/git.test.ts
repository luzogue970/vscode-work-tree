import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { behindCount, countChanges, defaultBranch, gitCommonDir, gitError, isMerged, listBranches, listWorktrees, mergeTarget, moveCurrent, park, restorePark, snapshot, syncToMain, unwindSnapshots } from "../src/git";
import { addWorktree, branchWithCommit, git, initRepo, tempDir, write } from "./helpers";

const quiet = () => undefined;

describe("listWorktrees", () => {
  const cases = [
    { name: "main checkout only", setup: (root: string) => undefined, want: (root: string) => [{ path: root, branch: "main", main: true }] },
    { name: "main plus a branch worktree", setup: (root: string) => { branchWithCommit(root, "feat/x", "g", "x"); addWorktree(root, "feat/x"); }, want: (root: string) => [{ path: root, branch: "main", main: true }, { path: path.join(root, ".claude/worktrees/feat-x"), branch: "feat/x", main: false }] },
    { name: "detached worktree has no branch", setup: (root: string) => { branchWithCommit(root, "feat/d", "g", "d"); addWorktree(root, "feat/d", true); }, want: (root: string) => [{ path: root, branch: "main", main: true }, { path: path.join(root, ".claude/worktrees/feat-d"), branch: undefined, main: false }] },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      tc.setup(root);
      assert.deepEqual(await listWorktrees(root), tc.want(root));
    });
  }
});

describe("repository facts", () => {
  test("gitCommonDir is the main .git from both checkouts", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "g", "x");
    const worktree = addWorktree(root, "feat/x");
    assert.equal(await gitCommonDir(root), path.join(root, ".git"));
    assert.equal(await gitCommonDir(worktree), path.join(root, ".git"));
  });

  test("gitCommonDir rejects a non repository", async () => {
    await assert.rejects(gitCommonDir(tempDir("plain")));
  });

  test("listBranches lists local branches", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "g", "x");
    assert.deepEqual((await listBranches(root)).sort(), ["feat/x", "main"]);
  });

  const defaults = [
    { name: "without origin/HEAD the default is main", remote: false, want: "main", target: "main" },
    { name: "with origin/HEAD the target is the remote branch", remote: true, want: "main", target: "origin/main" },
  ];
  for (const tc of defaults) {
    test(tc.name, async () => {
      const root = initRepo();
      if (tc.remote) {
        const remote = tempDir("remote");
        git(remote, "init", "-q", "--bare");
        git(root, "remote", "add", "origin", remote);
        git(root, "push", "-qu", "origin", "main");
        git(root, "remote", "set-head", "origin", "main");
      }
      assert.equal(await defaultBranch(root), tc.want);
      assert.equal(await mergeTarget(root), tc.target);
    });
  }
});

describe("isMerged", () => {
  const cases = [
    { name: "merge commit", branch: "feat/merged", want: true },
    { name: "fast-forwarded branch stays active", branch: "feat/ff", want: false },
    { name: "fresh branch on main tip", branch: "feat/fresh", want: false },
    { name: "open branch", branch: "feat/open", want: false },
    { name: "stale branch on an old main commit", branch: "feat/stale", want: false },
    { name: "upstream gone after fetch --prune", branch: "feat/squashed", want: true },
    { name: "unknown branch", branch: "nope", want: false },
  ];
  test("table", async (t) => {
    const root = initRepo();
    const remote = tempDir("remote");
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "switch", "-qc", "feat/stale");
    git(root, "switch", "-q", "main");
    branchWithCommit(root, "feat/merged", "g", "m");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "feat/merged");
    branchWithCommit(root, "feat/ff", "h", "f");
    git(root, "merge", "-q", "--ff-only", "feat/ff");
    git(root, "switch", "-qc", "feat/fresh");
    git(root, "switch", "-q", "main");
    branchWithCommit(root, "feat/open", "i", "o");
    branchWithCommit(root, "feat/squashed", "j", "s");
    git(root, "push", "-qu", "origin", "feat/squashed");
    git(root, "push", "-q", "origin", "--delete", "feat/squashed");
    git(root, "fetch", "-qp");
    const target = await mergeTarget(root);
    for (const tc of cases) await t.test(tc.name, async () => assert.equal(await isMerged(root, tc.branch, target), tc.want));
  });
});

describe("countChanges", () => {
  const cases = [
    { name: "clean tree", change: () => undefined, want: 0 },
    { name: "modified file", change: (root: string) => write(root, "f", "changed"), want: 1 },
    { name: "untracked files count one by one", change: (root: string) => { write(root, "n1", "a"); write(root, "dir/n2", "b"); }, want: 2 },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      tc.change(root);
      assert.equal(await countChanges(root), tc.want);
    });
  }
});

describe("snapshot and unwindSnapshots", () => {
  const cases = [
    { name: "nothing to commit", change: () => undefined, untracked: true, saved: false, files: [] as string[] },
    { name: "tracked change with untracked files included", change: (root: string) => { write(root, "f", "x"); write(root, "n", "y"); }, untracked: true, saved: true, files: ["f", "n"] },
    { name: "tracked only leaves untracked files behind", change: (root: string) => { write(root, "f", "x"); write(root, "n", "y"); }, untracked: false, saved: true, files: ["f"] },
    { name: "untracked only without inclusion is nothing", change: (root: string) => write(root, "n", "y"), untracked: false, saved: false, files: [] },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      tc.change(root);
      assert.equal(await snapshot(root, "label", tc.untracked), tc.saved);
      if (!tc.saved) return;
      assert.equal(git(root, "log", "-1", "--format=%s"), "wip");
      assert.match(git(root, "log", "-1", "--format=%b"), /Worktree-Hub-Snapshot: label/);
      assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), tc.files);
    });
  }

  const unwinds = [
    { name: "no snapshot at the tip", snapshots: 0, userCommitOnTop: false, want: 0 },
    { name: "one snapshot", snapshots: 1, userCommitOnTop: false, want: 1 },
    { name: "two consecutive snapshots", snapshots: 2, userCommitOnTop: false, want: 2 },
    { name: "a user commit on top protects the snapshot", snapshots: 1, userCommitOnTop: true, want: 0 },
  ];
  for (const tc of unwinds) {
    test(tc.name, async () => {
      const root = initRepo();
      for (let index = 0; index < tc.snapshots; index++) {
        write(root, `s${index}`, "x");
        await snapshot(root, "t", true);
      }
      if (tc.userCommitOnTop) {
        write(root, "u", "x");
        git(root, "add", "u");
        git(root, "commit", "-qm", "user commit");
      }
      const before = git(root, "rev-list", "--count", "HEAD");
      assert.equal(await unwindSnapshots(root), tc.want);
      assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), Number(before) - tc.want);
      if (tc.want > 0) assert.match(git(root, "status", "--porcelain"), /\?\? s0/);
    });
  }
});

function staged(root: string): string[] {
  return git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
}

function status(cwd: string): string {
  return git(cwd, "status", "--porcelain", "--untracked-files=all");
}

function setupTaken(): { root: string; worktree: string } {
  const root = initRepo();
  branchWithCommit(root, "feat/x", "g", "x");
  const worktree = addWorktree(root, "feat/x");
  return { root, worktree };
}

function setupTwo(): { root: string; x: string; y: string } {
  const root = initRepo();
  branchWithCommit(root, "feat/x", "g", "x");
  branchWithCommit(root, "feat/y", "h", "y");
  return { root, x: addWorktree(root, "feat/x"), y: addWorktree(root, "feat/y") };
}

describe("moveCurrent from main to a worktree", () => {
  test("the worktree's work lands staged on current, with no commit on the branch", async () => {
    const { root, worktree } = setupTaken();
    const tip = git(root, "rev-parse", "feat/x");
    write(worktree, "g", "edited");
    write(worktree, "new", "n");
    const lines: string[] = [];
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, (line) => lines.push(line));
    assert.equal(git(root, "branch", "--show-current"), "feat/x");
    assert.equal(git(root, "rev-parse", "feat/x"), tip);
    assert.deepEqual(staged(root), ["g", "new"]);
    assert.equal(git(root, "diff", "--name-only"), "");
    assert.equal(git(worktree, "branch", "--show-current"), "");
    assert.equal(status(worktree), "");
    assert.match(lines.join("\n"), /git switch feat\/x[\s\S]*staged/);
  });

  test("main's uncommitted work is parked, then restored as it was on the way back", async () => {
    const { root, worktree } = setupTaken();
    write(root, "f", "main edit");
    git(root, "add", "f");
    write(root, "scratch", "untracked on main");
    const lines: string[] = [];
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, (line) => lines.push(line));
    assert.match(lines.join("\n"), /garé/);
    assert.equal(status(root), "");
    await moveCurrent(root, { branch: "feat/x", worktree }, { branch: "main" }, (line) => lines.push(line));
    assert.match(lines.join("\n"), /restauré/);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.deepEqual(staged(root), ["f"]);
    assert.match(status(root), /\?\? scratch/);
    assert.equal(git(root, "stash", "list"), "");
  });

  test("a refused switch rolls everything back, parked work included", async () => {
    const { root, worktree } = setupTaken();
    write(root, "f", "main edit");
    write(root, "scratch", "untracked on main");
    write(worktree, "n", "n");
    await assert.rejects(moveCurrent(root, { branch: "main" }, { branch: "does-not-exist" }, quiet));
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.match(status(root), /M f/);
    assert.match(status(root), /\?\? scratch/);
    assert.equal(git(root, "stash", "list"), "");
    assert.equal(git(worktree, "branch", "--show-current"), "feat/x");
    assert.match(status(worktree), /\?\? n/);
  });

  test("a refused switch into a worktree branch gives the worktree its branch and work back", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "f", "x");
    const worktree = addWorktree(root, "feat/x");
    write(worktree, "n", "n");
    await assert.rejects(moveCurrent(root, { branch: "main", worktree: "/nowhere" }, { branch: "feat/x", worktree }, quiet));
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(worktree, "branch", "--show-current"), "feat/x");
    assert.match(status(worktree), /\?\? n/);
  });

  test("moving to the branch current already holds does nothing", async () => {
    const { root } = setupTaken();
    const lines: string[] = [];
    await moveCurrent(root, { branch: "main" }, { branch: "main" }, (line) => lines.push(line));
    assert.deepEqual(lines, []);
  });
});

describe("moveCurrent between two worktrees", () => {
  test("Aller swaps: current's branch goes back to its worktree with current's work, the target comes in staged", async () => {
    const { root, x, y } = setupTwo();
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree: x }, quiet);
    write(root, "made-on-current", "c");
    write(x, "pending-in-x", "p");
    write(y, "y-work", "w");
    const lines: string[] = [];
    await moveCurrent(root, { branch: "feat/x", worktree: x }, { branch: "feat/y", worktree: y }, (line) => lines.push(line));
    assert.equal(git(root, "branch", "--show-current"), "feat/y");
    assert.deepEqual(staged(root), ["y-work"]);
    assert.equal(git(root, "log", "-1", "--format=%s"), "commit on feat/y");
    assert.equal(git(x, "branch", "--show-current"), "feat/x");
    assert.equal(git(x, "log", "-1", "--format=%s"), "commit on feat/x");
    const xStatus = status(x);
    for (const file of ["made-on-current", "pending-in-x"]) assert.match(xStatus, new RegExp(`\\?\\? ${file}`));
    assert.equal(git(y, "branch", "--show-current"), "");
    assert.match(lines.join("\n"), /feat-x reprend feat\/x/);
  });

  test("a conflict between the returning worktree and current stops before anything moves", async () => {
    const { root, x, y } = setupTwo();
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree: x }, quiet);
    write(root, "g", "edited on current");
    write(x, "g", "edited in the worktree");
    await assert.rejects(moveCurrent(root, { branch: "feat/x", worktree: x }, { branch: "feat/y", worktree: y }, quiet));
    assert.equal(git(root, "branch", "--show-current"), "feat/x");
    assert.equal(readFileSync(path.join(root, "g"), "utf8"), "edited on current");
    assert.equal(git(y, "branch", "--show-current"), "feat/y");
  });

  test("Aller sur main gives the branch back with every piece of work uncommitted", async () => {
    const { root, worktree } = setupTaken();
    write(worktree, "g", "edited");
    write(worktree, "new", "n");
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, quiet);
    write(root, "c", "made on current");
    git(root, "add", "c");
    write(worktree, "pending", "not synced yet");
    const lines: string[] = [];
    await moveCurrent(root, { branch: "feat/x", worktree }, { branch: "main" }, (line) => lines.push(line));
    assert.match(lines.join("\n"), /1 fichier\(s\)[\s\S]*git switch main[\s\S]*feat-x reprend feat\/x/);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(status(root), "");
    assert.equal(git(worktree, "branch", "--show-current"), "feat/x");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(readFileSync(path.join(worktree, "g"), "utf8"), "edited");
    const worktreeStatus = status(worktree);
    for (const file of ["c", "new", "pending"]) assert.match(worktreeStatus, new RegExp(`\\?\\? ${file}`));
    assert.match(worktreeStatus, /M g/);
  });

  test("current keeps the branch and its work when the switch to main is refused", async () => {
    const { root, worktree } = setupTaken();
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, quiet);
    write(root, "g", "edited on current");
    write(root, "blocker", "untracked on current");
    await assert.rejects(moveCurrent(root, { branch: "feat/x", worktree }, { branch: "does-not-exist" }, quiet), (error: unknown) => /does-not-exist/.test(gitError(error)));
    assert.equal(git(root, "branch", "--show-current"), "feat/x");
    assert.equal(git(root, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(readFileSync(path.join(root, "g"), "utf8"), "edited on current");
    assert.deepEqual(staged(root), ["blocker", "g"]);
  });
});

describe("syncToMain", () => {
  const cases = [
    { name: "nothing new", work: (_root: string, _worktree: string) => undefined, want: false, wantStaged: [] as string[], log: /Rien de nouveau/ },
    { name: "new and modified files arrive staged", work: (_root: string, worktree: string) => { write(worktree, "g", "bg edit"); write(worktree, "bg", "background"); }, want: true, wantStaged: ["bg", "g"], log: /2 fichier\(s\)[\s\S]*staged/ },
    { name: "a deletion arrives staged", work: (_root: string, worktree: string) => git(worktree, "rm", "-q", "g"), want: true, wantStaged: ["g"], log: /1 fichier\(s\)/ },
    { name: "it applies after current committed its staged work", work: (root: string, worktree: string) => { git(root, "commit", "-qm", "user commit"); write(worktree, "later", "l"); }, want: true, wantStaged: ["later"], log: /1 fichier\(s\)/ },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const { root, worktree } = setupTaken();
      write(worktree, "first", "from aller");
      await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, quiet);
      const branchTip = git(root, "rev-parse", "feat/x");
      const before = staged(root);
      tc.work(root, worktree);
      const committedByUser = git(root, "rev-parse", "feat/x") !== branchTip;
      const lines: string[] = [];
      assert.equal(await syncToMain(root, worktree, (line) => lines.push(line)), tc.want);
      assert.match(lines.join("\n"), tc.log);
      assert.deepEqual(staged(root), committedByUser ? tc.wantStaged : [...new Set([...before, ...tc.wantStaged])].sort());
      assert.equal(git(root, "log", "-1", "--format=%s", "feat/x"), committedByUser ? "user commit" : "commit on feat/x");
      assert.equal(status(worktree), "");
      assert.equal(git(worktree, "branch", "--show-current"), "");
    });
  }

  test("a second sync only transfers what changed since the first", async () => {
    const { root, worktree } = setupTaken();
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, quiet);
    write(worktree, "a", "1");
    await syncToMain(root, worktree, quiet);
    write(worktree, "a", "2");
    write(worktree, "b", "1");
    const lines: string[] = [];
    await syncToMain(root, worktree, (line) => lines.push(line));
    assert.match(lines.join("\n"), /2 fichier\(s\)/);
    assert.equal(readFileSync(path.join(root, "a"), "utf8"), "2");
    assert.deepEqual(staged(root), ["a", "b"]);
  });

  test("a conflict with an unstaged edit on current is refused and changes nothing", async () => {
    const { root, worktree } = setupTaken();
    await moveCurrent(root, { branch: "main" }, { branch: "feat/x", worktree }, quiet);
    write(root, "g", "edited on current");
    write(worktree, "g", "edited in worktree");
    await assert.rejects(syncToMain(root, worktree, quiet));
    assert.equal(readFileSync(path.join(root, "g"), "utf8"), "edited on current");
    assert.deepEqual(staged(root), []);
    assert.equal(status(worktree), "M g");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "commit on feat/x");
  });
});

describe("park and restorePark", () => {
  const cases = [
    { name: "a clean tree parks nothing", dirty: false, other: false, wantParked: false, wantRestored: false },
    { name: "a dirty tree is parked and restored", dirty: true, other: false, wantParked: true, wantRestored: true },
    { name: "another branch's park is left alone", dirty: true, other: true, wantParked: true, wantRestored: false },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      if (tc.dirty) write(root, "f", "dirty");
      assert.equal(await park(root, tc.other ? "someone-else" : "main"), tc.wantParked);
      assert.equal(await restorePark(root, "main"), tc.wantRestored);
      assert.equal(git(root, "stash", "list").split("\n").filter(Boolean).length, tc.other ? 1 : 0);
    });
  }
});

describe("behindCount", () => {
  const cases = [
    { name: "up to date", advance: 0, want: 0 },
    { name: "two commits behind", advance: 2, want: 2 },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      git(root, "branch", "feat/x");
      for (let index = 0; index < tc.advance; index++) {
        write(root, `m${index}`, "x");
        git(root, "add", `m${index}`);
        git(root, "commit", "-qm", `main ${index}`);
      }
      assert.equal(await behindCount(root, "feat/x", "main"), tc.want);
    });
  }
  test("an unknown branch counts zero", async () => {
    assert.equal(await behindCount(initRepo(), "nope", "main"), 0);
  });
});

describe("gitError", () => {
  const cases = [
    { name: "prefers git stderr", error: Object.assign(new Error("x"), { stderr: "  fatal: bad\n" }), want: "fatal: bad" },
    { name: "falls back to the error text", error: new Error("plain"), want: "Error: plain" },
    { name: "empty stderr falls back too", error: Object.assign(new Error("e"), { stderr: "" }), want: "Error: e" },
  ];
  for (const tc of cases) test(tc.name, () => assert.equal(gitError(tc.error), tc.want));
});

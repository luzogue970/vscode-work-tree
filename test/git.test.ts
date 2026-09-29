import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { countChanges, defaultBranch, gitCommonDir, gitError, isMerged, listBranches, listWorktrees, mergeTarget, moveBranchToMain, moveBranchToWorktree, snapshot, syncToMain, unwindSnapshots } from "../src/git";
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

describe("moveBranchToMain and moveBranchToWorktree", () => {
  test("round trip keeps the work uncommitted on the worktree side", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "g", "x");
    const worktree = addWorktree(root, "feat/x");
    write(worktree, "g", "edited");
    write(worktree, "new", "n");
    const lines: string[] = [];
    assert.equal(await moveBranchToMain(root, worktree, "feat/x", (line) => lines.push(line)), true);
    assert.equal(git(root, "branch", "--show-current"), "feat/x");
    assert.equal(git(worktree, "branch", "--show-current"), "");
    assert.equal(readFileSync(path.join(root, "new"), "utf8"), "n");
    assert.equal(git(root, "log", "-1", "--format=%s"), "wip");
    assert.ok(lines.some((line) => line.includes("git switch feat/x")));
    write(root, "g", "edited by current");
    assert.equal(await moveBranchToWorktree(root, worktree, "feat/x", "main", quiet), 2);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(worktree, "branch", "--show-current"), "feat/x");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.equal(readFileSync(path.join(worktree, "g"), "utf8"), "edited by current");
    assert.match(git(worktree, "status", "--porcelain"), /\?\? new/);
  });

  test("a refused switch rolls the worktree back to its branch without a snapshot", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "f", "x");
    const worktree = addWorktree(root, "feat/x");
    write(worktree, "n", "n");
    write(root, "f", "conflicting local change");
    await assert.rejects(moveBranchToMain(root, worktree, "feat/x", quiet), (error: unknown) => /overwritten/.test(gitError(error)));
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(worktree, "branch", "--show-current"), "feat/x");
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "commit on feat/x");
    assert.match(git(worktree, "status", "--porcelain"), /\?\? n/);
  });

  test("nothing to snapshot reports false and zero", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "g", "x");
    const worktree = addWorktree(root, "feat/x");
    assert.equal(await moveBranchToMain(root, worktree, "feat/x", quiet), false);
    assert.equal(await moveBranchToWorktree(root, worktree, "feat/x", "main", quiet), 0);
  });
});

describe("syncToMain", () => {
  const cases = [
    { name: "nothing new", work: () => undefined, advanceMain: false, want: false, log: /Rien de nouveau/ },
    { name: "fast-forward when current did not move", work: (worktree: string) => write(worktree, "bg", "background"), advanceMain: false, want: true, log: /Avance rapide/ },
    { name: "cherry-pick when current advanced", work: (worktree: string) => write(worktree, "bg", "background"), advanceMain: true, want: true, log: /cherry-pick/ },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = initRepo();
      branchWithCommit(root, "feat/x", "g", "x");
      const worktree = addWorktree(root, "feat/x");
      await moveBranchToMain(root, worktree, "feat/x", quiet);
      tc.work(worktree);
      if (tc.advanceMain) {
        write(root, "own", "current commit");
        git(root, "add", "own");
        git(root, "commit", "-qm", "on current");
      }
      const lines: string[] = [];
      assert.equal(await syncToMain(root, worktree, "feat/x", (line) => lines.push(line)), tc.want);
      assert.match(lines.join("\n"), tc.log);
      if (!tc.want) return;
      assert.equal(readFileSync(path.join(root, "bg"), "utf8"), "background");
      assert.equal(git(worktree, "rev-parse", "HEAD"), git(root, "rev-parse", "feat/x"));
      assert.equal(git(worktree, "branch", "--show-current"), "");
    });
  }

  test("a conflicting cherry-pick is aborted and reported", async () => {
    const root = initRepo();
    branchWithCommit(root, "feat/x", "g", "x");
    const worktree = addWorktree(root, "feat/x");
    await moveBranchToMain(root, worktree, "feat/x", quiet);
    write(worktree, "g", "from worktree");
    write(root, "g", "from current");
    git(root, "commit", "-qam", "current edit");
    await assert.rejects(syncToMain(root, worktree, "feat/x", quiet));
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "log", "-1", "--format=%s"), "current edit");
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

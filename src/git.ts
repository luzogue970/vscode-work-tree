import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string | undefined;
  main: boolean;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { stdout } = await git(cwd, "worktree", "list", "--porcelain");
  return stdout
    .split("\n\n")
    .filter((block) => block.startsWith("worktree "))
    .map((block, index) => {
      const lines = block.split("\n");
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch refs/heads/".length);
      return { path: lines[0].slice("worktree ".length), branch, main: index === 0 };
    });
}

export async function listBranches(cwd: string): Promise<string[]> {
  const { stdout } = await git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  return stdout.split("\n").filter(Boolean);
}

export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return stdout.trim().replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return stdout.trim();
}

const snapshotTrailer = "Worktree-Hub-Snapshot";

export async function snapshot(cwd: string, label: string, includeUntracked: boolean): Promise<boolean> {
  const { stdout } = await git(cwd, "status", "--porcelain", includeUntracked ? "--untracked-files=all" : "--untracked-files=no");
  if (!stdout.trim()) return false;
  await git(cwd, "add", includeUntracked ? "-A" : "-u");
  await commitSnapshot(cwd, label);
  return true;
}

async function commitSnapshot(cwd: string, label: string): Promise<void> {
  await git(cwd, "commit", "-q", "--no-verify", "-m", "wip", "-m", `${snapshotTrailer}: ${label}`);
}

export async function unwindSnapshots(cwd: string): Promise<number> {
  let count = 0;
  while ((await git(cwd, "log", "-1", "--format=%B")).stdout.includes(`\n${snapshotTrailer}:`)) {
    await git(cwd, "reset", "-q", "HEAD~1");
    count++;
  }
  return count;
}

export type Log = (line: string) => void;

export async function moveBranchToMain(main: string, worktree: string, branch: string, log: Log): Promise<boolean> {
  const name = path.basename(worktree);
  log(`Recherche de travail non committé dans ${name}`);
  const saved = await snapshot(worktree, name, true);
  log(saved ? "Travail mis de côté dans un commit wip temporaire" : "Rien à transférer");
  log("Détachement du worktree : git switch --detach");
  await git(worktree, "switch", "--detach");
  log(`Sur current : git switch ${branch}`);
  try {
    await git(main, "switch", branch);
  } catch (error) {
    log(`Refusé par git, retour du worktree sur ${branch}`);
    await git(worktree, "switch", branch);
    await unwindSnapshots(worktree);
    throw error;
  }
  if (saved) {
    await git(main, "reset", "-q", "--soft", "HEAD~1");
    log(`Travail du worktree indexé (staged) sur current, ${branch} reste sur son dernier vrai commit`);
  }
  return saved;
}

export async function moveBranchToWorktree(main: string, worktree: string, branch: string, mainBranch: string, log: Log): Promise<number> {
  await syncToMain(main, worktree, log);
  log("Recherche de modifications sur current");
  const saved = await snapshot(main, "current", false);
  log(saved ? `Modifications de current mises de côté dans un commit wip sur ${branch}` : "Rien à mettre de côté sur current");
  log(`Sur current : git switch ${mainBranch}`);
  try {
    await git(main, "switch", mainBranch);
  } catch (error) {
    if (saved) await git(main, "reset", "-q", "--soft", "HEAD~1");
    throw error;
  }
  log(`Dans le worktree : git switch ${branch}`);
  await git(worktree, "switch", branch);
  const unwound = await unwindSnapshots(worktree);
  log(unwound > 0 ? `${unwound} commit(s) "wip" défait(s) : git reset HEAD~1, le travail redevient non committé` : `Aucun commit "wip" à défaire`);
  return unwound;
}

export async function mergeTarget(cwd: string): Promise<string> {
  const branch = await defaultBranch(cwd);
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`);
    return `origin/${branch}`;
  } catch {
    return branch;
  }
}

// A tip sitting on the target's first-parent line is a fresh or stale branch, not a merged one.
export async function isMerged(cwd: string, branch: string, target: string): Promise<boolean> {
  const track = (await git(cwd, "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`)).stdout.trim();
  if (track === "[gone]") return true;
  try {
    await git(cwd, "merge-base", "--is-ancestor", branch, target);
  } catch {
    return false;
  }
  const tip = (await git(cwd, "rev-parse", branch)).stdout.trim();
  const firstParents = (await git(cwd, "rev-list", "--first-parent", target)).stdout;
  return !firstParents.includes(tip);
}

export async function countChanges(cwd: string): Promise<number> {
  const { stdout } = await git(cwd, "status", "--porcelain", "--untracked-files=all");
  return stdout.split("\n").filter(Boolean).length;
}

export async function syncToMain(main: string, worktree: string, log: Log): Promise<boolean> {
  const name = path.basename(worktree);
  log(`Recherche de nouvelles modifications dans ${name}`);
  await git(worktree, "add", "-A");
  const files = (await git(worktree, "diff", "--cached", "--name-only")).stdout.split("\n").filter(Boolean);
  if (files.length === 0) {
    log("Rien de nouveau à synchroniser");
    return false;
  }
  log(`${files.length} fichier(s) à amener sur current : git apply --index`);
  try {
    await gitWithInput(main, (await git(worktree, "diff", "--cached", "--binary")).stdout, "apply", "--index");
  } catch (error) {
    await git(worktree, "reset", "-q");
    throw error;
  }
  await commitSnapshot(worktree, `${name} sync`);
  log("Modifications indexées (staged) sur current ; repère posé dans le worktree, hors branche");
  return true;
}

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || String(error);
}

const maxOutput = 512 * 1024 * 1024;

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run("git", args, { cwd, maxBuffer: maxOutput });
}

function gitWithInput(cwd: string, input: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: maxOutput }, (error, _stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve()));
    child.stdin?.end(input);
  });
}

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
  await git(cwd, "commit", "-q", "-m", "wip", "-m", `${snapshotTrailer}: ${label}`);
  return true;
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
  log(saved ? `Commit "wip" créé sur ${branch}` : "Rien à committer");
  log(`Détachement du worktree : git switch --detach`);
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
  return saved;
}

export async function moveBranchToWorktree(main: string, worktree: string, branch: string, mainBranch: string, log: Log): Promise<number> {
  log("Recherche de modifications non committées sur current");
  const saved = await snapshot(main, "current", false);
  log(saved ? `Commit "wip" créé sur ${branch}` : "Rien à committer");
  log(`Sur current : git switch ${mainBranch}`);
  await git(main, "switch", mainBranch);
  log(`Dans le worktree : git switch ${branch}`);
  await git(worktree, "switch", branch);
  const unwound = await unwindSnapshots(worktree);
  log(unwound > 0 ? `${unwound} commit(s) "wip" défait(s) : git reset HEAD~1, le travail redevient non committé` : `Aucun commit "wip" à défaire`);
  return unwound;
}

export async function countChanges(cwd: string): Promise<number> {
  const { stdout } = await git(cwd, "status", "--porcelain", "--untracked-files=all");
  return stdout.split("\n").filter(Boolean).length;
}

export async function syncToMain(main: string, worktree: string, branch: string, log: Log): Promise<boolean> {
  const name = path.basename(worktree);
  log(`Recherche de travail non committé dans ${name}`);
  if (!(await snapshot(worktree, name, true))) {
    log("Rien de nouveau à synchroniser");
    return false;
  }
  const sha = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  log(`Commit "wip" ${sha.slice(0, 7)} créé, intégration sur current`);
  try {
    await git(main, "merge", "--ff-only", sha);
    log(`Avance rapide de ${branch}`);
  } catch {
    log(`Avance rapide impossible (${branch} a avancé sur current), cherry-pick`);
    try {
      await git(main, "cherry-pick", sha);
    } catch (error) {
      await git(main, "cherry-pick", "--abort").catch(() => undefined);
      throw error;
    }
  }
  log(`Le worktree se réaligne sur ${branch} (détaché)`);
  await git(worktree, "switch", "--detach", branch);
  return true;
}

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || String(error);
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run("git", args, { cwd });
}

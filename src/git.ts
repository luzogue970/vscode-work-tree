import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string | undefined;
  main: boolean;
}

export interface Place {
  branch: string;
  worktree?: string;
}

export type Log = (line: string) => void;

const snapshotTrailer = "Worktree-Hub-Snapshot";
const parkPrefix = "worktree-hub:park:";
const maxOutput = 512 * 1024 * 1024;

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

export function worktreeName(branch: string): string {
  return branch.replaceAll("/", "-");
}

export function visitedWorktree(trees: Worktree[]): Worktree | undefined {
  const current = trees[0]?.branch;
  if (current === undefined) return undefined;
  return trees.find((tree) => !tree.main && tree.branch === undefined && path.basename(tree.path) === worktreeName(current));
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

export async function behindCount(cwd: string, branch: string, target: string): Promise<number> {
  try {
    return Number((await git(cwd, "rev-list", "--count", `${branch}..${target}`)).stdout.trim());
  } catch {
    return 0;
  }
}

export async function countChanges(cwd: string): Promise<number> {
  const { stdout } = await git(cwd, "status", "--porcelain", "--untracked-files=all");
  return stdout.split("\n").filter(Boolean).length;
}

export async function snapshot(cwd: string, label: string, includeUntracked: boolean): Promise<boolean> {
  const { stdout } = await git(cwd, "status", "--porcelain", includeUntracked ? "--untracked-files=all" : "--untracked-files=no");
  if (!stdout.trim()) return false;
  await git(cwd, "add", includeUntracked ? "-A" : "-u");
  await commitSnapshot(cwd, label);
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

export async function park(cwd: string, branch: string): Promise<boolean> {
  if ((await countChanges(cwd)) === 0) return false;
  await git(cwd, "stash", "push", "-q", "-u", "-m", `${parkPrefix}${branch}`);
  return true;
}

export async function restorePark(cwd: string, branch: string): Promise<boolean> {
  const entries = (await git(cwd, "stash", "list", "--format=%H %gs")).stdout.split("\n");
  const sha = entries.find((entry) => entry.endsWith(`: ${parkPrefix}${branch}`))?.split(" ")[0];
  if (!sha) return false;
  await git(cwd, "stash", "apply", "-q", "--index", sha);
  const ref = (await git(cwd, "stash", "list", "--format=%gd %H")).stdout.split("\n").find((entry) => entry.endsWith(` ${sha}`))?.split(" ")[0];
  if (ref) await git(cwd, "stash", "drop", "-q", ref);
  return true;
}

export async function syncToMain(main: string, worktree: string, log: Log, keepConflicts = false): Promise<boolean> {
  const name = path.basename(worktree);
  log(`Recherche de nouvelles modifications dans ${name}`);
  await git(worktree, "add", "-A");
  const files = (await git(worktree, "diff", "--cached", "--name-only")).stdout.split("\n").filter(Boolean);
  if (files.length === 0) {
    log("Rien de nouveau à synchroniser");
    return false;
  }
  log(`${files.length} fichier(s) à amener sur current : git apply --3way`);
  let conflicts: string[];
  try {
    const patch = (await git(worktree, "diff", "--cached", "--binary")).stdout;
    conflicts = conflictedPaths(await gitWithInput(main, patch, "apply", "--3way", "--check"));
    if (conflicts.length > 0 && !keepConflicts) throw new Error(`conflit avec current sur ${conflicts.join(", ")} : "Réessayer le rapatriement" l'amène avec ses marqueurs de conflit`);
    await gitWithInput(main, patch, "apply", "--3way").catch((error: { stderr?: string }) => {
      if (conflicts.length === 0 || conflictedPaths(error.stderr ?? "").length === 0) throw error;
    });
  } catch (error) {
    await git(worktree, "reset", "-q");
    throw error;
  }
  await commitSnapshot(worktree, `${name} sync`);
  if (conflicts.length > 0) log(`Conflit(s) laissé(s) sur current, à résoudre : ${conflicts.join(", ")}`);
  else log("Modifications indexées (staged) sur current ; repère posé dans le worktree, hors branche");
  return true;
}

function conflictedPaths(applyOutput: string): string[] {
  return [...applyOutput.matchAll(/^Applied patch to '(.+)' with conflicts\.$/gm)].map((match) => match[1]);
}

export async function moveCurrent(main: string, from: Place, to: Place, log: Log): Promise<void> {
  if (from.branch === to.branch) return;
  const unmerged = (await git(main, "diff", "--name-only", "--diff-filter=U")).stdout.split("\n").filter(Boolean);
  if (unmerged.length > 0) throw new Error(`conflit(s) non résolu(s) sur current (${unmerged.join(", ")}) : rien n'a été déplacé`);
  if (from.worktree) await syncToMain(main, from.worktree, log);
  const fromSaved = from.worktree ? await snapshot(main, "current", true) : false;
  if (fromSaved) log(`Travail de current mis de côté sur ${from.branch} (commit wip temporaire)`);
  const parked = from.worktree ? false : await park(main, from.branch);
  if (parked) log(`Travail non committé de ${from.branch} garé (stash ${parkPrefix}${from.branch})`);
  const toSaved = to.worktree ? await snapshot(to.worktree, path.basename(to.worktree), true) : false;
  if (to.worktree) {
    if (toSaved) log(`Travail de ${path.basename(to.worktree)} mis de côté (commit wip temporaire)`);
    log(`Détachement de ${path.basename(to.worktree)} : git switch --detach`);
    await git(to.worktree, "switch", "--detach");
  }
  log(`Sur current : git switch ${to.branch}`);
  try {
    await git(main, "switch", to.branch);
  } catch (error) {
    log("Refusé par git, retour à l'état de départ");
    if (to.worktree) {
      await git(to.worktree, "switch", to.branch);
      await unwindSnapshots(to.worktree);
    }
    if (fromSaved) await git(main, "reset", "-q", "--soft", "HEAD~1");
    if (parked) await restorePark(main, from.branch);
    throw error;
  }
  if (toSaved) {
    await git(main, "reset", "-q", "--soft", "HEAD~1");
    log(`Travail du worktree indexé (staged) sur current, ${to.branch} reste sur son dernier vrai commit`);
  }
  if (!to.worktree && (await restorePark(main, to.branch))) log(`Travail garé de ${to.branch} restauré`);
  if (from.worktree) {
    log(`${path.basename(from.worktree)} reprend ${from.branch}`);
    await git(from.worktree, "switch", from.branch);
    const unwound = await unwindSnapshots(from.worktree);
    if (unwound > 0) log(`${unwound} commit(s) "wip" défait(s) : le travail redevient non committé dans ${path.basename(from.worktree)}`);
  }
}

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || String(error);
}

async function commitSnapshot(cwd: string, label: string): Promise<void> {
  await git(cwd, "commit", "-q", "--no-verify", "-m", "wip", "-m", `${snapshotTrailer}: ${label}`);
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run("git", args, { cwd, maxBuffer: maxOutput });
}

// Forced to the C locale: conflictedPaths parses git's English messages.
function gitWithInput(cwd: string, input: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: maxOutput, env: { ...process.env, LC_ALL: "C" } }, (error, _stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stderr)));
    child.stdin?.end(input);
  });
}

import { execFile } from "node:child_process";
import { mkdir, rename, rmdir } from "node:fs/promises";
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

export type Agent = (cwd: string, name: string, prompt: string) => Promise<string>;

const snapshotTrailer = "Worktree-Hub-Snapshot";
const stagedTrailer = "Worktree-Hub-Staged";
const parkPrefix = "worktree-hub:park:";
const maxOutput = 512 * 1024 * 1024;
const fetchTimeoutMs = 60_000;

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

// GitHub's rebase merge leaves patch-equivalent commits ("-" in git cherry); a tip on the target's first-parent line is fresh or stale, not merged.
export async function isMerged(cwd: string, branch: string, target: string): Promise<boolean> {
  const track = (await git(cwd, "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`)).stdout.trim();
  if (track === "[gone]") return true;
  let ahead: string[];
  try {
    ahead = (await git(cwd, "cherry", target, branch)).stdout.split("\n").filter(Boolean);
  } catch {
    return false;
  }
  if (ahead.length > 0) return ahead.every((line) => line.startsWith("-"));
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

// The index gets its own commit under the rest, so unwinding gives back what was staged, unstaged and untracked.
export async function snapshot(cwd: string, label: string, includeUntracked: boolean): Promise<boolean> {
  const staged = (await unmergedPaths(cwd)).length === 0 && (await hasStagedChanges(cwd));
  if (staged) await commitSnapshot(cwd, stagedTrailer, label);
  await git(cwd, "add", includeUntracked ? "-A" : "-u");
  const rest = await hasStagedChanges(cwd);
  if (rest) await commitSnapshot(cwd, snapshotTrailer, label);
  return staged || rest;
}

export async function unwindSnapshots(cwd: string): Promise<number> {
  let count = 0;
  for (;;) {
    const body = (await git(cwd, "log", "-1", "--format=%B")).stdout;
    const mode = body.includes(`\n${snapshotTrailer}:`) ? "--mixed" : body.includes(`\n${stagedTrailer}:`) ? "--soft" : undefined;
    if (!mode) return count;
    await git(cwd, "reset", "-q", mode, "HEAD~1");
    count++;
  }
}

export async function park(cwd: string, branch: string): Promise<boolean> {
  if ((await countChanges(cwd)) === 0) return false;
  await git(cwd, "stash", "push", "-q", "-u", "-m", `${parkPrefix}${branch}`);
  return true;
}

export async function restorePark(cwd: string, branch: string): Promise<boolean> {
  let restored = false;
  for (;;) {
    const entries = (await git(cwd, "stash", "list", "--format=%H %gs")).stdout.split("\n");
    const sha = entries.find((entry) => entry.endsWith(`: ${parkPrefix}${branch}`))?.split(" ")[0];
    if (!sha) return restored;
    await git(cwd, "stash", "apply", "-q", "--index", sha);
    const ref = (await git(cwd, "stash", "list", "--format=%gd %H")).stdout.split("\n").find((entry) => entry.endsWith(` ${sha}`))?.split(" ")[0];
    if (!ref) return true;
    await git(cwd, "stash", "drop", "-q", ref);
    restored = true;
  }
}

// Files ignored by the branch leaving current, and not by the new one, surface as untracked right after the switch.
async function relocateExposed(main: string, from: Place, log: Log): Promise<void> {
  const files = (await git(main, "ls-files", "--others", "--exclude-standard", "-z")).stdout.split("\0").filter(Boolean);
  if (files.length === 0) return;
  if (!from.worktree) {
    await git(main, "stash", "push", "-q", "-u", "-m", `${parkPrefix}${from.branch}`);
    log(`${files.length} fichier(s) ignoré(s) par ${from.branch} seulement, garé(s) avec son travail (stash ${parkPrefix}${from.branch})`);
    return;
  }
  for (const file of files) {
    const target = path.join(from.worktree, file);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(path.join(main, file), target);
    await removeEmptyParents(main, path.dirname(file));
  }
  log(`${files.length} fichier(s) ignoré(s) par ${from.branch} seulement, rendu(s) à ${path.basename(from.worktree)}`);
}

async function removeEmptyParents(root: string, dir: string): Promise<void> {
  for (; dir !== "."; dir = path.dirname(dir)) {
    try {
      await rmdir(path.join(root, dir));
    } catch {
      return;
    }
  }
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
  await commitSnapshot(worktree, snapshotTrailer, `${name} sync`);
  if (conflicts.length > 0) log(`Conflit(s) laissé(s) sur current, à résoudre : ${conflicts.join(", ")}`);
  else log("Modifications indexées (staged) sur current ; repère posé dans le worktree, hors branche");
  return true;
}

function conflictedPaths(applyOutput: string): string[] {
  return [...applyOutput.matchAll(/^Applied patch to '(.+)' with conflicts\.$/gm)].map((match) => match[1]);
}

export async function moveCurrent(main: string, from: Place, to: Place, log: Log): Promise<void> {
  if (from.branch === to.branch) return;
  const unmerged = await unmergedPaths(main);
  if (unmerged.length > 0) throw new Error(`conflit(s) non résolu(s) sur current (${unmerged.join(", ")}) : rien n'a été déplacé`);
  if (from.worktree) await syncToMain(main, from.worktree, log);
  const fromSaved = from.worktree ? await snapshot(main, "current", true) : false;
  if (fromSaved) log(`Travail de current mis de côté sur ${from.branch} (commits wip temporaires, l'index à part)`);
  const parked = from.worktree ? false : await park(main, from.branch);
  if (parked) log(`Travail non committé de ${from.branch} garé (stash ${parkPrefix}${from.branch})`);
  const toSaved = to.worktree ? await snapshot(to.worktree, path.basename(to.worktree), true) : false;
  if (to.worktree) {
    if (toSaved) log(`Travail de ${path.basename(to.worktree)} mis de côté (commits wip temporaires, l'index à part)`);
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
    if (fromSaved) await unwindSnapshots(main);
    if (parked) await restorePark(main, from.branch);
    throw error;
  }
  await relocateExposed(main, from, log);
  if (toSaved) {
    await unwindSnapshots(main);
    log(`Travail du worktree restauré sur current tel quel (indexé, non indexé, non suivi), ${to.branch} reste sur son dernier vrai commit`);
  }
  if (!to.worktree && (await restorePark(main, to.branch))) log(`Travail garé de ${to.branch} restauré`);
  if (from.worktree) {
    log(`${path.basename(from.worktree)} reprend ${from.branch}`);
    await git(from.worktree, "switch", from.branch);
    const unwound = await unwindSnapshots(from.worktree);
    if (unwound > 0) log(`${unwound} commit(s) "wip" défait(s) : le travail redevient non committé dans ${path.basename(from.worktree)}, indexé ou non comme sur current`);
  }
}

export async function fetchOrigin(cwd: string, log: Log = () => undefined): Promise<void> {
  if (!(await git(cwd, "remote")).stdout.split("\n").includes("origin")) return;
  log("git fetch --prune origin");
  await run("git", ["fetch", "-q", "--prune", "origin"], { cwd, timeout: fetchTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

// The uncommitted work rides the rebase as wip commits: the agent resolves its conflicts too, and an unfinished run is undone.
export async function rebaseOnDefault(root: string, branch: string, agent: Agent, log: Log): Promise<void> {
  const checkout = (await listWorktrees(root)).find((tree) => tree.branch === branch)?.path;
  if (!checkout) throw new Error(`${branch} n'est extraite nulle part : rien n'a été rebasé`);
  await fetchOrigin(checkout, log);
  const target = await mergeTarget(checkout);
  // Pinned: a background fetch may move the target while the agent works.
  const base = (await git(checkout, "rev-parse", target)).stdout.trim();
  const saved = await snapshot(checkout, "rebase", true);
  if (saved) log("Travail non committé mis de côté en commits wip, rebasés avec la branche");
  log(`Claude rebase ${branch} sur ${target} dans ${path.basename(checkout)}`);
  let summary = "";
  let failure: unknown;
  try {
    summary = await agent(checkout, `Rebase de ${branch} sur ${target}`, rebasePrompt(branch, target, saved));
  } catch (error) {
    failure = error;
  }
  const rebased = failure === undefined && (await isRebasedOnto(checkout, branch, base));
  if (!rebased) await git(checkout, "rebase", "--abort").then(() => log("Rebase inachevé : git rebase --abort"), () => undefined);
  if (saved && (await unwindSnapshots(checkout)) > 0) log("Travail non committé restauré tel quel (indexé, non indexé, non suivi)");
  if (failure !== undefined) throw failure;
  if (!rebased) throw new Error(`${branch} n'est pas rebasée sur ${target}, la branche et son travail sont revenus à leur état de départ${summary ? `. Claude : ${summary}` : ""}`);
  log(`${branch} rebasée sur ${target}`);
}

function rebasePrompt(branch: string, target: string, saved: boolean): string {
  return [
    `Rebase la branche ${branch} sur ${target}, dans ce dossier : git rebase ${target}. ${target} est à jour, le fetch est fait.`,
    saved ? `Les derniers commits "wip" (trailers ${stagedTrailer} et ${snapshotTrailer}) sont du travail non committé mis de côté par Worktree Hub : rebase-les avec le reste, laisse-les en dernier, sans toucher à leur message ni les fusionner.` : "",
    `À chaque conflit : lis les deux côtés (les commits de ${target} et ceux de ${branch}), résous en gardant l'intention des deux, git add, puis git rebase --continue, jusqu'à la fin du rebase. Si c'est rapide, vérifie que le code résolu compile.`,
    "Interdit : git rebase --skip, supprimer, fusionner ou renommer des commits, reset --hard, push, toucher aux autres branches ou worktrees.",
    "Si tu ne peux vraiment pas finir : git rebase --abort, puis explique pourquoi.",
    "Termine par un résumé en français d'une à trois lignes : les conflits rencontrés et comment tu les as résolus.",
  ].filter(Boolean).join("\n");
}

async function isRebasedOnto(cwd: string, branch: string, base: string): Promise<boolean> {
  if ((await git(cwd, "branch", "--show-current")).stdout.trim() !== branch) return false;
  return git(cwd, "merge-base", "--is-ancestor", base, "HEAD").then(() => true, () => false);
}

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || String(error);
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  return (await git(cwd, "diff", "--name-only", "--diff-filter=U")).stdout.split("\n").filter(Boolean);
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, "diff", "--cached", "--name-only")).stdout.trim() !== "";
}

async function commitSnapshot(cwd: string, trailer: string, label: string): Promise<void> {
  await git(cwd, "commit", "-q", "--no-verify", "-m", "wip", "-m", `${trailer}: ${label}`);
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

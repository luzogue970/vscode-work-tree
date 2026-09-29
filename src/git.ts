import { execFile } from "node:child_process";
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

export async function moveBranchToMain(main: string, worktree: string, branch: string): Promise<void> {
  await git(worktree, "switch", "--detach");
  try {
    await git(main, "switch", branch);
  } catch (error) {
    await git(worktree, "switch", branch);
    throw error;
  }
}

export async function moveBranchToWorktree(main: string, worktree: string, branch: string, mainBranch: string): Promise<void> {
  await git(main, "switch", mainBranch);
  await git(worktree, "switch", branch);
}

export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || String(error);
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run("git", args, { cwd });
}

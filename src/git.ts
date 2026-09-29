import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
  main: boolean;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd });
  return stdout
    .split("\n\n")
    .filter((block) => block.startsWith("worktree "))
    .map((block, index) => {
      const lines = block.split("\n");
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch refs/heads/".length);
      return { path: lines[0].slice("worktree ".length), branch: branch ?? "(detached)", main: index === 0 };
    });
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return stdout.trim();
}

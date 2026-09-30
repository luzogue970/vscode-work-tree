import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wth-${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
}

export function initRepo(): string {
  const root = tempDir("repo");
  git(root, "init", "-q", "-b", "main");
  write(root, "f", "main\n");
  write(root, ".gitignore", ".claude/\n");
  git(root, "add", "f", ".gitignore");
  git(root, "commit", "-qm", "init");
  return root;
}

export function write(root: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

export function branchWithCommit(root: string, branch: string, file: string, content: string): void {
  git(root, "switch", "-qc", branch);
  write(root, file, content);
  git(root, "add", file);
  git(root, "commit", "-qm", `commit on ${branch}`);
  git(root, "switch", "-q", "main");
}

export function addWorktree(root: string, branch: string, detach = false): string {
  const dir = path.join(root, ".claude", "worktrees", branch.replaceAll("/", "-"));
  git(root, "worktree", "add", "-q", ...(detach ? ["--detach"] : []), dir, branch);
  return dir;
}

export function projectDirOf(configDir: string, cwd: string): string {
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function writeTranscript(configDir: string, cwd: string, id: string, lines: unknown[] | string): string {
  const dir = projectDirOf(configDir, cwd);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, typeof lines === "string" ? lines : lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

export function userLine(cwd: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "user", cwd, gitBranch: "main", sessionId: "s", isSidechain: false, message: { role: "user", content }, ...extra };
}

export function enterWorktreeLine(input: { path?: string; name?: string }): Record<string, unknown> {
  return { type: "assistant", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "EnterWorktree", input }] } };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

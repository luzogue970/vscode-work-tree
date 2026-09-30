import { link, mkdir, open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface Session {
  id: string;
  file: string;
  size: number;
  title: string;
  cwd: string;
  resumeCwd: string;
  branch: string;
  modified: number;
}

export interface ScanState {
  offsets: Record<string, number>;
  bindings: Record<string, string>;
}

// Transcripts grow to tens of MB: only the first and last 64 KB are read.
const chunkSize = 64 * 1024;
const cache = new Map<string, { modified: number; session: Session | undefined }>();
const enterWorktreeCall = /"name":"EnterWorktree","input":\{"(path|name)":"((?:[^"\\]|\\.)*)"/g;

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function projectDir(cwd: string): string {
  return path.join(configDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export async function listSessions(cwds: string[]): Promise<Session[]> {
  const dirs = [...new Set(cwds.map(projectDir))];
  return newestById((await Promise.all(dirs.map(readProject))).flat());
}

export async function listRepoSessions(root: string): Promise<Session[]> {
  const projects = path.join(configDir(), "projects");
  const key = path.basename(projectDir(root));
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return [];
  }
  const dirs = names.filter((name) => name === key || name.startsWith(`${key}-`)).map((name) => path.join(projects, name));
  return newestById((await Promise.all(dirs.map(readProject))).flat());
}

export async function scanWorktreeEntries(sessions: Session[], root: string, state: ScanState): Promise<boolean> {
  let changed = false;
  for (const session of sessions) {
    const known = state.offsets[session.file] ?? 0;
    const offset = session.size < known ? 0 : known;
    if (session.size === offset) continue;
    const handle = await open(session.file, "r");
    let region: Buffer;
    try {
      region = Buffer.alloc(session.size - offset);
      await handle.read(region, 0, region.length, offset);
    } finally {
      await handle.close();
    }
    const complete = region.lastIndexOf(0x0a) + 1;
    state.offsets[session.file] = offset + complete;
    for (const match of region.toString("utf8", 0, complete).matchAll(enterWorktreeCall)) {
      const value = decode(match[2]);
      const worktree = match[1] === "path" ? value : path.join(root, ".claude", "worktrees", value);
      if (state.bindings[session.id] !== worktree) changed = true;
      state.bindings[session.id] = worktree;
    }
    changed ||= complete > 0;
  }
  return changed;
}

export async function liveSessions(): Promise<Map<string, string>> {
  const dir = path.join(configDir(), "sessions");
  const live = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return live;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const entry = JSON.parse(await readFile(path.join(dir, name), "utf8")) as { pid?: number; sessionId?: string; cwd?: string };
      if (entry.pid && entry.sessionId && entry.cwd && isAlive(entry.pid)) live.set(entry.sessionId, entry.cwd);
    } catch {
      continue;
    }
  }
  return live;
}

// EnterWorktree moves the transcript away and the Claude Code list reads only the workspace dir (includeWorktrees: false).
export async function mirrorTranscripts(sessions: Session[], root: string): Promise<number> {
  const target = projectDir(root);
  await mkdir(target, { recursive: true });
  let linked = 0;
  for (const session of sessions) {
    if (path.dirname(session.file) === target) continue;
    const mirror = path.join(target, path.basename(session.file));
    try {
      await link(session.file, mirror);
      linked++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return linked;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function newestById(sessions: Session[]): Session[] {
  const newest = new Map<string, Session>();
  for (const session of sessions) {
    const known = newest.get(session.id);
    if (!known || session.modified > known.modified) newest.set(session.id, session);
  }
  return [...newest.values()].sort((a, b) => b.modified - a.modified);
}

async function readProject(dir: string): Promise<Session[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
  const sessions = await Promise.all(files.map(readCached));
  return sessions.filter((session): session is Session => session !== undefined);
}

async function readCached(file: string): Promise<Session | undefined> {
  const { mtimeMs, size } = await stat(file);
  const cached = cache.get(file);
  if (cached?.modified === mtimeMs) return cached.session;
  const session = await readSession(file, size, mtimeMs);
  cache.set(file, { modified: mtimeMs, session });
  return session;
}

async function readSession(file: string, size: number, modified: number): Promise<Session | undefined> {
  const handle = await open(file, "r");
  try {
    const head = await readChunk(handle, 0, Math.min(size, chunkSize));
    const tail = size > chunkSize ? await readChunk(handle, size - chunkSize, chunkSize) : head;
    const prompt = firstPrompt(head);
    if (prompt === undefined) return undefined;
    return {
      id: path.basename(file, ".jsonl"),
      file,
      size,
      title: lastField(tail, "customTitle") ?? firstField(head, "customTitle") ?? lastField(tail, "aiTitle") ?? firstField(head, "aiTitle") ?? lastField(tail, "lastPrompt") ?? prompt,
      cwd: lastField(tail, "cwd") ?? lastField(tail, "relocatedCwd") ?? firstField(head, "cwd") ?? "",
      // Claude Code resumes a session in its last "relocated" dir, falling back to the first cwd.
      resumeCwd: lastField(tail, "relocatedCwd") ?? firstField(head, "cwd") ?? "",
      branch: lastField(tail, "gitBranch") ?? firstField(head, "gitBranch") ?? "",
      modified,
    };
  } finally {
    await handle.close();
  }
}

async function readChunk(handle: FileHandle, position: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.toString("utf8", 0, bytesRead);
}

function fieldRegex(key: string): RegExp {
  return new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
}

function firstField(text: string, key: string): string | undefined {
  const match = fieldRegex(key).exec(text);
  return match ? decode(match[1]) : undefined;
}

function lastField(text: string, key: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(fieldRegex(key))) last = match[1];
  return last === undefined ? undefined : decode(last);
}

function decode(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function firstPrompt(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    let entry: { isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) return undefined;
    const text = promptText(entry.message?.content)?.replace(/<[^>]+>/g, " ").trim();
    if (text) return text.slice(0, 80);
  }
  return undefined;
}

function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((item): item is { text: string } => typeof item?.text === "string");
  return block?.text;
}

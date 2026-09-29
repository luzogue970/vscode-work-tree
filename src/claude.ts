import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface Session {
  id: string;
  title: string;
  cwd: string;
  branch: string;
  modified: number;
}

// Transcripts grow to tens of MB: only the first and last 64 KB are read.
const chunkSize = 64 * 1024;
const cache = new Map<string, { modified: number; session: Session | undefined }>();

export function projectDir(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export async function listSessions(cwds: string[]): Promise<Session[]> {
  const dirs = [...new Set(cwds.map(projectDir))];
  const perDir = await Promise.all(dirs.map(readProject));
  return perDir.flat().sort((a, b) => b.modified - a.modified);
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
      title: lastField(tail, "customTitle") ?? firstField(head, "customTitle") ?? lastField(tail, "aiTitle") ?? firstField(head, "aiTitle") ?? lastField(tail, "lastPrompt") ?? prompt,
      cwd: lastField(tail, "cwd") ?? lastField(tail, "relocatedCwd") ?? firstField(head, "cwd") ?? "",
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

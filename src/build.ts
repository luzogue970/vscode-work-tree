import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

export interface Build {
  version: string;
  builtAt: string;
}

export async function readBuild(dir: string): Promise<Build | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { version: string };
    const build = JSON.parse(await readFile(path.join(dir, "out", "build.json"), "utf8")) as { builtAt: string };
    return { version: pkg.version, builtAt: build.builtAt };
  } catch {
    return undefined;
  }
}

export async function newestBuild(extensionPath: string, extensionId: string): Promise<Build | undefined> {
  const root = path.dirname(extensionPath);
  const prefix = `${extensionId.toLowerCase()}-`;
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    names = [];
  }
  const dirs = names.filter((name) => name.toLowerCase().startsWith(prefix)).map((name) => path.join(root, name));
  const builds = await Promise.all([extensionPath, ...dirs].map(readBuild));
  return builds.filter((build): build is Build => build !== undefined).sort((a, b) => b.builtAt.localeCompare(a.builtAt))[0];
}

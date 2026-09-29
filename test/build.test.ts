import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { newestBuild, readBuild } from "../src/build";
import { tempDir } from "./helpers";

function writeBuild(dir: string, version: string, builtAt: string, contributes: unknown = { commands: [] }, withStamp = true): string {
  mkdirSync(path.join(dir, "out"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version, contributes }));
  if (withStamp) writeFileSync(path.join(dir, "out", "build.json"), JSON.stringify({ builtAt }));
  return dir;
}

describe("readBuild", () => {
  const cases = [
    { name: "reads version, stamp and contributes", setup: (dir: string) => writeBuild(dir, "1.2.3", "2026-01-01T00:00:00Z", { views: 1 }), want: { version: "1.2.3", builtAt: "2026-01-01T00:00:00Z", contributes: JSON.stringify({ views: 1 }) } },
    { name: "missing stamp yields undefined", setup: (dir: string) => writeBuild(dir, "1.0.0", "", {}, false), want: undefined },
    { name: "missing package yields undefined", setup: (dir: string) => { mkdirSync(path.join(dir, "out"), { recursive: true }); writeFileSync(path.join(dir, "out", "build.json"), "{}"); }, want: undefined },
    { name: "malformed package yields undefined", setup: (dir: string) => { writeBuild(dir, "1.0.0", "x"); writeFileSync(path.join(dir, "package.json"), "{oops"); }, want: undefined },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const dir = tempDir("build");
      tc.setup(dir);
      const build = await readBuild(dir);
      if (tc.want === undefined) assert.equal(build, undefined);
      else assert.deepEqual(build, { dir, ...tc.want });
    });
  }
});

describe("newestBuild", () => {
  const id = "mathieulp.worktree-hub";
  const cases = [
    { name: "picks the newest sibling of the extension", siblings: { "mathieulp.worktree-hub-0.1.0": "2026-01-01", "mathieulp.worktree-hub-0.2.0": "2026-02-01" }, self: "mathieulp.worktree-hub-0.1.0", want: "0.2.0" },
    { name: "ignores other extensions even when newer", siblings: { "mathieulp.worktree-hub-0.1.0": "2026-01-01", "someone.other-9.0.0": "2027-01-01" }, self: "mathieulp.worktree-hub-0.1.0", want: "0.1.0" },
    { name: "matches the id case-insensitively", siblings: { "mathieulp.worktree-hub-0.1.0": "2026-01-01", "MathieuLP.Worktree-Hub-0.3.0": "2026-03-01" }, self: "mathieulp.worktree-hub-0.1.0", want: "0.3.0" },
    { name: "falls back to the extension's own build", siblings: {}, self: "dev-checkout", want: "self" },
    { name: "yields undefined without any stamped build", siblings: { "mathieulp.worktree-hub-0.1.0": undefined }, self: "mathieulp.worktree-hub-0.1.0", want: undefined },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const root = tempDir("exts");
      for (const [name, builtAt] of Object.entries(tc.siblings)) writeBuild(path.join(root, name), name.split("-").pop() ?? "0", builtAt ?? "", {}, builtAt !== undefined);
      const self = path.join(root, tc.self);
      if (tc.want === "self") writeBuild(self, "self", "2025-01-01");
      const build = await newestBuild(self, id);
      assert.equal(build?.version, tc.want);
    });
  }
});

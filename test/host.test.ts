import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, test } from "node:test";
import { readBuild } from "../src/build";
import { Host } from "../src/host";
import { initRepo, tempDir } from "./helpers";
import { FakeWebviewView, answerWarnings, calls, makeContext, messages, reset, state } from "./stubs/vscode";

const project = path.resolve(__dirname, "..", "..");

function installedCopy(root: string, name: string, version: string, builtAt: string, contributes?: unknown): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(project, "out"), path.join(dir, "out"), { recursive: true });
  cpSync(path.join(project, "media"), path.join(dir, "media"), { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8")) as { contributes: unknown };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version, contributes: contributes ?? pkg.contributes }));
  writeFileSync(path.join(dir, "out", "build.json"), JSON.stringify({ builtAt }));
  return dir;
}

describe("Host", () => {
  beforeEach(() => reset());

  test("loads the implementation and serves the view", async () => {
    const exts = tempDir("exts");
    const dir = installedCopy(exts, "mathieulp.worktree-hub-1.0.0", "1.0.0", "2026-01-01T00:00:00Z");
    state.workspaceFolders = [initRepo()];
    const host = new Host(makeContext(dir, "1.0.0") as never, (await readBuild(dir)) as never);
    await host.load((await readBuild(dir)) as never);
    const view = new FakeWebviewView();
    host.resolveWebviewView(view as never);
    view.send({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((view.last("data") as { running: { version: string } }).running.version, "1.0.0");
    host.dispose();
  });

  const updates = [
    { name: "a newer build with the same contributes is hot loaded", version: "1.1.0", contributes: undefined, wantVersion: "1.1.0", wantRestartAsked: false },
    { name: "a build that changes contributes asks for a restart", version: "2.0.0", contributes: { commands: [] }, wantVersion: "1.0.0", wantRestartAsked: true },
  ];
  for (const tc of updates) {
    test(tc.name, async () => {
      const exts = tempDir("exts");
      const dir = installedCopy(exts, "mathieulp.worktree-hub-1.0.0", "1.0.0", "2026-01-01T00:00:00Z");
      state.workspaceFolders = [initRepo()];
      const context = makeContext(dir, "1.0.0");
      const host = new Host(context as never, (await readBuild(dir)) as never);
      await host.load((await readBuild(dir)) as never);
      const view = new FakeWebviewView();
      host.resolveWebviewView(view as never);
      await host.check();
      assert.equal(calls.find((call) => call.command === "setContext")?.args[1], false);
      installedCopy(exts, `mathieulp.worktree-hub-${tc.version}`, tc.version, "2026-06-01T00:00:00Z", tc.contributes);
      await host.check();
      assert.equal(calls.filter((call) => call.command === "setContext").at(-1)?.args[1], true);
      answerWarnings(undefined);
      await host.update();
      assert.equal(messages.some((message) => message.kind === "warning"), tc.wantRestartAsked);
      view.send({ type: "ready" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal((view.last("data") as { running: { version: string } }).running.version, tc.wantVersion);
      host.dispose();
    });
  }

  test("a confirmed restart executes the extension host restart", async () => {
    const exts = tempDir("exts");
    const dir = installedCopy(exts, "mathieulp.worktree-hub-1.0.0", "1.0.0", "2026-01-01T00:00:00Z");
    state.workspaceFolders = [initRepo()];
    const host = new Host(makeContext(dir, "1.0.0") as never, (await readBuild(dir)) as never);
    await host.load((await readBuild(dir)) as never);
    installedCopy(exts, "mathieulp.worktree-hub-2.0.0", "2.0.0", "2026-06-01T00:00:00Z", { views: {} });
    await host.check();
    answerWarnings("Redémarrer les extensions");
    await host.update();
    assert.ok(calls.some((call) => call.command === "workbench.action.restartExtensionHost"));
    host.dispose();
  });
});

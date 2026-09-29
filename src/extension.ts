import * as vscode from "vscode";
import { readBuild } from "./build";
import { Host } from "./host";

const updatePollMs = 5000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const running = (await readBuild(context.extensionPath)) ?? { dir: context.extensionPath, version: context.extension.packageJSON.version as string, builtAt: "", contributes: "" };
  const host = new Host(context, running);
  const poll = setInterval(() => void host.check(), updatePollMs);
  context.subscriptions.push(
    host,
    { dispose: () => clearInterval(poll) },
    vscode.window.registerWebviewViewProvider("worktreeHub.view", host),
    vscode.commands.registerCommand("worktreeHub.update", () => host.update()),
  );
  await host.load(running);
  await host.check();
}

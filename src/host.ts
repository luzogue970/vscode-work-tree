import * as path from "node:path";
import * as vscode from "vscode";
import { newestBuild, type Build } from "./build";
import type { Loaded } from "./impl";

const restartLabel = "Redémarrer les extensions";

export class Host implements vscode.WebviewViewProvider, vscode.Disposable {
  private current: Loaded | undefined;
  private view: vscode.WebviewView | undefined;
  private available: Build | undefined;
  private updating = false;

  constructor(private readonly context: vscode.ExtensionContext, private running: Build) {}

  async load(build: Build): Promise<void> {
    this.current?.dispose();
    purgeModules(this.running.dir);
    this.running = build;
    const impl = require(path.join(build.dir, "out", "impl.js")) as typeof import("./impl");
    this.current = await impl.activate(this.context, build.dir, build);
    if (this.view) this.current.resolve(this.view);
    this.current.setUpdate(this.available);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.current?.resolve(view);
  }

  async check(): Promise<void> {
    const newest = await newestBuild(this.context.extensionPath, this.context.extension.id);
    this.available = newest && newest.builtAt > this.running.builtAt ? newest : undefined;
    await vscode.commands.executeCommand("setContext", "worktreeHub.updateAvailable", this.available !== undefined);
    this.current?.setUpdate(this.available);
  }

  async update(): Promise<void> {
    const target = this.available;
    if (!target || this.updating) return;
    if (target.contributes !== this.running.contributes) {
      await confirmRestart(`La v${target.version} change les contributions de l'extension (commandes, vues, réglages) : seul un redémarrage des extensions peut la charger, ce qui coupe les conversations Claude Code en cours.`);
      return;
    }
    this.updating = true;
    try {
      await this.load(target);
      await this.check();
    } catch (error) {
      await confirmRestart(`Rechargement à chaud impossible (${String(error)}).`);
    } finally {
      this.updating = false;
    }
  }

  dispose(): void {
    this.current?.dispose();
  }
}

async function confirmRestart(reason: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(`${reason} Redémarrer maintenant ?`, { modal: true }, restartLabel);
  if (choice !== restartLabel) return;
  try {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  } catch {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function purgeModules(dir: string): void {
  const out = path.join(dir, "out") + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(out) && !key.endsWith(`${path.sep}extension.js`) && !key.endsWith(`${path.sep}host.js`)) delete require.cache[key];
  }
}

import * as path from "node:path";

export interface Call {
  command: string;
  args: unknown[];
}

export const calls: Call[] = [];
export const messages: { kind: "error" | "warning" | "info"; text: string }[] = [];
export let warningAnswer: string | undefined;
export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const state = { workspaceFolders: [] as string[] };

export function reset(): void {
  calls.length = 0;
  messages.length = 0;
  warningAnswer = undefined;
  handlers.clear();
  state.workspaceFolders = [];
}

export function answerWarnings(answer: string | undefined): void {
  warningAnswer = answer;
}

export class Uri {
  private constructor(readonly fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export class RelativePattern {
  constructor(readonly base: Uri, readonly pattern: string) {}
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}

export const commands = {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable {
    if (handlers.has(command)) throw new Error(`command '${command}' already exists`);
    handlers.set(command, handler);
    return new Disposable(() => handlers.delete(command));
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    calls.push({ command, args });
    return handlers.get(command)?.(...args);
  },
};

export const window = {
  async showErrorMessage(text: string): Promise<undefined> {
    messages.push({ kind: "error", text });
    return undefined;
  },
  async showWarningMessage(text: string): Promise<string | undefined> {
    messages.push({ kind: "warning", text });
    return warningAnswer;
  },
  async showInformationMessage(text: string): Promise<undefined> {
    messages.push({ kind: "info", text });
    return undefined;
  },
  withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
    return task();
  },
  registerWebviewViewProvider(): Disposable {
    return new Disposable(() => undefined);
  },
  tabGroups: { all: [] },
};

export const workspace = {
  get workspaceFolders(): { uri: Uri }[] | undefined {
    return state.workspaceFolders.length === 0 ? undefined : state.workspaceFolders.map((folder) => ({ uri: Uri.file(folder) }));
  },
  createFileSystemWatcher(): { onDidCreate(): Disposable; onDidChange(): Disposable; onDidDelete(): Disposable; dispose(): void } {
    const noop = () => new Disposable(() => undefined);
    return { onDidCreate: noop, onDidChange: noop, onDidDelete: noop, dispose: () => undefined };
  },
};

export const extensions = {
  getExtension(): { activate(): Promise<void> } | undefined {
    return { activate: async () => undefined };
  },
};

export class Memento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

export function makeContext(extensionPath: string, version = "0.0.0"): { extensionPath: string; extensionUri: Uri; extension: { id: string; packageJSON: { version: string } }; globalState: Memento; workspaceState: Memento; subscriptions: { dispose(): void }[] } {
  return { extensionPath, extensionUri: Uri.file(extensionPath), extension: { id: "mathieulp.worktree-hub", packageJSON: { version } }, globalState: new Memento(), workspaceState: new Memento(), subscriptions: [] };
}

export class FakeWebviewView {
  readonly posted: Record<string, unknown>[] = [];
  visible = true;
  private receive: ((message: unknown) => void) | undefined;
  private visibility: (() => void) | undefined;
  private disposed: (() => void) | undefined;
  readonly webview = {
    options: {} as unknown,
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (uri: Uri) => uri,
    postMessage: async (message: Record<string, unknown>) => {
      this.posted.push(message);
      return true;
    },
    onDidReceiveMessage: (handler: (message: unknown) => void) => {
      this.receive = handler;
      return new Disposable(() => {
        if (this.receive === handler) this.receive = undefined;
      });
    },
  };
  onDidChangeVisibility(handler: () => void): Disposable {
    this.visibility = handler;
    return new Disposable(() => undefined);
  }
  onDidDispose(handler: () => void): Disposable {
    this.disposed = handler;
    return new Disposable(() => undefined);
  }
  send(message: unknown): void {
    this.receive?.(message);
  }
  show(visible: boolean): void {
    this.visible = visible;
    this.visibility?.();
  }
  dispose(): void {
    this.disposed?.();
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.posted].reverse().find((message) => message.type === type);
  }
}

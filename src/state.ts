import type { ScanState } from "./claude";

export interface RepoState extends ScanState {
  worktrees: Record<string, string>;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class StateStore {
  constructor(private readonly memento: Memento) {}

  get(root: string): RepoState {
    const saved = this.memento.get<Partial<RepoState>>(key(root));
    return { offsets: { ...saved?.offsets }, bindings: { ...saved?.bindings }, worktrees: { ...saved?.worktrees } };
  }

  async save(root: string, state: RepoState): Promise<void> {
    await this.memento.update(key(root), state);
  }
}

function key(root: string): string {
  return `repo:${root}`;
}

import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceChange {
  changed: boolean;
  summary: string;
  head: string;
}

/** Git wrapper for the shared /workspace the agents build in. */
export class Workspace {
  private git: SimpleGit;
  private lastHeads = new Map<string, string>();

  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
    this.git = simpleGit({ baseDir: root });
  }

  async ensureRepo(): Promise<void> {
    // Must check for .git AT THIS EXACT PATH — simple-git's checkIsRepo()
    // walks up parents, which made the sandbox resolve to the antfarm repo
    // itself (overnight-run lesson: agents' git ops escaped the sandbox).
    if (!existsSync(join(this.root, '.git'))) {
      await this.git.init();
      await this.git.addConfig('user.name', 'antfarm');
      await this.git.addConfig('user.email', 'antfarm@local');
    }
  }

  async currentHead(): Promise<string> {
    const out = await this.git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '');
    return out.trim() || '(empty)';
  }

  /** Detect whether the workspace changed for `agent` since its last cycle. */
  async poll(agent: string): Promise<boolean> {
    const head = await this.currentHead();
    const status = await this.git.status();
    const dirty = status.files.length > 0;
    const known = this.lastHeads.get(agent);
    if (known === undefined) return dirty || head !== '(empty)';
    return dirty || head !== known;
  }

  /** Snapshot after the agent's cycle so the next poll measures only new work. */
  async markSeen(agent: string): Promise<void> {
    const head = await this.currentHead();
    this.lastHeads.set(agent, head);
  }

  async diffSummary(): Promise<string> {
    try {
      const status = await this.git.status();
      const staged = status.files.length;
      if (staged === 0) return 'workspace clean';
      const names = status.files.slice(0, 10).map((f) => f.path);
      const more = staged > names.length ? ` (+${staged - names.length} more)` : '';
      return `${staged} changed file(s): ${names.join(', ')}${more}`;
    } catch {
      return 'workspace unavailable';
    }
  }
}

export function workspacePath(projectRoot: string): string {
  return join(projectRoot, 'workspace');
}

import type { ActionsOutputT } from '../actions.js';
import { parseActions } from '../actions.js';
import type { AgentDriver } from '../driver.js';

export type FixtureScript = Record<string, unknown>;

/**
 * Dry-run driver: replays scripted outputs deterministically.
 * Used by tests and `--dry-run` mode so the whole loop runs
 * without burning tokens (implementation guide §5).
 */
export class FakeDriver implements AgentDriver {
  private cursors = new Map<string, number>();

  constructor(private scripts: Record<string, FixtureScript[]>) {}

  pending(agent: string): boolean {
    const script = this.scripts[agent] ?? [];
    return (this.cursors.get(agent) ?? 0) < script.length;
  }

  async run(ctx: { agent: string }): Promise<ActionsOutputT> {
    const script = this.scripts[ctx.agent] ?? [];
    const cursor = this.cursors.get(ctx.agent) ?? 0;
    const next = script[cursor];
    if (!next) throw new Error(`no scripted action for ${ctx.agent} at step ${cursor}`);
    this.cursors.set(ctx.agent, cursor + 1);
    return parseActions(next);
  }

  remaining(agent: string): number {
    const script = this.scripts[agent] ?? [];
    return script.length - (this.cursors.get(agent) ?? 0);
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { runLoop } from '../src/loop.js';
import type { OrchestratorDeps } from '../src/cycle.js';

function setup(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s11-'));
  return { db: openDb(join(dir, 'lab.db')), dir };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

describe('budget exhaustion cooldown', () => {
  it('auto-unparks an exhausted agent after the cooldown window', () => {
    const b = new Budgets({ maxTokensPerCycle: 100, maxCyclesPerHour: 50 }, 1_000);
    let now = 1_000_000;

    expect(b.canRun('a', now).ok).toBe(true);
    b.recordCycle('a', 500, 0, now); // way over cap → exhausted
    expect(b.canRun('a', now + 500).reason).toBe('budget_exhausted');
    expect(b.canRun('a', now + 900).ok).toBe(false);

    // cooldown served → unparked, stamps cleared
    expect(b.canRun('a', now + 1_001).ok).toBe(true);
  });

  it('does not re-exhaust immediately for a within-cap cycle after unparking', () => {
    const b = new Budgets({ maxTokensPerCycle: 100, maxCyclesPerHour: 50 }, 1_000);
    let now = 1_000_000;
    b.recordCycle('a', 500, 0, now);
    expect(b.canRun('a', now + 2_000).ok).toBe(true);
    b.recordCycle('a', 50, 50, now + 2_000); // exactly at cap — fine
    expect(b.isExhausted('a')).toBe(false);
  });
});

describe('daemon (persistent) loop mode', () => {
  it('keeps breathing through quiet rounds and runs idle-tick cycles', async () => {
    const { db, dir } = setup();
    const repos = createRepos(db);
    let cycles = 0;
    const driver = {
      pending: () => false,
      run: async () => {
        cycles++;
        return { mails: [], taskMoves: [], summary: 'idle tick' };
      },
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 100 }),
      drivers: { 'agent-a': driver },
      agents: ['agent-a'],
    };

    // persistent: quiet rounds sleep 10ms; agent gets proactive idle ticks
    const report = await runLoop(deps, { persistent: true, idleTickMs: 20, maxRounds: 4 });
    expect(report.rounds).toBe(4); // did not break on the first quiet round
    expect(cycles).toBeGreaterThanOrEqual(2); // idle ticks fired
    db.close();
    cleanup(dir);
  });

  it('one-shot mode still exits on the first quiet round', async () => {
    const { db, dir } = setup();
    const repos = createRepos(db);
    let cycles = 0;
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 100 }),
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => {
            cycles++;
            return { mails: [], taskMoves: [], summary: '' };
          },
        },
      },
      agents: ['agent-a'],
    };
    const report = await runLoop(deps, { maxRounds: 10 });
    expect(report.rounds).toBe(1);
    expect(cycles).toBe(0); // nothing wakeable at all
    db.close();
    cleanup(dir);
  });
});

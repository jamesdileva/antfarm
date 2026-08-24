import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { runLoop } from '../src/loop.js';
import type { OrchestratorDeps } from '../src/cycle.js';

describe('idle-tick streak cap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-s11b-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function depsWith(): OrchestratorDeps {
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    return {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 100 }),
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => ({ mails: [], taskMoves: [], summary: 'idle' }),
        },
      },
      agents: ['agent-a'],
    };
  }

  it('stops proactive idle cycles after several unproductive ones', async () => {
    const deps = depsWith();
    const report = await runLoop(deps, { persistent: true, idleTickMs: 1, maxRounds: 30 });
    // 5 idle ticks allowed, then streak cap blocks further forced wakes
    expect(report.cyclesRun).toBe(5);
  });

  it('real signals still wake a capped agent', async () => {
    const db = openDb(join(dir, 'lab2.db'));
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
            if (cycles <= 5) return { mails: [], taskMoves: [], summary: 'idle' };
            return {
              mails: [{ to: 'agent-b', type: 'STATUS', subject: 'finally productive', body: 'did a thing' }],
              taskMoves: [],
              summary: 'productive',
            };
          },
        },
      },
      agents: ['agent-a'],
    };

    await runLoop(deps, { persistent: true, idleTickMs: 1, maxRounds: 30 });
    expect(cycles).toBeGreaterThanOrEqual(5);

    // real signal arrives → capped agent must wake again
    repos.mail.enqueue('human', { to: 'agent-a', type: 'STATUS', subject: 'new input', body: 'go' });
    await runLoop(deps, { persistent: true, idleTickMs: 1, maxRounds: 30 });
    expect(cycles).toBeGreaterThan(5);
    db.close();
  });
});

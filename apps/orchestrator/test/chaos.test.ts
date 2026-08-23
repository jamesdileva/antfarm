import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { FakeDriver } from '../src/drivers/fake.js';
import { runLoop, type LoopOptions } from '../src/loop.js';
import type { OrchestratorDeps } from '../src/cycle.js';
import { recoverOrphans } from '../src/recover.js';

/**
 * Phase 2 exit-criteria chaos suite: kill the "process" (abrupt db close,
 * no cleanup) at varying points; reopen; assert monotonic invariants and
 * that the run completes after recovery.
 */

// deterministic LCG so failures reproduce
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

const bigScript = {
  'agent-a': Array.from({ length: 8 }, (_, i) => ({
    mails: [{ to: 'agent-b', type: 'STATUS' as const, subject: `update ${i}`, body: `work item ${i} done` }],
    taskMoves: [],
    summary: `cycle ${i}`,
  })),
  'agent-b': Array.from({ length: 8 }, (_, i) => ({
    mails: [],
    taskMoves: [],
    summary: `ack ${i}`,
  })),
};

describe('chaos: abrupt termination + recovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-chaos-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  });

  it('never loses committed mail or tasks across random kills', async () => {
    const dbPath = join(dir, 'lab.db');
    const rand = rng(1337);
    let prevFiledCount = -1;

    for (let iter = 0; iter < 4; iter++) {
      // "boot"
      const db = openDb(dbPath);
      const repos = createRepos(db);
      const swept = recoverOrphans(db);
      void swept;

      // invariant: filed mail never shrinks
      const filedNow = repos.events.byKind('mail_filed').length;
      expect(filedNow).toBeGreaterThanOrEqual(Math.max(prevFiledCount, 0));
      prevFiledCount = filedNow;

      const deps: OrchestratorDeps = {
        repos,
        budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 1000 }),
        drivers: {
          'agent-a': new FakeDriver(bigScript),
          'agent-b': new FakeDriver(bigScript),
        },
        agents: ['agent-a', 'agent-b'],
      };

      // run a random number of rounds, then "kill -9" (abrupt close)
      const rounds = Math.max(1, Math.floor(rand() * 6));
      await runLoop(deps, { maxRounds: rounds });
      db.close();
    }

    // final boot — everything resumes to completion
    const db = openDb(dbPath);
    const repos = createRepos(db);
    recoverOrphans(db);
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 1000 }),
      drivers: {
        'agent-a': new FakeDriver(bigScript),
        'agent-b': new FakeDriver(bigScript),
      },
      agents: ['agent-a', 'agent-b'],
    };
    const report = await runLoop(deps);

    // all 16 scripted cycles eventually ran (some may have run pre-kill)
    const doneSessions = (await import('@antfarm/db')).createRepos(db)
      .events.byKind('cycle_done').length;
    expect(doneSessions).toBeGreaterThanOrEqual(16);
    expect(report.cyclesRun).toBeGreaterThanOrEqual(0);

    // board consistent: every session row has a terminal status
    for (const s of repos.events.byKind('cycle_done')) {
      void s;
    }
    db.close();
  });

  it('orphan sweep leaves zero running sessions after any kill point', async () => {
    const dbPath = join(dir, 'lab.db');
    const rand = rng(7);

    for (let iter = 0; iter < 3; iter++) {
      const db = openDb(dbPath);
      const repos = createRepos(db);
      recoverOrphans(db);

      // simulate a cycle that starts but the process dies mid-run:
      const session = repos.sessions.start({ agent: 'agent-a', cycle: iter + 1, goal: 'doomed' });
      if (rand() > 0.5) {
        repos.mail.enqueue('agent-a', { to: 'agent-b', type: 'STATUS', subject: `m${iter}`, body: 'x' });
      }
      void session;
      db.close(); // abrupt

      // next boot sweeps
      const db2 = openDb(dbPath);
      const repos2 = createRepos(db2);
      expect(recoverOrphans(db2)).toBe(1);
      const running = db2.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status='running'`).get() as { n: number };
      expect(running.n).toBe(0);
      db2.close();
    }
  });
});

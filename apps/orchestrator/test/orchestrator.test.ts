import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { FakeDriver } from '../src/drivers/fake.js';
import { runLoop } from '../src/loop.js';
import type { OrchestratorDeps } from '../src/cycle.js';
import { shouldWake } from '../src/wake.js';

describe('wake policy', () => {
  it('wakes on any actionable input', () => {
    expect(shouldWake({ pendingWork: false, queuedMail: 0, ownedTaskChanged: false, workspaceChanged: false })).toBe(false);
    expect(shouldWake({ pendingWork: true, queuedMail: 0, ownedTaskChanged: false, workspaceChanged: false })).toBe(true);
    expect(shouldWake({ pendingWork: false, queuedMail: 2, ownedTaskChanged: false, workspaceChanged: false })).toBe(true);
    expect(shouldWake({ pendingWork: false, queuedMail: 0, ownedTaskChanged: true, workspaceChanged: false })).toBe(true);
  });
});

function makeDeps(db: Db, scripts: Record<string, Record<string, unknown>[]>,
                  budgetCfg = { maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }): {
  deps: OrchestratorDeps;
  repos: Repos;
} {
  const repos = createRepos(db);
  const deps: OrchestratorDeps = {
    repos,
    budgets: new Budgets(budgetCfg),
    drivers: { 'agent-a': new FakeDriver(scripts), 'agent-b': new FakeDriver(scripts) },
    agents: ['agent-a', 'agent-b'],
  };
  return { deps, repos };
}

describe('dry-run loop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-loop-'));
  });

  afterEach(() => {
    // Windows can hold WAL locks briefly after close; cleanup is best-effort
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* temp dir left behind */
    }
  });

  it('runs scripted cycles end-to-end: mail filed, tasks moved, events logged', async () => {
    const db = openDb(join(dir, 'lab.db'));
    const { deps, repos } = makeDeps(db, {
      'agent-a': [
        { mails: [{ to: 'agent-b', type: 'IDEA', subject: 'idea', body: 'build a thing' }], summary: 'proposed' },
        { mails: [], taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-a' }], summary: 'building' },
      ],
      'agent-b': [
        { mails: [], taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-b' }], summary: 'reviewing' },
      ],
    });
    repos.tasks.create('human', { title: 'spec' });
    // seed mail so agent-b wakes for its review cycle
    repos.mail.enqueue('agent-a', { to: 'agent-b', type: 'STATUS', subject: 'kickoff', body: 'go' });

    const report = await runLoop(deps);

    expect(report.cyclesRun).toBe(3);
    expect(repos.tasks.byId(1).state).toBe('active');
    const filed = repos.events.byKind('mail_filed');
    expect(filed).toHaveLength(1);
    expect(repos.mail.queuedFor('agent-a')).toHaveLength(0);
    expect(repos.mail.queuedFor('agent-b')).toHaveLength(0);
    db.close();
  });

  it('restarts cleanly: queued mail and board survive close/reopen', async () => {
    const dbPath = join(dir, 'lab.db');

    // "run" phase — orchestrator dies after filing mail
    const db1 = openDb(dbPath);
    const first = makeDeps(db1, {
      'agent-a': [{ mails: [{ to: 'agent-b', type: 'QUESTION', subject: 'api?', body: 'which http lib?' }], summary: 'asking' }],
      'agent-b': [],
    });
    await runLoop(first.deps);
    db1.close();

    // restart — fresh process state over the same DB
    const db2 = openDb(dbPath);
    const second = makeDeps(db2, {
      'agent-a': [],
      'agent-b': [{ mails: [{ to: 'agent-a', type: 'REVIEW', subject: 're: api?', body: 'use node:http' }], summary: 'answered' }],
    });

    const report = await runLoop(second.deps);
    expect(report.cyclesRun).toBeGreaterThanOrEqual(1);
    const repos2 = createRepos(db2);
    // agent-b's answer was filed post-restart…
    expect(
      repos2.events.all().some((e) => e.kind === 'mail_filed' && e.actor === 'agent-b')
    ).toBe(true);
    // …and the original QUESTION thread got its reply
    const warnings = repos2.mail.queuedFor('agent-a');
    // at most one outstanding teaching-warning (fail↔warn churn guard)
    expect(warnings.filter((m) => m.subject.includes('could not be processed')).length).toBeLessThanOrEqual(1);
    db2.close();
  });

  it('enforces budgets: token cap exhausts the agent mechanically', async () => {
    const db = openDb(join(dir, 'lab.db'));
    const bigUsage = () => ({ tokensIn: 3000, tokensOut: 100 });
    const repos = createRepos(db);
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 2000, maxCyclesPerHour: 50 }),
      drivers: {
        'agent-a': new FakeDriver({
          'agent-a': [
            { mails: [], summary: 'one' },
            { mails: [], summary: 'two' },
          ],
        }),
        'agent-b': new FakeDriver({}),
      },
      agents: ['agent-a'],
      usageFor: bigUsage,
    };

    const report = await runLoop(deps);
    // first cycle ran, second was skipped by the budget guard
    expect(report.cyclesRun).toBe(1);
    expect(report.skipped.some((s) => s.includes('budget_exhausted'))).toBe(true);
    expect(repos.events.byKind('cycle_skipped').length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('rejects illegal task moves without crashing the loop', async () => {
    const db = openDb(join(dir, 'lab.db'));
    const { deps, repos } = makeDeps(db, {
      'agent-a': [
        { mails: [], taskMoves: [{ taskId: 42, state: 'active' }], summary: 'bad move' },
        { mails: [], taskMoves: [{ taskId: 9999, state: 'done' }], summary: 'missing task' },
      ],
      'agent-b': [],
    });

    const report = await runLoop(deps);
    expect(report.cyclesRun).toBe(2);
    expect(repos.events.byKind('task_move_rejected').length).toBe(2);
    db.close();
  });
});

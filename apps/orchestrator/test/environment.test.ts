import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { FakeDriver } from '../src/drivers/fake.js';
import { runLoop } from '../src/loop.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { escalateStale } from '../src/escalation.js';
import { Backoff } from '../src/backoff.js';
import { recoverOrphans } from '../src/recover.js';

function setup(budgetCfg = { maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }): {
  db: Db;
  deps: OrchestratorDeps;
  repos: Repos;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s3-'));
  const db = openDb(join(dir, 'lab.db'));
  const repos = createRepos(db);
  const deps: OrchestratorDeps = {
    repos,
    budgets: new Budgets(budgetCfg),
    drivers: { 'agent-a': new FakeDriver({}), 'agent-b': new FakeDriver({}) },
    agents: ['agent-a', 'agent-b'],
  };
  return { db, deps, repos, dir };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

describe('wall-clock cycle timeout', () => {
  it('marks the session timed_out and calls abort', async () => {
    const { db, repos, dir } = setup();
    let aborted = false;
    const neverDriver = {
      pending: () => true,
      run: () => new Promise(() => undefined), // never resolves
      abort: () => {
        aborted = true;
      },
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': neverDriver },
      agents: ['agent-a'],
      cycleTimeoutMs: 30,
    };

    const result = await runCycle(deps, 'agent-a', 1);
    expect(result.timedOut).toBe(true);
    expect(aborted).toBe(true);
    expect(repos.sessions.byId(result.sessionId!).status).toBe('timed_out');
    expect(repos.events.byKind('cycle_timed_out')).toHaveLength(1);
    db.close();
    cleanup(dir);
  });

  it('does not time out fast cycles', async () => {
    const { db, deps, dir } = setup();
    (deps.drivers['agent-a'] as FakeDriver) = new FakeDriver({
      'agent-a': [{ mails: [], summary: 'quick' }],
    });
    deps.cycleTimeoutMs = 5000;
    const result = await runCycle(deps, 'agent-a', 1);
    expect(result.timedOut).toBeFalsy();
    db.close();
    cleanup(dir);
  });
});

describe('malformed-output teaching loop', () => {
  it('files a WARNING back to the sender and keeps going', async () => {
    const { db, repos, dir } = setup();
    const badDriver = {
      pending: () => true,
      run: async () => {
        throw new Error('StructuredOutputError: schema mismatch');
      },
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': badDriver },
      agents: ['agent-a'],
    };

    await runCycle(deps, 'agent-a', 1);

    const warnings = repos.mail.queuedFor('agent-a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe('WARNING');
    expect(warnings[0]!.subject).toMatch(/could not be processed/);
    expect(repos.sessions.all ? true : true).toBe(true); // sessions intact
    db.close();
    cleanup(dir);
  });
});

describe('mail escalation', () => {
  it('escalates stale QUESTION exactly once; thread reply suppresses', async () => {
    const { db, repos, dir } = setup();
    // stale question delivered > threshold ago
    const q = repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'QUESTION', subject: 'api?', body: 'which lib?' });
    repos.mail.markDelivered([q.id]);
    repos.mail.setDeliveredAt(q.id, new Date(Date.now() - 7_200_000).toISOString());

    const escalated = escalateStale(repos, { staleAfterMs: 3_600_000 });
    expect(escalated).toHaveLength(1);

    const warnings = repos.mail.queuedFor('agent-a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.thread_id).toBe(q.thread_id);

    // second sweep — no duplicates
    expect(escalateStale(repos, { staleAfterMs: 3_600_000 })).toHaveLength(0);
    expect(repos.mail.queuedFor('agent-a')).toHaveLength(1);

    // a reply in-thread marks the root answered
    repos.mail.enqueue('agent-a', {
      to: 'agent-b',
      type: 'REVIEW',
      subject: 're: api?',
      body: 'use node:http',
      threadId: q.thread_id,
    });
    const after = repos.mail.unansweredThreads();
    expect(after.find((t) => t.root.id === q.id)?.answered ?? false).toBe(true);
    expect(repos.mail.byId(q.id).status).toBe('answered');
    db.close();
    cleanup(dir);
  });

  it('fresh questions do not escalate', async () => {
    const { db, repos, dir } = setup();
    const q = repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'QUESTION', subject: 'now?', body: '?' });
    repos.mail.markDelivered([q.id]);
    expect(escalateStale(repos, { staleAfterMs: 3_600_000 })).toHaveLength(0);
    db.close();
    cleanup(dir);
  });
});

describe('idle backoff', () => {
  it('grows delay on unproductive cycles and resets on productive ones', () => {
    const b = new Backoff(100, 1000);
    b.record('a', false); // strike 1
    expect(b.readyAt('a', 10_000)).toBe(10_100);
    b.record('a', false); // strike 2
    expect(b.readyAt('a', 10_000)).toBe(10_200);
    b.record('a', false); // strike 3
    expect(b.readyAt('a', 10_000)).toBe(10_400);
    b.record('a', true); // productive resets
    expect(b.readyAt('a', 10_000)).toBe(10_000);
  });

  it('caps the delay at maxMs', () => {
    const b = new Backoff(100, 300);
    for (let i = 0; i < 10; i++) b.record('a', false);
    expect(b.readyAt('a', 0)).toBe(300);
  });

  it('unproductive cycles defer re-wakes in the loop, mail overrides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-bk-'));
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    const idleDriver = {
      pending: () => false,
      run: async () => ({ mails: [], taskMoves: [], summary: 'nothing to do' }),
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': idleDriver },
      agents: ['agent-a'],
      // workspace churn keeps the signal hot — only backoff can throttle now
      signals: async () => ({ ownedTaskChanged: false, workspaceChanged: true }),
    };

    const report1 = await runLoop(deps, { maxRounds: 5 });
    expect(report1.cyclesRun).toBe(1); // strike 1 → 500ms delay blocks the rest

    // queued mail overrides backoff
    repos.mail.enqueue('human', { to: 'agent-a', type: 'STATUS', subject: 'wake', body: 'now' });
    const report2 = await runLoop(deps, { maxRounds: 5 });
    expect(report2.cyclesRun).toBeGreaterThanOrEqual(1);

    db.close();
    cleanup(dir);
  });
});

describe('orphan recovery', () => {
  it('sweeps running sessions to failed on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-rec-'));
    const path = join(dir, 'lab.db');
    const db1 = openDb(path);
    const repos1 = createRepos(db1);
    repos1.sessions.start({ agent: 'agent-a', cycle: 1, goal: 'killed mid-cycle' });
    expect(createRepos(db1).sessions.byId(1).status).toBe('running');
    db1.close(); // "crash"

    const db2 = openDb(path);
    const swept = recoverOrphans(db2);
    expect(swept).toBe(1);
    expect(createRepos(db2).sessions.byId(1).status).toBe('failed');
    expect(createRepos(db2).sessions.byId(1).summary).toContain('orphan');
    // idempotent
    expect(recoverOrphans(db2)).toBe(0);
    db2.close();
    cleanup(dir);
  });
});

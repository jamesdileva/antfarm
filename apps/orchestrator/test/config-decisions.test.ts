import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { loadConfig, mergeConfig, type LabConfig } from '../src/config.js';
import { buildSituation, decisionsSince, renderDecisionsMarkdown } from '../src/situation.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { Budgets } from '../src/budgets.js';

function setup(): { db: Db; repos: Repos; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s4-'));
  const db = openDb(join(dir, 'lab.db'));
  return { db, repos: createRepos(db), dir };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

describe('config', () => {
  it('falls back to defaults when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-cfg-'));
    const cfg = loadConfig(dir);
    expect(cfg.budgets.maxCyclesPerHour).toBe(30);
    expect(cfg.cycleTimeoutMs).toBe(120_000);
    cleanup(dir);
  });

  it('merges partial overrides over defaults', () => {
    const base: LabConfig = {
      projectRoot: 'project',
      budgets: { maxTokensPerCycle: 20_000, maxCyclesPerHour: 30 },
      cycleTimeoutMs: 120_000,
      escalationStaleAfterMs: 3_600_000,
      backoffBaseMs: 500,
      backoffMaxMs: 60_000,
    };
    const merged = mergeConfig(base, { budgets: { maxCyclesPerHour: 5 }, cycleTimeoutMs: 999 });
    expect(merged.budgets.maxCyclesPerHour).toBe(5);
    expect(merged.budgets.maxTokensPerCycle).toBe(20_000); // untouched
    expect(merged.cycleTimeoutMs).toBe(999);
    expect(base.budgets.maxCyclesPerHour).toBe(30); // base not mutated
  });

  it('reads lab.config.json from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-cfg2-'));
    writeFileSync(join(dir, 'lab.config.json'), JSON.stringify({ escalationStaleAfterMs: 42 }));
    expect(loadConfig(dir).escalationStaleAfterMs).toBe(42);
    cleanup(dir);
  });
});

describe('DECISIONS.md protocol', () => {
  it('logs DECISION mails, injects them once via read pointers', async () => {
    const { db, repos, dir } = setup();
    const scriptDriver = {
      pending: () => false,
      run: async () => ({
        mails: [{
          to: 'agent-b',
          type: 'DECISION' as const,
          subject: 'use sqlite for state',
          body: 'All cross-agent state lives in SQLite.',
        }],
        taskMoves: [],
        summary: 'decided',
      }),
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': scriptDriver },
      agents: ['agent-a'],
    };

    await runCycle(deps, 'agent-a', 1);

    // decision logged as event; agent-a pointer advanced past it
    const logged = repos.events.byKind('decision_logged');
    expect(logged).toHaveLength(1);
    expect(repos.state.getDecisionPointer('agent-a')).toBe(logged[0]!.id);

    // agent-b has not cycled → sees the decision in its situation report
    const reportB = buildSituation(repos, 'agent-b', { projectRoot: 'project' });
    expect(reportB).toContain('use sqlite for state');
    const view = decisionsSince(repos, 'agent-b');
    expect(view.lines).toHaveLength(1);

    // derived markdown view renders
    expect(renderDecisionsMarkdown(repos)).toContain('- D#');
    db.close();
    cleanup(dir);
  });

  it('pointer advance means no duplicate injection on the next cycle', async () => {
    const { db, repos, dir } = setup();
    repos.events.append({
      kind: 'decision_logged',
      actor: 'agent-b',
      payload: { from: 'agent-b', subject: 's', body: 'b' },
    });
    repos.state.setDecisionPointer('agent-a', repos.events.byKind('decision_logged')[0]!.id);
    expect(decisionsSince(repos, 'agent-a').lines).toHaveLength(0);
    db.close();
    cleanup(dir);
  });
});

describe('board ownership rules', () => {
  it('rejects moves by non-owners, allows claims and platform overrides', async () => {
    const { db, repos, dir } = setup();
    const t1 = repos.tasks.create('human', { title: 'unowned' });
    const t2 = repos.tasks.create('human', { title: 'owned by a' });
    repos.tasks.move('agent-a', t2.id, 'active', 'agent-a');

    // claim an unowned task — allowed
    expect(() => repos.tasks.move('agent-b', t1.id, 'active', 'agent-b')).not.toThrow();

    // non-owner move — rejected
    expect(() => repos.tasks.move('agent-b', t2.id, 'blocked')).toThrow(/does not own/);

    // owner moves own task — allowed
    expect(() => repos.tasks.move('agent-a', t2.id, 'done')).not.toThrow();

    // platform override — allowed even on owned tasks
    const t3 = repos.tasks.create('human', { title: 'stuck' });
    repos.tasks.move('agent-a', t3.id, 'active', 'agent-a');
    expect(() => repos.tasks.move('orchestrator', t3.id, 'blocked')).not.toThrow();

    db.close();
    cleanup(dir);
  });
});

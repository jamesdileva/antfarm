import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { mergeConfig, loadConfig } from '../src/config.js';
import { harnessSummary, runHarness, type ExecFn } from '../src/harness.js';
import { buildSituation, hasDecision } from '../src/situation.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { Budgets } from '../src/budgets.js';

function setup(): { db: Db; repos: Repos; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s6-'));
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

describe('config: harness + mode', () => {
  it('defaults harness to empty commands and directed mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-s6cfg-'));
    const cfg = loadConfig(dir);
    expect(cfg.mode).toBe('directed');
    expect(cfg.harness.buildCmd).toBeUndefined();
    expect(cfg.harness.timeoutMs).toBe(120_000);
    cleanup(dir);
  });

  it('merges mode and harness overrides', () => {
    const merged = mergeConfig(
      {
        projectRoot: 'project',
        mode: 'directed',
        budgets: { maxTokensPerCycle: 1, maxCyclesPerHour: 2 },
        cycleTimeoutMs: 3,
        escalationStaleAfterMs: 4,
        backoffBaseMs: 5,
        backoffMaxMs: 6,
        harness: { timeoutMs: 7 },
      },
      { mode: 'constrained', harness: { buildCmd: 'make', testCmd: 'make check' } }
    );
    expect(merged.mode).toBe('constrained');
    expect(merged.harness.buildCmd).toBe('make');
    expect(merged.harness.testCmd).toBe('make check');
    expect(merged.harness.timeoutMs).toBe(7);
  });
});

describe('harness', () => {
  it('records PASS/FAIL events from the executor', async () => {
    const { db, repos, dir } = setup();
    mkdirSync(join(dir, 'ws'), { recursive: true });
    let call = 0;
    const execFn: ExecFn = async (cmd) => {
      call++;
      return call === 1
        ? { code: 0, output: `built via ${cmd}\nnice` }
        : { code: 1, output: 'tests failed:\n  auth.spec' };
    };
    const results = await runHarness(
      repos,
      { workspaceDir: join(dir, 'ws'), buildCmd: 'npm run build', testCmd: 'npm test', timeoutMs: 1000 },
      execFn
    );

    expect(results.map((r) => [r.kind, r.ok])).toEqual([
      ['build', true],
      ['test', false],
    ]);
    const buildEvents = repos.events.byKind('build_result');
    const testEvents = repos.events.byKind('test_result');
    expect(JSON.parse(buildEvents[0]!.payload).ok).toBe(true);
    expect(JSON.parse(testEvents[0]!.payload).tail).toContain('auth.spec');

    // summaries land in situation reports
    const report = buildSituation(repos, 'agent-a', { projectRoot: 'project' });
    expect(report).toContain('build: PASS');
    expect(report).toContain('test: FAIL');
    db.close();
    cleanup(dir);
  });

  it('reports "not run yet" before any harness execution', () => {
    const { db, repos, dir } = setup();
    expect(harnessSummary(repos)).toEqual(['build: not run yet', 'test: not run yet']);
    db.close();
    cleanup(dir);
  });

  it('executor exceptions become FAIL results without crashing', async () => {
    const { db, repos, dir } = setup();
    const execFn: ExecFn = async () => {
      throw new Error('spawn exploded');
    };
    const results = await runHarness(
      repos,
      { workspaceDir: '.', testCmd: 'whatever', timeoutMs: 100 },
      execFn
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.tail).toContain('spawn exploded');
    db.close();
    cleanup(dir);
  });
});

describe('Mode 2 constrained selection gate', () => {
  it('blocks task activation before any DECISION, allows after', async () => {
    const { db, repos, dir } = setup();

    function deps(): OrchestratorDeps {
      return {
        repos,
        budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
        drivers: {
          'agent-a': {
            pending: () => false,
            run: async () => ({
              mails: [],
              taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-a' }],
              summary: 'starting work',
            }),
          },
        },
        agents: ['agent-a'],
        situation: { projectRoot: 'project', mode: 'constrained' },
      };
    }

    repos.tasks.create('human', { title: 'mystery work' });

    await runCycle(deps(), 'agent-a', 1);
    expect(repos.tasks.byId(1).state).toBe('proposed'); // gated
    expect(repos.events.byKind('move_rejected_predecision')).toHaveLength(1);

    // decision arrives → gate lifts
    repos.events.append({
      kind: 'decision_logged',
      actor: 'agent-b',
      payload: { from: 'agent-b', subject: 'build a notes app', body: 'chosen by team' },
    });
    expect(hasDecision(repos)).toBe(true);

    await runCycle(deps(), 'agent-a', 2);
    expect(repos.tasks.byId(1).state).toBe('active');
    expect(repos.events.byKind('move_rejected_predecision')).toHaveLength(1); // no new rejections

    // selection-phase banner disappears once a decision exists
    const report = buildSituation(repos, 'agent-b', { projectRoot: 'project', mode: 'constrained' });
    expect(report).not.toContain('PHASE: project selection');

    db.close();
    cleanup(dir);
  });

  it('directed mode never gates', async () => {
    const { db, repos, dir } = setup();
    repos.tasks.create('human', { title: 't' });
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => ({
            mails: [],
            taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-a' }],
            summary: 'go',
          }),
        },
      },
      agents: ['agent-a'],
      situation: { projectRoot: 'project', mode: 'directed' },
    };
    await runCycle(deps, 'agent-a', 1);
    expect(repos.tasks.byId(1).state).toBe('active');
    expect(repos.events.byKind('move_rejected_predecision')).toHaveLength(0);
    db.close();
    cleanup(dir);
  });
});

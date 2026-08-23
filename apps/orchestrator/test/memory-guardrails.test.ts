import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { buildSituation } from '../src/situation.js';
import { applyMemoryUpdate } from '../src/memory.js';
import { detectStuckTasks } from '../src/stuck.js';
import { escalateReviewLivelock } from '../src/escalation.js';

function setup(): { db: Db; repos: Repos; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s5-'));
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

function depsWith(repos: Repos, run: () => Promise<unknown>): OrchestratorDeps {
  return {
    repos,
    budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
    drivers: [{ pending: () => false, run }] as never,
    agents: ['agent-a'],
    situation: { projectRoot: 'project' },
  };
}

describe('MEMORY.md compaction protocol', () => {
  let d: ReturnType<typeof setup>;

  beforeEach(() => {
    d = setup();
  });

  afterEach(() => cleanup(d.dir));

  it('saves memory, mirrors the file, and archives prior versions', async () => {
    const { db, repos, dir } = d;
    const projectRoot = join(dir, 'project');

    applyMemoryUpdate(repos, projectRoot, 'agent-a', 'goal: fix tests');
    expect(repos.memory.current('agent-a')).toBe('goal: fix tests');
    expect(readFileSync(join(projectRoot, 'agent-a', 'MEMORY.md'), 'utf8')).toContain('fix tests');

    // second update archives the first
    applyMemoryUpdate(repos, projectRoot, 'agent-a', 'goal: ship feature X');
    expect(repos.memory.current('agent-a')).toBe('goal: ship feature X');
    expect(repos.memory.archiveOf('agent-a')).toHaveLength(1);
    expect(repos.memory.archiveOf('agent-a')[0]!.content).toBe('goal: fix tests');
    expect(repos.memory.archiveOf('agent-b')).toHaveLength(0);

    db.close();
  });

  it('empty memoryUpdate is a no-op (no file, no archive churn)', () => {
    const { db, repos, dir } = d;
    applyMemoryUpdate(repos, join(dir, 'project'), 'agent-a', '   ');
    expect(repos.memory.current('agent-a')).toBeNull();
    expect(existsSync(join(dir, 'project', 'agent-a'))).toBe(false);
    db.close();
  });

  it('injects current memory into the next situation report and round-trips via cycle', async () => {
    const { db, repos, dir } = d;
    const seenSituations: string[] = [];

    const driver = {
      pending: () => false,
      run: async (ctx: { situation: string }) => {
        seenSituations.push(ctx.situation);
        if (seenSituations.length === 1) {
          return {
            mails: [],
            taskMoves: [],
            memoryUpdate: 'learning: tests fail on auth module',
            summary: 'noted',
          };
        }
        return { mails: [], taskMoves: [], memoryUpdate: '', summary: 'ok' };
      },
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': driver },
      agents: ['agent-a'],
      situation: { projectRoot: join(dir, 'project') },
    };

    await runCycle(deps, 'agent-a', 1); // writes memory
    expect(seenSituations[0]).not.toContain('YOUR MEMORY.md'); // none existed yet

    await runCycle(deps, 'agent-a', 2); // should now include it
    expect(seenSituations[1]).toContain('YOUR MEMORY.md');
    expect(seenSituations[1]).toContain('tests fail on auth module');
    db.close();
  });

  it('situation report renders another agent’s memory only to itself', () => {
    const { db, repos, dir } = d;
    applyMemoryUpdate(repos, join(dir, 'project'), 'agent-a', 'secret builder notes');
    const forA = buildSituation(repos, 'agent-a', { projectRoot: 'project' });
    const forB = buildSituation(repos, 'agent-b', { projectRoot: 'project' });
    expect(forA).toContain('secret builder notes');
    expect(forB).not.toContain('secret builder notes');
    db.close();
  });
});

describe('stuck-task detection', () => {
  it('flags untouched active tasks once; respects recent movement', async () => {
    const { db, repos, dir } = setup();
    const movedTask = repos.tasks.create('human', { title: 'moving along' });
    const stillTask = repos.tasks.create('human', { title: 'forgotten' });
    repos.tasks.move('orchestrator', movedTask.id, 'active', 'agent-a');
    repos.tasks.move('orchestrator', stillTask.id, 'active', 'agent-b');

    // simulate movement history: movedTask moved inside window, stillTask outside
    repos.events.append({ kind: 'task_moved', actor: 'agent-a', payload: { taskId: movedTask.id, state: 'active' } });
    // pad with cycle_done events so the window check activates
    for (let i = 0; i < 6; i++) {
      repos.events.append({ kind: 'cycle_done', actor: 'agent-a', payload: { sessionId: i } });
    }

    const stucked = detectStuckTasks(repos, { windowSize: 6 });
    expect(stucked).toEqual([stillTask.id]);
    expect(repos.tasks.byId(stillTask.id).state).toBe('blocked');
    expect(repos.tasks.byId(movedTask.id).state).toBe('active');

    // idempotent — no double flagging
    expect(detectStuckTasks(repos, { windowSize: 6 })).toEqual([]);
    expect(repos.events.byKind('task_stuck')).toHaveLength(1);
    db.close();
    cleanup(dir);
  });
});

describe('review-livelock escalation', () => {
  it('contests stalled REVIEW threads exactly once with rotating resolver', async () => {
    const { db, repos, dir } = setup();

    // thread with 4 REVIEW rounds, no DECISION
    const root = repos.mail.enqueue('agent-a', { to: 'agent-b', type: 'REVIEW', subject: 'design?', body: 'thoughts?' });
    for (let i = 0; i < 3; i++) {
      repos.mail.enqueue('agent-b', {
        to: 'agent-a',
        type: 'REVIEW',
        subject: `re: design? (${i})`,
        body: 'still reviewing',
        threadId: root.thread_id,
      });
    }
    // an unrelated healthy thread
    const okThread = repos.mail.enqueue('agent-a', { to: 'agent-b', type: 'REVIEW', subject: 'small diff', body: 'ok?' });
    repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'REVIEW', subject: 're: small diff', body: 'fine', threadId: okThread.thread_id });

    const contested = escalateReviewLivelock(repos, { maxReviewRounds: 4 });
    expect(contested).toHaveLength(1);
    expect(contested[0]!.rounds).toBe(4);
    // 4 rounds → even → first agent resolves
    expect(contested[0]!.resolver).toBe('agent-a');

    // decision logged into the shared log + thread_contested event
    expect(repos.events.byKind('thread_contested')).toHaveLength(1);
    const decision = repos.events.byKind('decision_logged').at(-1)!;
    expect(JSON.parse(decision.payload).from).toBe('agent-a');

    // second sweep — no duplicates
    expect(escalateReviewLivelock(repos, { maxReviewRounds: 4 })).toHaveLength(0);
    expect(repos.events.byKind('thread_contested')).toHaveLength(1);

    // rotation: 5 rounds would resolve by the second agent
    const root2 = repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'REVIEW', subject: 'other?', body: '?' });
    for (let i = 0; i < 4; i++) {
      repos.mail.enqueue('agent-a', {
        to: 'agent-b',
        type: 'REVIEW',
        subject: `re: other? (${i})`,
        body: '..',
        threadId: root2.thread_id,
      });
    }
    const c2 = escalateReviewLivelock(repos, { maxReviewRounds: 4 });
    expect(c2).toHaveLength(1);
    expect(c2[0]!.resolver).toBe('agent-b');

    // a thread containing a DECISION never contests
    const root3 = repos.mail.enqueue('agent-a', { to: 'agent-b', type: 'REVIEW', subject: 'decided?', body: '?' });
    for (let i = 0; i < 4; i++) {
      repos.mail.enqueue('agent-b', {
        to: 'agent-a',
        type: 'REVIEW',
        subject: `re: decided? (${i})`,
        body: '..',
        threadId: root3.thread_id,
      });
    }
    repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'DECISION', subject: 'settled', body: 'go', threadId: root3.thread_id });
    expect(escalateReviewLivelock(repos, { maxReviewRounds: 4 })).toHaveLength(0);

    db.close();
    cleanup(dir);
  });
});

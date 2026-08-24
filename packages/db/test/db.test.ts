import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, canTransition, type Db } from '../src/index.js';

describe('migrations', () => {
  let db: Db;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-db-'));
    db = openDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies schema and is idempotent on reopen', () => {
    const repos = createRepos(db);
    repos.tasks.create('agent-a', { title: 't1' });
    expect(repos.tasks.list()).toHaveLength(1);

    db.close();
    const reopened = openDb(join(dir, 'test.db'));
    expect(createRepos(reopened).tasks.list()).toHaveLength(1);
    reopened.close();
  });
});

describe('mail repo', () => {
  let db: Db;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-mail-'));
    db = openDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues with defaults and delivers in priority order', () => {
    const repos = createRepos(db);
    repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'REVIEW', subject: 's1', body: 'b1', priority: 8 });
    repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'WARNING', subject: 's2', body: 'b2', priority: 2 });
    repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'STATUS', subject: 's3', body: 'b3', priority: 5 });
    repos.mail.enqueue('agent-b', { to: 'other', type: 'IDEA', subject: 'x', body: 'y' });

    const queued = repos.mail.queuedFor('agent-a');
    expect(queued.map((m) => m.subject)).toEqual(['s2', 's3', 's1']);
    expect(queued[0]!.refs).toBe('[]');

    repos.mail.markDelivered(queued.map((m) => m.id));
    expect(repos.mail.queuedFor('agent-a')).toHaveLength(0);
    expect(queued.every((m) => repos.mail.byId(m.id).status === 'delivered')).toBe(true);
  });

  it('rejects invalid message types via CHECK constraint', () => {
    const repos = createRepos(db);
    expect(() =>
      // @ts-expect-error deliberately invalid type
      repos.mail.enqueue('a', { to: 'b', type: 'GOSSIP', subject: 's', body: 'b' })
    ).toThrow();
  });
});

describe('task repo state machine', () => {
  it('allows only legal transitions', () => {
    expect(canTransition('proposed', 'active')).toBe(true);
    expect(canTransition('proposed', 'done')).toBe(true); // finish-without-ceremony
    expect(canTransition('proposed', 'blocked')).toBe(true);
    expect(canTransition('active', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'active')).toBe(true);
    expect(canTransition('done', 'active')).toBe(false);
    expect(canTransition('dropped', 'proposed')).toBe(false);
  });

  it('moves tasks through legal states and keeps ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-tasks-'));
    const db = openDb(join(dir, 'test.db'));
    const repos = createRepos(db);

    const task = repos.tasks.create('human', { title: 'build thing' });
    expect(task.state).toBe('proposed');

    repos.tasks.move('agent-a', task.id, 'active', 'agent-a');
    expect(repos.tasks.byId(task.id).owner).toBe('agent-a');

    repos.tasks.move('agent-a', task.id, 'blocked');
    expect(repos.tasks.byId(task.id).state).toBe('blocked');
    expect(repos.tasks.byId(task.id).owner).toBe('agent-a');

    expect(() => repos.tasks.move('agent-a', task.id, 'done')).not.toThrow();
    expect(() => repos.tasks.move('agent-b', task.id, 'active')).toThrow(/illegal/);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('protects human-created tasks from agent drops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-humantask-'));
    const db = openDb(join(dir, 'test.db'));
    const repos = createRepos(db);

    const humanTask = repos.tasks.create('human', { title: 'human-requested work' });
    repos.tasks.move('agent-a', humanTask.id, 'active', 'agent-a');
    expect(() => repos.tasks.move('agent-a', humanTask.id, 'dropped')).toThrow(/created by the human/);

    // agents can still drop their own tasks
    const ownTask = repos.tasks.create('agent-b', { title: 'self-created' });
    repos.tasks.move('agent-b', ownTask.id, 'active', 'agent-b');
    expect(() => repos.tasks.move('agent-b', ownTask.id, 'dropped')).not.toThrow();

    // and the platform can always clean up
    expect(() => repos.tasks.move('orchestrator', humanTask.id, 'dropped')).not.toThrow();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sessions + events', () => {
  it('tracks session lifecycle with usage and audit trail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-sess-'));
    const db = openDb(join(dir, 'test.db'));
    const repos = createRepos(db);

    const s = repos.sessions.start({ agent: 'agent-a', cycle: 1, goal: 'fix tests' });
    expect(s.status).toBe('running');

    const finished = repos.sessions.finish(
      s.id,
      'done',
      { tokensIn: 100, tokensOut: 50, cost: 0.01 },
      'all green'
    );
    expect(finished.tokens_in).toBe(100);
    expect(finished.summary).toBe('all green');

    repos.events.append({ kind: 'cycle_started', actor: 'agent-a', payload: { session: s.id } });
    expect(repos.events.byKind('cycle_started')).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

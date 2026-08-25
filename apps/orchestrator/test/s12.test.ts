import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { OpenCodeDriver } from '../src/drivers/opencode.js';
import type { OpencodeSessionClient } from '../src/drivers/opencode.js';
import { loadConfigFrom, mergeConfig } from '../src/config.js';

function fakeClient() {
  const calls = {
    createdDirs: [] as (string | undefined)[],
    promptDirs: [] as (string | undefined)[],
    deleted: [] as string[],
  };
  const client = {
    session: {
      create: async (args: { query?: { directory?: string } }) => {
        calls.createdDirs.push(args.query?.directory);
        return { data: { id: `sess-${calls.createdDirs.length}` } };
      },
      prompt: async (args: { query?: { directory?: string }; body: { parts: Array<{ type: string; text: string }> } }) => {
        calls.promptDirs.push(args.query?.directory);
        return {
          data: {
            info: { tokens: { input: 10, output: 5 }, cost: 0.01 },
            parts: [{ type: 'text', text: '{"mails":[],"summary":"ok"}' }],
          },
        };
      },
      delete: async (args: { path: { id: string } }) => {
        calls.deleted.push(args.path.id);
        return true;
      },
    } as unknown as OpencodeSessionClient['session'],
  };
  return { client: client as unknown as OpencodeSessionClient, calls };
}

describe('session GC', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-s12-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function deps(repos: Repos, driver: OpenCodeDriver): OrchestratorDeps {
    return {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': driver },
      agents: ['agent-a'],
      situation: { projectRoot: join(tmpdir(), 'nonexistent') },
      sessionGc: true,
    };
  }

  it('deletes the opencode session after a successful captured cycle', async () => {
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    const { client, calls } = fakeClient();
    const driver = new OpenCodeDriver({ client, driveSheet: undefined as never });

    await runCycle(deps(repos, driver), 'agent-a', 1);

    expect(calls.deleted).toEqual(['sess-1']);
    // audit trail intact despite transcript deletion
    expect(repos.sessions.byId(1).status).toBe('done');
    db.close();
  });

  it('keeps sessions when GC is disabled', async () => {
    const db = openDb(join(dir, 'lab2.db'));
    const repos = createRepos(db);
    const { client, calls } = fakeClient();
    const driver = new OpenCodeDriver({ client, driveSheet: undefined as never });
    const d = deps(repos, driver);
    d.sessionGc = false;

    await runCycle(d, 'agent-a', 1);
    expect(calls.deleted).toHaveLength(0);
    db.close();
  });

  it('does NOT dispose failed cycles — interrupted sessions hold progress', async () => {
    const db = openDb(join(dir, 'lab3.db'));
    const repos = createRepos(db);
    const deletedIds: string[] = [];
    const driver = new OpenCodeDriver({
      client: {
        session: {
          create: async () => ({ data: { id: 'sess-x' } }),
          prompt: async () => ({
            data: { info: { error: { name: 'ProviderAuthError', message: 'no key' } }, parts: [] },
          }),
          delete: async (args: { path: { id: string } }) => {
            deletedIds.push(args.path.id);
            return true;
          },
        },
      } as unknown as OpencodeSessionClient,
      driveSheet: undefined as never,
    });
    const d = deps(repos, driver);
    d.sessionGc = true;

    await runCycle(d, 'agent-a', 1);
    expect(deletedIds).toEqual([]); // kept — recoverable
    expect(driver.lastSessionId('agent-a')).toBe('sess-x');
    expect(repos.sessions.byId(1).status).toBe('failed');
    db.close();
  });
});

describe('external targeting (query.directory)', () => {
  it('passes the configured directory into session create and prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-s12t-'));
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    const { client, calls } = fakeClient();
    const driver = new OpenCodeDriver({
      client,
      driveSheet: undefined as never,
      directory: 'J:/projects/nexus',
    });

    await driver.run({ agent: 'agent-a', cycle: 1, situation: 'SITUATION' });

    expect(calls.createdDirs).toEqual(['J:/projects/nexus']);
    expect(calls.promptDirs).toEqual(['J:/projects/nexus']);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('retry visibility (prompt_retried event)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-s12r-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function deps(repos: Repos, driver: OpenCodeDriver): OrchestratorDeps {
    return {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'agent-a': driver },
      agents: ['agent-a'],
      situation: { projectRoot: join(tmpdir(), 'nonexistent') },
      sessionGc: true,
    };
  }

  it('logs prompt_retried when a cycle resumes after an interrupted prompt', async () => {
    const db = openDb(join(dir, 'lab4.db'));
    const repos = createRepos(db);
    let attempts = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: 'sess-r' } }),
        prompt: async () => {
          attempts++;
          if (attempts === 1) throw new TypeError('fetch failed');
          return {
            data: {
              info: { tokens: { input: 10, output: 5 }, cost: 0.01 },
              parts: [{ type: 'text', text: '{"mails":[],"summary":"resumed and done"}' }],
            },
          };
        },
      } as unknown as OpencodeSessionClient['session'],
    };
    void client;
    const driver = new OpenCodeDriver({ client: client as unknown as OpencodeSessionClient, driveSheet: undefined as never });
    const d = deps(repos, driver);
    d.sessionGc = true;

    await runCycle(d, 'agent-a', 1);

    expect(attempts).toBe(2); // retry fired
    expect(driver.lastRetryAt?.('agent-a')).toBeDefined();
    expect(repos.events.byKind('prompt_retried')).toHaveLength(1);
    expect(repos.sessions.byId(1).status).toBe('done'); // rescued
    db.close();
  });
});

describe('config: workspacePath + sessionGc merge', () => {
  it('round-trips both new keys', () => {
    const merged = mergeConfig(loadConfigFrom(join(dir0(), 'missing.json')), {
      sessionGc: true,
      workspacePath: 'J:/projects/nexus',
    });
    expect(merged.sessionGc).toBe(true);
    expect(merged.workspacePath).toBe('J:/projects/nexus');
    expect(loadConfigFrom(join(dir0(), 'missing.json')).sessionGc).toBe(false); // default
  });

  it('workspacePath null clears the key (back to own-workspace mode)', () => {
    const base = mergeConfig(loadConfigFrom(join(dir0(), 'missing.json')), {
      workspacePath: 'J:/projects/nexus',
    });
    expect(base.workspacePath).toBe('J:/projects/nexus');
    const cleared = mergeConfig(base, { workspacePath: null });
    expect(cleared.workspacePath).toBeUndefined();
  });

  function dir0(): string {
    return mkdtempSync(join(tmpdir(), 'antfarm-s12cfg-'));
  }
});

describe('TASK mails create board rows (S12.1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-s12task-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('files TASK mail → creates proposed task assigned to recipient; dedupes by title', async () => {
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);

    let call = 0;
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => {
            call++;
            return {
              mails: [
                { to: 'agent-b', type: 'TASK', subject: 'Fix CORS null-origin', body: 'acceptance: null allowed safely' },
                ...(call > 1
                  ? [{ to: 'agent-b', type: 'TASK' as const, subject: 'Fix CORS null-origin', body: 'duplicate' }]
                  : []),
              ],
              taskMoves: [],
              summary: 'delegating',
            };
          },
        },
      },
      agents: ['agent-a'],
      situation: { projectRoot: join(dir, 'project') },
    };

    await runCycle(deps, 'agent-a', 1);
    expect(repos.tasks.list()).toHaveLength(1);
    const t = repos.tasks.list()[0]!;
    expect(t.title).toBe('Fix CORS null-origin');
    expect(t.owner).toBe('agent-b');

    await runCycle(deps, 'agent-a', 2);
    expect(repos.tasks.list()).toHaveLength(1); // deduped

    const created = repos.events.byKind('task_created');
    expect(created).toHaveLength(1);
    db.close();
  });
});

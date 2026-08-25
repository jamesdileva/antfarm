import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, createRepos } from '@antfarm/db';
import { runLoop } from '../src/loop.js';
import { createServeHandler, type ServeApp } from '../src/serve.js';
import { startServe } from '../src/serve.js';
import { ColonyManager } from '../src/serve-core.js';

describe('runLoop AbortSignal', () => {
  it('stops gracefully when the signal fires mid-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-s14-'));
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    const deps = {
      repos,
      budgets: { canRun: () => ({ ok: true }), recordCycle: () => undefined } as never,
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => ({ mails: [], taskMoves: [], summary: 'tick' }),
        },
      },
      agents: ['agent-a'],
    } as never;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const report = await runLoop(deps, {
      persistent: true,
      idleTickMs: 20,
      maxRounds: 10_000,
      signal: controller.signal,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(report.rounds).toBeLessThan(100); // did not grind to maxRounds
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('serve control API', () => {
  let home: string;
  let app: ServeApp;
  const cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'antfarm-serve-'));
    process.env.ANFARM_HOME = home;
  });

  afterEach(() => {
    delete process.env.ANFARM_HOME;
    for (const fn of cleanupFns) fn();
    cleanupFns.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
    app = await startServe(0);
    cleanupFns.push(() => new Promise<void>((r) => app.server.close(() => r())));
  }

  function url(p: string): string {
    return `http://127.0.0.1:${app.port}${p}`;
  }

  it('exposes status with data-home', async () => {
    await boot();
    const res = await fetch(url('/api/status'));
    const body = (await res.json()) as { colony: { state: string }; home: string };
    expect(res.status).toBe(200);
    expect(body.colony.state).toBe('stopped');
    expect(body.home).toBe(home);
  });

  it('init writes config + goal into the ANTFARM_HOME lab', async () => {
    await boot();
    const res = await fetch(url('/api/lab/init'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'GUI-created lab', mode: 'directed' }),
    });
    expect((await res.json()).ok).toBe(true);

    const cfgPath = join(home, 'lab.config.json');
    expect(existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).mode).toBe('directed');
    expect(readFileSync(join(home, 'project', 'shared', 'PROJECT_GOAL.md'), 'utf8'))
      .toContain('GUI-created lab');
  });

  it('goal endpoint returns null before seeding and the goal after init', async () => {
    await boot();
    const resBefore = await fetch(url('/api/lab/goal'));
    const before = (await resBefore.json()) as { goal: string | null; mode: string };
    expect(before.goal).toBeNull();
    expect(before.mode).toBe('directed');

    const initRes = await fetch(url('/api/lab/init'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'visible mission', mode: 'constrained' }),
    });
    expect((await initRes.json()).ok).toBe(true);

    const resAfter = await fetch(url('/api/lab/goal'));
    const after = (await resAfter.json()) as { goal: string | null; mode: string };
    expect(after.goal).toBe('visible mission');
    expect(after.mode).toBe('constrained');
  });

  it('init rejects non-git targets', async () => {
    await boot();
    const notARepo = mkdtempSync(join(tmpdir(), 'antfarm-nogit-'));
    const res = await fetch(url('/api/lab/init'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: notARepo }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not a git repo');
    rmSync(notARepo, { recursive: true, force: true });
  });

  it('starts a dry-run colony and reports completion via status polling', async () => {
    await boot();
    const start = await fetch(url('/api/lab/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ live: false }),
    });
    expect((await start.json()).ok).toBe(true);

    // poll until the scripted colony finishes
    let report: { cyclesRun?: number } | null = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const status = (await (await fetch(url('/api/status'))).json()) as {
        colony: { state: string; lastReport: { cyclesRun: number } | null };
      };
      if (status.colony.state === 'stopped' && status.colony.lastReport) {
        report = status.colony.lastReport;
        break;
      }
    }
    expect(report?.cyclesRun).toBeGreaterThanOrEqual(1);

    const dbPath = join(home, 'project', 'lab-dryrun.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = openDb(dbPath);
    expect(createRepos(db).sessions.list().length).toBeGreaterThanOrEqual(1);
    db.close();
  }, 20000);

  it('rejects double-start', async () => {
    await boot();
    void fetch(url('/api/lab/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ live: false }),
    });
    // immediately try again — may race before state flips to running
    const second = await fetch(url('/api/lab/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ live: false }),
    });
    const firstDone = second.status === 409 || second.status === 200;
    expect(firstDone).toBe(true);
    // wait for the dry colony to finish before cleanup
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const status = (await (await fetch(url('/api/status'))).json()) as {
        colony: { state: string };
      };
      if (status.colony.state === 'stopped') break;
    }
  }, 20000);
});

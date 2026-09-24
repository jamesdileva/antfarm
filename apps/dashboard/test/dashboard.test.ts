import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db } from '@antfarm/db';
import { handle, startDashboard } from '../src/main.js';

describe('dashboard server', () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-dash-'));
    dbPath = join(dir, 'lab.db');
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function fakeRes(): {
    out: { status: number; body: string };
    res: { writeHead: (c: number, h?: Record<string, string>) => void; end: (b?: string) => void };
  } {
    const out = { status: 0, body: '' };
    return {
      out,
      res: {
        writeHead: (c) => {
          out.status = c;
        },
        end: (b) => {
          out.body = b ?? '';
        },
      },
    };
  }

  it('serves view JSON on /api/view and HTML on /', async () => {
    const repos = createRepos(db);
    repos.tasks.create('human', { title: 'seed task' });

    const route = handle(dbPath);

    const api = fakeRes();
    route({ url: '/api/view' } as never, api.res as never);
    expect(api.out.status).toBe(200);
    const view = JSON.parse(api.out.body) as { board: unknown[] };
    expect(view.board).toHaveLength(1);

    const html = fakeRes();
    route({ url: '/' } as never, html.res as never);
    expect(html.out.status).toBe(200);
    expect(html.out.body).toContain('ANTFARM');

    const missing = fakeRes();
    route({ url: '/nope' } as never, missing.res as never);
    expect(missing.out.status).toBe(404);
  });

  it('returns a fresh empty view (200) when the lab db does not exist yet', async () => {
    const route = handle(join(dir, 'missing.db'));
    const res = fakeRes();
    route({ url: '/api/view' } as never, res.res as never);
    expect(res.out.status).toBe(200);
    const body = JSON.parse(res.out.body) as { fresh: boolean; agents: unknown[] };
    expect(body.fresh).toBe(true);
    expect(body.agents).toHaveLength(2);
  });

  it('starts a real HTTP server and answers fetches', async () => {
    const server = await startDashboard(dbPath, 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/view`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { agents: unknown[] };
    expect(view.agents).toHaveLength(2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function postSettings(configPath: string, body: string): Promise<{ status: number; json: unknown }> {
    const route = handle(dbPath, configPath);
    return new Promise((resolve) => {
      const handlers: Record<string, Array<(arg?: never) => void>> = {};
      const req = {
        url: '/api/settings',
        method: 'POST',
        on: (ev: string, fn: (arg?: never) => void) => {
          (handlers[ev] ??= []).push(fn);
          return req;
        },
      };
      const { out, res } = fakeRes();
      route(req as never, res as never);
      for (const h of handlers['data'] ?? []) h(body as never);
      for (const h of handlers['end'] ?? []) h();
      // handler is synchronous after 'end'
      resolve({ status: out.status, json: JSON.parse(out.body || '{}') as unknown });
    });
  }

  it('rejects privileged keys and invalid values on /api/settings', async () => {
    const configPath = join(dir, 'lab.config.json');

    for (const patch of [
      { harness: { buildCmd: 'powershell -c evil' } },
      { personalities: { 'agent-a': 'do crimes' } },
      { projectRoot: '/elsewhere' },
    ]) {
      const res = await postSettings(configPath, JSON.stringify(patch));
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toContain('not writable via the network API');
    }

    for (const patch of [
      { budgets: { maxTokensPerCycle: -5, maxCyclesPerHour: 30 } },
      { budgets: { maxTokensPerCycle: 1000, maxCyclesPerHour: 0 } },
      { workspacePath: 'relative/path' },
      { model: 'x'.repeat(201) },
      { idleTickMs: 50 },
      { sessionGc: 'yes' },
    ]) {
      const res = await postSettings(configPath, JSON.stringify(patch));
      expect(res.status).toBe(400);
    }
    // no config file was created by rejected writes
    expect(existsSync(configPath)).toBe(false);
  });

  it('accepts a valid settings patch', async () => {
    const configPath = join(dir, 'lab.config.json');
    const res = await postSettings(
      configPath,
      JSON.stringify({ model: 'test/model', budgets: { maxTokensPerCycle: 5000, maxCyclesPerHour: 10 } })
    );
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });
});

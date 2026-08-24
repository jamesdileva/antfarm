import { mkdtempSync, rmSync } from 'node:fs';
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
});

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { handle as dashboardHandle } from '@antfarm/dashboard';
import { ColonyManager, initLab, currentConfig, configPath, humanMail, humanTask, listAgents } from './serve-core.js';
import { homePaths } from './home.js';
import { readGoal, seedGoal } from './goal.js';
import { archiveLab, resetLab } from './archive.js';

export interface ServeApp {
  server: Server;
  manager: ColonyManager;
  port: number;
}

/**
 * API bearer token (audit C1): the shell mints one per launch and hands it
 * to the backend (env) and to the dashboard (loadURL query); the dashboard
 * JS attaches it as a header on every API call. CLI serve prints it for
 * curl users; e2e sets it explicitly. Random per process unless provided.
 */
function resolveApiToken(): string {
  const fromEnv = process.env.ANTFARM_API_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return randomBytes(16).toString('hex');
}

const API_TOKEN = resolveApiToken();

/** Current process token — tests and the shell health probe use this. */
export function apiToken(): string {
  return API_TOKEN;
}

/** Header or `?token=` query — the latter exists because EventSource and
 * the initial page load cannot set headers. Secrecy of the random token
 * (never exposed cross-origin: no ACAO headers anywhere) is the defense;
 * an attacker that cannot read it cannot replay it. */
export function tokenOk(req: IncomingMessage): boolean {
  const h = req.headers['x-antfarm-token'];
  if (typeof h === 'string' && h.length > 0 && h === API_TOKEN) return true;
  const q = (req.url ?? '').split('?')[1] ?? '';
  const m = q.match(/(?:^|&)token=([^&]*)/);
  try {
    if (m && decodeURIComponent(m[1]!) === API_TOKEN) return true;
  } catch {
    /* malformed encoding — not authorized */
  }
  return false;
}

/** Control routes take precedence; everything else falls through to the dashboard UI. */
export function createServeHandler(manager: ColonyManager): (req: IncomingMessage, res: ServerResponse) => void {
  const delegate = dashboardHandle(labDb(), configPath());

  const CONTROL_ROUTES: Record<string, 'GET' | 'POST'> = {
    '/api/status': 'GET',
    '/api/lab/goal': 'GET',
    '/api/lab/agents': 'GET',
    '/api/lab/init': 'POST',
    '/api/lab/start': 'POST',
    '/api/lab/stop': 'POST',
    '/api/lab/archive': 'POST',
    '/api/lab/reset': 'POST',
    '/api/human/mail': 'POST',
    '/api/human/task': 'POST',
  };

  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    const method = req.method ?? 'GET';
    const controlMethod = CONTROL_ROUTES[url];

    // only KNOWN control routes are intercepted — everything else
    // (dashboard UI, /api/view, /api/settings) delegates normally
    if (!controlMethod || controlMethod !== method) {
      delegate(req, res);
      return;
    }

    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fail = (err: unknown): void => {
      console.error(`serve ${method} ${url} failed:`, err);
      if (!res.writableEnded) json(500, { ok: false, error: 'internal error' });
    };
    /** Body pipeline: malformed bodies → 400, handler throws → 500. */
    const withBody = (fn: (body: Record<string, unknown>) => void): void => {
      readJsonBody(req).then(
        (body) => {
          try {
            fn(body);
          } catch (err) {
            fail(err);
          }
        },
        (err) => json(400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      );
    };

    // DNS-rebinding guard: this server only ever serves loopback clients.
    // A rebinding page reaches us with Host: <attacker-domain> — refuse it.
    const host = (req.headers.host ?? '').split(':')[0]!.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      json(403, { ok: false, error: 'forbidden' });
      return;
    }

    // Bearer token on EVERYTHING the serve handler touches — control routes
    // and the delegated dashboard UI/view/stream/settings alike (the
    // standalone `npm run dashboard` server stays open by design; it serves
    // no mutating colony endpoints beyond local settings).
    if (!tokenOk(req)) {
      json(401, { ok: false, error: 'unauthorized: valid x-antfarm-token header or ?token= required' });
      return;
    }

    if (url === '/api/status') {
      // absolute home path deliberately withheld (recon aid, audit M5)
      json(200, { colony: manager.status() });
      return;
    }
    if (url === '/api/lab/goal') {
      const cfg = currentConfig();
      const paths = homePaths(cfg.projectRoot);
      const wsGoalPath = join(cfg.workspacePath ?? join(paths.project, 'workspace'), 'PROJECT_GOAL.md');
      let workspaceGoal: string | null = null;
      try {
        workspaceGoal = readFileSync(wsGoalPath, 'utf8').trim() || null;
      } catch { /* no self-authored goal yet */ }
      json(200, { goal: readGoal(paths.project), mode: cfg.mode, workspaceGoal });
      return;
    }
    if (url === '/api/lab/agents') {
      json(200, { agents: listAgents() });
      return;
    }
    if (url === '/api/lab/init') {
      withBody((body) => {
        const goal = typeof body.goal === 'string' ? body.goal : undefined;
        const mode = body.mode === 'constrained' || body.mode === 'directed' ? body.mode : undefined;
        const target = typeof body.target === 'string' ? body.target : undefined;
        const clearGoal = body.clearGoal === true;
        const result = initLab({ goal, mode, target, clearGoal });
        json(result.ok ? 200 : 400, result);
      });
      return;
    }
    if (url === '/api/lab/start') {
      withBody((body) => {
        void manager.start(body.live === true).then((result) =>
          json(result.ok ? 200 : 409, result), fail
        );
      });
      return;
    }
    if (url === '/api/lab/archive') {
      if (manager.status().state !== 'stopped') {
        json(409, { ok: false, error: `colony is ${manager.status().state} — stop it before archiving` });
        return;
      }
      const result = archiveLab(currentConfig());
      json(result.ok ? 200 : 400, result);
      return;
    }
    if (url === '/api/lab/reset') {
      withBody((body) => {
        if (manager.status().state !== 'stopped') {
          json(409, { ok: false, error: `colony is ${manager.status().state} — stop it before resetting` });
          return;
        }
        // parity with CLI reset: snapshot before wipe (best effort)
        const archived = archiveLab(currentConfig());
        // fail-closed: the destructive scope must be explicit — an empty or
        // unparseable body must NEVER wipe anything (audit C2).
        if (body.all !== true && body.all !== false) {
          json(400, { ok: false, error: 'specify "all": true (wipe everything) or false (database only)' });
          return;
        }
        const result = resetLab(currentConfig(), body.all);
        json(result.ok ? 200 : 400, { ...result, archivedAt: archived.ok ? archived.path : undefined });
      });
      return;
    }
    if (url === '/api/human/mail') {
      withBody((body) => {
        const result = humanMail({
          to: typeof body.to === 'string' ? body.to : undefined,
          type: typeof body.type === 'string' ? body.type : undefined,
          subject: typeof body.subject === 'string' ? body.subject : undefined,
          body: typeof body.body === 'string' ? body.body : '',
        });
        json(result.ok ? 200 : 400, result);
      });
      return;
    }
    if (url === '/api/human/task') {
      withBody((body) => {
        const result = humanTask({
          title: typeof body.title === 'string' ? body.title : undefined,
          owner: typeof body.owner === 'string' ? body.owner : '',
        });
        json(result.ok ? 200 : 400, result);
      });
      return;
    }
    // /api/lab/stop
    void manager.stop().then((result) => json(result.ok ? 200 : 409, result), fail);
  };}

function labDb(): string {
  return homePaths(currentConfig().projectRoot).db();
}

/** Strict JSON body reader (audit M3/C2): capped size, JSON content-type
 * required (blocks preflight-less CSRF form posts), parse failure rejects
 * so handlers answer 400 instead of acting on a defaulted `{}`. */
const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (ctype !== 'application/json') {
      reject(new Error('content-type must be application/json'));
      req.resume();
      return;
    }
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let raw = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done(() => reject(new Error('request body too large (max 256KB)')));
        req.destroy();
        return;
      }
      raw += chunk.toString();
    });
    req.on('end', () => {
      done(() => {
        try {
          const parsed: unknown = JSON.parse(raw || '{}');
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error('request body must be a JSON object'));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error('request body is not valid JSON'));
        }
      });
    });
    req.on('error', (err) => done(() => reject(err)));
  });
}

export async function startServe(port = 4177): Promise<ServeApp> {
  const manager = new ColonyManager();
  return new Promise((resolvePromise) => {
    const server = createServer(createServeHandler(manager));
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise({ server, manager, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}

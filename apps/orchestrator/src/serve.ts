import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { handle as dashboardHandle } from '@antfarm/dashboard';
import { ColonyManager, initLab, currentConfig, configPath, humanMail, humanTask } from './serve-core.js';
import { antfarmHome, homePaths } from './home.js';
import { readGoal, seedGoal } from './goal.js';
import { archiveLab, resetLab } from './archive.js';

export interface ServeApp {
  server: Server;
  manager: ColonyManager;
  port: number;
}

/** Control routes take precedence; everything else falls through to the dashboard UI. */
export function createServeHandler(manager: ColonyManager): (req: IncomingMessage, res: ServerResponse) => void {
  const delegate = dashboardHandle(labDb(), configPath());

  const CONTROL_ROUTES: Record<string, 'GET' | 'POST'> = {
    '/api/status': 'GET',
    '/api/lab/goal': 'GET',
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
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (url === '/api/status') {
      json(200, { colony: manager.status(), home: antfarmHome() });
      return;
    }
    if (url === '/api/lab/goal') {
      const paths = homePaths(currentConfig().projectRoot);
      json(200, { goal: readGoal(paths.project), mode: currentConfig().mode });
      return;
    }
    if (url === '/api/lab/init') {
      readBody(req).then((body) => {
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
      readBody(req).then((body) => {
        void manager.start(body.live === true).then((result) =>
          json(result.ok ? 200 : 409, result)
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
      readBody(req).then((body) => {
        if (manager.status().state !== 'stopped') {
          json(409, { ok: false, error: `colony is ${manager.status().state} — stop it before resetting` });
          return;
        }
        // parity with CLI reset: snapshot before wipe (best effort)
        const archived = archiveLab(currentConfig());
        const result = resetLab(currentConfig(), body.all !== false);
        json(result.ok ? 200 : 400, { ...result, archivedAt: archived.ok ? archived.path : undefined });
      });
      return;
    }
    if (url === '/api/human/mail') {
      readBody(req).then((body) => {
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
      readBody(req).then((body) => {
        const result = humanTask({
          title: typeof body.title === 'string' ? body.title : undefined,
          owner: typeof body.owner === 'string' ? body.owner : '',
        });
        json(result.ok ? 200 : 400, result);
      });
      return;
    }
    // /api/lab/stop
    void manager.stop().then((result) => json(result.ok ? 200 : 409, result));
  };}

function labDb(): string {
  return homePaths(currentConfig().projectRoot).db();
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(raw || '{}') as Record<string, unknown>);
      } catch {
        resolvePromise({});
      }
    });
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

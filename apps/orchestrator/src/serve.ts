import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { handle as dashboardHandle } from '@antfarm/dashboard';
import { ColonyManager, initLab, currentConfig, configPath } from './serve-core.js';
import { antfarmHome, homePaths } from './home.js';

export interface ServeApp {
  server: Server;
  manager: ColonyManager;
  port: number;
}

/** Control routes take precedence; everything else falls through to the dashboard UI. */
export function createServeHandler(manager: ColonyManager): (req: IncomingMessage, res: ServerResponse) => void {
  const delegate = dashboardHandle(labDb(), configPath());

  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (!url.startsWith('/api/')) {
      delegate(req, res);
      return;
    }

    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (url === '/api/status' && req.method === 'GET') {
      json(200, { colony: manager.status(), home: antfarmHome() });
      return;
    }
    if (url === '/api/lab/init' && req.method === 'POST') {
      readBody(req).then((body) => {
        const goal = typeof body.goal === 'string' ? body.goal : undefined;
        const mode = body.mode === 'constrained' || body.mode === 'directed' ? body.mode : undefined;
        const target = typeof body.target === 'string' ? body.target : undefined;
        const result = initLab({ goal, mode, target });
        json(result.ok ? 200 : 400, result);
      });
      return;
    }
    if (url === '/api/lab/start' && req.method === 'POST') {
      readBody(req).then((body) => {
        void manager.start(body.live === true).then((result) =>
          json(result.ok ? 200 : 409, result)
        );
      });
      return;
    }
    if (url === '/api/lab/stop' && req.method === 'POST') {
      void manager.stop().then((result) => json(result.ok ? 200 : 409, result));
      return;
    }
    json(404, { error: `unknown control route ${url}` });
  };
}

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

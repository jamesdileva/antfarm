import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildView, type ObserverView } from '@antfarm/observer-cli';

export function labDbPath(): string {
  if (existsSync('lab.db')) return 'lab.db';
  return join('project', 'lab.db');
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Route handler — factored out for tests. */
export function handle(dbPath: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/api/view') {
      // better-sqlite3 would happily create an empty db — refuse instead
      if (!existsSync(dbPath)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no lab database at ${dbPath}` }));
        return;
      }
      try {
        const body = JSON.stringify(buildView(dbPath));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((err as Error).message) }));
      }
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

export function startDashboard(dbPath: string, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handle(dbPath));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>antfarm — live whiteboard</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#c9d1d9; font-family: Consolas, monospace; margin:24px; }
  h1 { font-size:18px; color:#58a6ff; margin:0 0 4px; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:16px; }
  section { border:1px solid #30363d; border-radius:6px; padding:12px 16px; margin-bottom:14px; }
  h2 { font-size:13px; color:#58a6ff; margin:0 0 8px; text-transform:uppercase; letter-spacing:1px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td, th { text-align:left; padding:3px 10px 3px 0; }
  th { color:#8b949e; font-weight:normal; }
  .done { color:#3fb950; } .failed, .timed_out { color:#f85149; }
  .never { color:#8b949e; } .active { color:#d29922; } .blocked { color:#f85149; }
  .muted { color:#8b949e; } .err { color:#f85149; padding:12px; }
</style>
</head>
<body>
<h1>ANTFARM</h1>
<div class="sub">live whiteboard · read-only · polls /api/view every second</div>
<section><h2>Agents</h2><table id="agents"></table></section>
<section><h2>Latest mail</h2><table id="mail"></table></section>
<section><h2>Task board</h2><table id="board"></table></section>
<section><h2>Checks &amp; decisions</h2><table id="checks"></table></section>
<section><h2>Recent events</h2><table id="events"></table></section>
<script>
const cls = (s) => ({done:'done', failed:'failed', timed_out:'timed_out', never:'never',
                     active:'active', blocked:'blocked'}[String(s)] ?? '');
async function refresh() {
  try {
    const v = await (await fetch('/api/view')).json();
    if (v.error) { document.body.innerHTML = '<div class="err">lab busy: ' + esc(v.error) + '</div>'; return; }
    document.getElementById('agents').innerHTML = v.agents.map(a =>
      '<tr><th>' + esc(a.agent) + '</th><td class="' + cls(a.status) + '">' + esc(a.status) +
      '</td><td>' + a.cycles + ' cycles</td><td class="muted">"' + esc(a.lastSession || '') + '"</td></tr>').join('');
    document.getElementById('mail').innerHTML = v.latestMail.map(m =>
      '<tr><td>#' + m.id + '</td><td>' + esc(m.type) + '</td><td>' + esc(m.from) + ' → ' + esc(m.to) +
      '</td><td>' + esc(m.subject) + '</td></tr>').join('') || '<tr><td class="muted">(no mail yet)</td></tr>';
    document.getElementById('board').innerHTML = v.board.map(t =>
      '<tr><td>#' + t.id + '</td><td class="' + cls(t.state) + '">[' + esc(t.state) + ']</td><td>' + esc(t.title) +
      '</td><td class="muted">' + esc(t.owner ?? 'unowned') + '</td></tr>').join('')
      || '<tr><td class="muted">(empty)</td></tr>';
    document.getElementById('checks').innerHTML =
      '<tr><th>build</th><td>' + esc(v.checks.build) + '</td></tr>' +
      '<tr><th>test</th><td>' + esc(v.checks.test) + '</td></tr>' +
      '<tr><th>decisions</th><td>' + v.decisions + ' logged</td></tr>';
    document.getElementById('events').innerHTML = v.recentEvents.map(e =>
      '<tr><td>[' + esc(e.kind) + ']</td><td>' + esc(e.actor) + '</td></tr>').join('');
  } catch (err) { /* transient — poll again */ }
}
setInterval(refresh, 1000);
refresh();
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
</script>
</body>
</html>`;
}

// entrypoint
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('apps/dashboard/src/main.ts')) {
  const path = labDbPath();
  if (!existsSync(path)) {
    console.error(`no lab database at ${path} — run the orchestrator first`);
    process.exit(1);
  }
  const port = Number(process.env.ANTFARM_DASHBOARD_PORT ?? 4177);
  void startDashboard(path, port).then(() => {
    console.log(`antfarm dashboard: http://127.0.0.1:${port} (watching ${path})`);
  });
}

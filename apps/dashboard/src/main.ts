import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@antfarm/db';
import { buildView, type ObserverView } from '@antfarm/observer-cli';
import { loadConfigFrom, mergeConfig, type LabConfig } from '@antfarm/orchestrator/config.js';
import { antfarmHome } from '@antfarm/orchestrator/home.js';

export function labDbPath(): string {
  const candidate = join(antfarmHome(), 'project', 'lab.db');
  return existsSync(candidate) ? candidate : 'project/lab.db';
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Route handler — factored out for tests. */
export function handle(dbPath: string, configPath = join(antfarmHome(), 'lab.config.json')): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/api/settings') {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        req.on('end', () => {
          try {
            const patch = JSON.parse(raw || '{}') as Record<string, unknown>;
            // merge over the CURRENT file so unrelated keys survive
            const merged = mergeConfig(loadConfigFrom(configPath), patch);
            writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config: merged }));
          } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((err as Error).message) }));
          }
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(loadConfigFrom(configPath)));
      return;
    }
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
    if (url === '/api/stream') {
      // SSE: push a tick whenever new events land; page refreshes its view
      if (!existsSync(dbPath)) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let closed = false;
      const timer = setInterval(() => {
        if (closed) return;
        try {
          const db = openDb(dbPath);
          const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
          db.close();
          res.write(`data: ${JSON.stringify({ totalEvents: row.n })}\n\n`);
        } catch {
          /* db busy between writer cycles — skip tick */
        }
      }, 1000);
      req.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
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
<section data-testid="colony-panel">
<h2>Colony control</h2>
<div class="sub">serve mode only (npm start -- serve) — CLI runs are managed by their own terminal</div>
<button id="start-dry" data-testid="colony-start-dry">Start dry-run</button>
<button id="start-live" data-testid="colony-start-live">Start live</button>
<button id="stop" data-testid="colony-stop">Stop</button>
<span id="colony-state" data-testid="colony-status"></span>
<span id="control-msg"></span>
</section>
<section><h2>Agents</h2><table id="agents" data-testid="agents-panel"></table></section>
<section><h2>Latest mail</h2><table id="mail" data-testid="mail-panel"></table></section>
<section><h2>Task board</h2><table id="board" data-testid="board-panel"></table></section>
<section><h2>Checks &amp; decisions</h2><table id="checks"></table></section>
<section><h2>Recent events</h2><table id="events"></table></section>
<section>
<h2>Usage</h2>
<table id="usage"></table>
<div class="sub" style="margin-top:6px">recent sessions</div>
<table id="sessions"></table>
</section>
<section>
<h2>Settings</h2>
<div class="sub">saved to lab.config.json — applies on the next orchestrator start</div>
<table>
<tr><th>model</th><td><input id="s-model" placeholder="provider/model (blank = opencode default)" style="width:340px"></td></tr>
<tr><th>maxTokensPerCycle</th><td><input id="s-tokens" type="number" min="1000"></td></tr>
<tr><th>maxCyclesPerHour</th><td><input id="s-cycles" type="number" min="1"></td></tr>
<tr><th>workspacePath</th><td><input id="s-ws" placeholder="external repo (blank = project/workspace)" style="width:340px"></td></tr>
<tr><th>sessionGc</th><td><input id="s-gc" type="checkbox"> delete opencode sessions after capture</td></tr>
<tr><th>idleTickMs</th><td><input id="s-idle" type="number" min="5000"></td></tr>
<tr><th>exhaustionCooldownMs</th><td><input id="s-cool" type="number" min="0"></td></tr>
</table>
<button id="save">Save settings</button>
<span id="save-msg"></span>
</section>
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
    document.getElementById('usage').innerHTML = v.usage.map(u =>
      '<tr><th>' + esc(u.agent) + '</th><td>' + u.cycles + ' cycles</td><td>' +
      u.tokens.toLocaleString() + ' tokens</td><td>$' + u.cost.toFixed(4) + '</td><td class="muted">' +
      esc(u.models.join(', ') || 'n/a') + '</td></tr>').join('') || '<tr><td class="muted">(no usage yet)</td></tr>';
    document.getElementById('sessions').innerHTML = v.recentSessions.map(s =>
      '<tr><td>#' + s.id + '</td><td>' + esc(s.agent) + '</td><td class="' + cls(s.status) + '">' + esc(s.status) +
      '</td><td>c' + s.cycle + '</td><td>' + (s.tokensIn + s.tokensOut).toLocaleString() + ' tok</td><td>$' +
      s.cost.toFixed(4) + '</td><td class="muted">' + esc(s.model || '') + '</td></tr>').join('')
      || '<tr><td class="muted">(none)</td></tr>';
  } catch (err) { /* transient — poll again */ }
}
setInterval(refresh, 5000);
const es = new EventSource('/api/stream');
es.onmessage = refresh; // push-driven refresh on new events
refresh();
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

async function loadSettings() {
  try {
    const cfg = await (await fetch('/api/settings')).json();
    if (cfg.error !== undefined) throw new Error('settings API unavailable');
    document.getElementById('s-model').value = cfg.model ?? '';
    document.getElementById('s-ws').value = cfg.workspacePath ?? '';
    document.getElementById('s-gc').checked = cfg.sessionGc ?? false;
    document.getElementById('s-tokens').value = cfg.budgets?.maxTokensPerCycle ?? '';
    document.getElementById('s-cycles').value = cfg.budgets?.maxCyclesPerHour ?? '';
    document.getElementById('s-idle').value = cfg.idleTickMs ?? '';
    document.getElementById('s-cool').value = cfg.exhaustionCooldownMs ?? '';
  } catch {
    const msg = document.getElementById('save-msg');
    msg.textContent = 'settings unavailable — restart the dashboard (npm run dashboard)';
    msg.style.color = '#f85149';
  }
}

// colony control (serve mode)
const controlMsg = document.getElementById('control-msg');
function note(t, color) { controlMsg.textContent = t; controlMsg.style.color = color || '#8b949e'; }
async function control(endpoint, body) {
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body ?? {}) });
    const out = await res.json();
    if (!out.ok && out.error) { note('error: ' + out.error, '#f85149'); return false; }
    refresh(); return true;
  } catch (err) { note('unavailable (CLI run owns nothing here)', '#f85149'); return false; }
}
document.getElementById('start-dry').onclick = () => control('/api/lab/start', { live: false });
document.getElementById('start-live').onclick = async () => {
  if (await control('/api/lab/start', { live: true })) note('live colony starting…', '#3fb950');
};
document.getElementById('stop').onclick = () => control('/api/lab/stop');
setInterval(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    document.getElementById('colony-state').textContent = 'colony: ' + s.colony.state + (s.colony.live ? ' (live)' : '');
  } catch { /* serve mode only */ }
}, 2000);
document.getElementById('save').onclick = async () => {
  const num = (id) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const modelVal = document.getElementById('s-model').value.trim();
  const wsVal = document.getElementById('s-ws').value.trim();
  const patch = {
    ...(modelVal ? { model: modelVal } : {}),
    ...(wsVal ? { workspacePath: wsVal } : {}),
    sessionGc: document.getElementById('s-gc').checked,
    budgets: { maxTokensPerCycle: num('s-tokens'), maxCyclesPerHour: num('s-cycles') },
    idleTickMs: num('s-idle'),
    exhaustionCooldownMs: num('s-cool'),
  };
  const res = await fetch('/api/settings', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(patch) });
  const out = await res.json();
  document.getElementById('save-msg').textContent = out.ok ? 'saved ✓ (next start)' : 'error: ' + out.error;
  setTimeout(() => { document.getElementById('save-msg').textContent = ''; }, 4000);
};
loadSettings();
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

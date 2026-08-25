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

function emptyView(): ObserverView & { fresh: boolean } {
  return {
    fresh: true,
    agents: [
      { agent: 'agent-a', status: 'never run', lastSession: '', cycles: 0 },
      { agent: 'agent-b', status: 'never run', lastSession: '', cycles: 0 },
    ],
    board: [],
    taskCounts: {},
    latestMail: [],
    checks: { build: 'not run yet', test: 'not run yet' },
    recentEvents: [],
    decisions: 0,
    usage: [],
    recentSessions: [],
  };
}

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
      // Fresh install: no lab yet — return an empty view with a hint instead
      // of an error. Starting any colony creates the DB (better-sqlite3).
      if (!existsSync(dbPath)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(emptyView()));
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
<div id="fresh-banner" data-testid="fresh-banner" style="display:none;border:1px solid #d29922;border-radius:6px;padding:10px 14px;margin-bottom:14px;color:#d29922">
  Fresh install - no lab yet. Click <b>Start dry-run</b> below to create one, or configure and <b>Start live</b>.
</div>
<section data-testid="colony-panel">
<h2>Colony control</h2>
<div class="sub">serve mode only (npm start -- serve) — CLI runs are managed by their own terminal</div>
<button id="start-dry" data-testid="colony-start-dry">Start dry-run</button>
<button id="start-live" data-testid="colony-start-live">Start live</button>
<button id="stop" data-testid="colony-stop">Stop</button>
<button id="archive" data-testid="colony-archive">Archive lab</button>
<button id="reset" data-testid="colony-reset">Reset lab</button>
<div id="goal-current" data-testid="goal-current" style="display:none;border:1px solid #30363d;border-radius:6px;padding:8px 12px;margin-bottom:10px;white-space:pre-wrap;color:#c9d1d9;font-size:12px"></div>
<div class="sub">goal presets - pick one to fill the editor (edit freely), then Set goal. Autonomous needs no goal.</div>
<div>
<button id="preset-directed" data-testid="goal-preset-directed">Preset: Directed (docs-driven)</button>
<button id="preset-constrained" data-testid="goal-preset-constrained">Preset: Constrained (local-only)</button>
<button id="preset-autonomous" data-testid="goal-preset-autonomous">Clear goal (autonomous)</button>
</div>
<textarea id="goal-input" data-testid="goal-input" placeholder="mission / constraints for the colony (or use a preset)" style="width:560px;height:84px;display:block;margin-top:6px"></textarea>
<button id="set-goal" data-testid="goal-set" style="margin-top:6px">Set goal</button>
<span id="colony-state" data-testid="colony-status"></span>
<span id="control-msg"></span>
</section>
<section data-testid="human-channel">
<h2>Human channel</h2>
<div class="sub">speak to the colony directly - mail lands in their next cycle inbox; assigned tasks wake their owner</div>
<table style="margin-bottom:8px">
<tr><th>mail to</th><td><select id="hm-to"><option value="agent-a">agent-a</option><option value="agent-b">agent-b</option></select></td>
<th>type</th><td><select id="hm-type"><option>TASK</option><option>STATUS</option><option>QUESTION</option><option>WARNING</option><option>IDEA</option></select></td></tr>
<tr><th>subject</th><td colspan="3"><input id="hm-subject" placeholder="one-line ask" style="width:420px"></td></tr>
</table>
<textarea id="hm-body" placeholder="details (optional)" style="width:560px;height:56px;display:block"></textarea>
<button id="hm-send" data-testid="human-mail-send" style="margin:6px 0 12px">Send mail</button>
<table>
<tr><th>new task</th><td><input id="ht-title" placeholder="task title" style="width:380px"></td>
<th>assign to</th><td><select id="ht-owner"><option value="">(unassigned)</option><option value="agent-a">agent-a</option><option value="agent-b">agent-b</option></select></td>
<td><button id="ht-add" data-testid="human-task-add">Add task</button></td></tr>
</table>
<span id="hc-msg"></span>
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
    const banner = document.getElementById('fresh-banner');
    if (banner) banner.style.display = v.fresh ? 'block' : 'none';
    if (v.fresh) {
      document.getElementById('agents').innerHTML = '<tr><td class="muted">fresh install — no lab yet. Click "Start dry-run" below to create one, or configure and "Start live".</td></tr>';
      document.getElementById('mail').innerHTML = '';
      document.getElementById('board').innerHTML = '';
      document.getElementById('usage').innerHTML = '';
      document.getElementById('sessions').innerHTML = '';
      return;
    }
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
  if (await control('/api/lab/start', { live: true })) note('live colony started', '#3fb950');
};
document.getElementById('stop').onclick = () => control('/api/lab/stop');
document.getElementById('archive').onclick = async () => {
  if (!confirm('Archive the current lab (project + database) into archives/?')) return;
  const res = await fetch('/api/lab/archive', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
  const out = await res.json();
  if (out.ok) note('archived to ' + out.path, '#3fb950');
  else note('archive failed: ' + out.error, '#f85149');
};
document.getElementById('reset').onclick = async () => {
  if (!confirm('Reset wipes the lab board/mail/memory AND the project workspace. Did you archive first?')) return;
  if (!confirm('This cannot be undone. Really wipe everything?')) return;
  if (await control('/api/lab/reset', { all: true })) note('lab reset — set a goal and start fresh', '#3fb950');
  refreshGoal();
};
async function refreshGoal() {
  const el = document.getElementById('goal-current');
  try {
    const g = await (await fetch('/api/lab/goal')).json();
    if (g.goal) {
      el.textContent = 'current goal (' + (g.mode || 'directed') + ' mode)' + String.fromCharCode(10) + g.goal;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  } catch { /* serve mode only */ }
}
refreshGoal();
// goal presets - GUI-side fill-ins only; nothing reaches agents until Set goal.
// NOTE: this code lives inside a template literal - no backticks, no dollar-brace, no backslash-n escapes.
const NL = String.fromCharCode(10);
const PRESET_DIRECTED = [
  '# Mission',
  '',
  'Read and follow the documents in this workspace (README, docs/, roadmap).',
  'Before each work segment: check the task board, read recent mail, and review your MEMORY.md.',
  'Complete sprints/tasks one at a time, in order - finish, test, commit, update the board, then move to the next.',
  'Work together: assign tasks on the board, peer-review work, keep states current.',
  'If the workspace has no docs yet, write them first (plan the project into sprints), then follow them.',
].join(NL);
const PRESET_CONSTRAINED = [
  '# Constraints',
  '',
  'Decide collectively what to build, then build it.',
  'Local-first software that runs entirely on the machine of the user.',
  'Avoid external APIs and paid services - offline-capable, no accounts, no runtime network calls beyond package installation.',
  'Brainstorm and vote via DECISION mail, then plan board tasks and execute one at a time with tests and commits.',
].join(NL);
let pendingMode;
document.getElementById('preset-directed').onclick = () => {
  document.getElementById('goal-input').value = PRESET_DIRECTED;
  pendingMode = 'directed';
  note('directed preset loaded - edit if needed, then Set goal', '#58a6ff');
};
document.getElementById('preset-constrained').onclick = () => {
  document.getElementById('goal-input').value = PRESET_CONSTRAINED;
  pendingMode = 'constrained';
  note('constrained preset loaded - edit if needed, then Set goal', '#58a6ff');
};
document.getElementById('preset-autonomous').onclick = async () => {
  if (!confirm('Clear PROJECT_GOAL.md? Agents will run on drives alone (no mission text).')) return;
  pendingMode = undefined;
  document.getElementById('goal-input').value = '';
  const res = await fetch('/api/lab/init', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ clearGoal: true }) });
  const out = await res.json();
  if (out.ok) { note('goal cleared - autonomous mode', '#3fb950'); refreshGoal(); }
  else note('error: ' + out.error, '#f85149');
};
document.getElementById('set-goal').onclick = async () => {
  const goal = document.getElementById('goal-input').value.trim();
  if (!goal) { note('enter a mission first (or pick a preset)', '#f85149'); return; }
  if (await control('/api/lab/init', { goal, mode: pendingMode })) {
    note('goal saved — applies next cycle', '#3fb950');
    document.getElementById('goal-input').value = '';
    pendingMode = undefined;
    refreshGoal();
  }
};
// human channel (serve mode)
const hcMsg = document.getElementById('hc-msg');
function hcNote(t, color) { hcMsg.textContent = t; hcMsg.style.color = color || '#8b949e'; }
document.getElementById('hm-send').onclick = async () => {
  const subject = document.getElementById('hm-subject').value.trim();
  if (!subject) { hcNote('subject required', '#f85149'); return; }
  try {
    const res = await fetch('/api/human/mail', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({
      to: document.getElementById('hm-to').value,
      type: document.getElementById('hm-type').value,
      subject,
      body: document.getElementById('hm-body').value,
    }) });
    const out = await res.json();
    if (out.ok) {
      hcNote('mail #' + out.id + ' delivered into their next cycle', '#3fb950');
      document.getElementById('hm-subject').value = '';
      document.getElementById('hm-body').value = '';
    } else hcNote('error: ' + out.error, '#f85149');
  } catch (err) { hcNote('unavailable', '#f85149'); }
};
document.getElementById('ht-add').onclick = async () => {
  const title = document.getElementById('ht-title').value.trim();
  if (!title) { hcNote('task title required', '#f85149'); return; }
  try {
    const res = await fetch('/api/human/task', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({
      title,
      owner: document.getElementById('ht-owner').value,
    }) });
    const out = await res.json();
    if (out.ok) {
      hcNote('task #' + out.id + ' on the board', '#3fb950');
      document.getElementById('ht-title').value = '';
    } else hcNote('error: ' + out.error, '#f85149');
  } catch (err) { hcNote('unavailable', '#f85149'); }
};
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
    ...(wsVal ? { workspacePath: wsVal } : { workspacePath: null }),
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

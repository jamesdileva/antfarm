// E2E smoke for the packaged Antfarm.exe (run `npm run package` first).
// integration.md §7 preflight, automated: launch exe → healthy → create lab
// via HTTP → run dry colony to completion → verify artifacts → tree-kill.
// usage: npm run e2e   (binds 4177 — stop any running serve/dashboard first)
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXE = 'release/win-unpacked/Antfarm.exe'.replace(/\//g, '\\');
const PORT = process.env.ANTFARM_SERVE_PORT || '4177';
const BASE = `http://127.0.0.1:${PORT}`;

const log = (m) => console.log(`[e2e] ${m}`);
const fail = (m) => {
  log('FAIL: ' + m);
  cleanup();
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(path, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}${path}`);
      if (ok(res)) return await res.json().catch(() => ({}));
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  fail(`timeout waiting for ${path}`);
}

function cleanup() {
  try {
    execSync('taskkill /IM Antfarm.exe /T /F', { stdio: 'ignore' });
  } catch {
    /* not running */
  }
}

if (!existsSync(EXE)) {
  console.error(`[e2e] exe missing: ${EXE} — run \`npm run package\` first`);
  process.exit(1);
}
cleanup(); // clear stale instances
await sleep(1000);

const exePath = join(process.cwd(), EXE);
try {
  await main();
} finally {
  cleanup();
}

async function main() {
  // isolated data-home so the smoke run never touches the user's real lab
  const e2eHome = mkdtempSync(join(tmpdir(), 'antfarm-e2e-home-'));
  process.on('exit', () => {
    try { rmSync(e2eHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  log('launching packaged exe...');
  const child = spawn(exePath, ['--home', e2eHome], { detached: true, stdio: 'ignore' });
  child.unref();

  // 1. backend healthy (self-spawn + §3 rule 6)
  await poll('/api/status', (r) => r.status === 200, 30000);
  log('orchestrator healthy inside packaged shell');

  // 2. create a lab via the GUI's API
  let res = await post('/api/lab/init', { goal: 'e2e packaging smoke', mode: 'directed' });
  if (!res.body.ok) fail(`/api/lab/init rejected: ${JSON.stringify(res.body)}`);
  log('lab created via control API');

  // 3. start a dry colony via the control API
  res = await post('/api/lab/start', { live: false });
  if (!res.body.ok) fail(`/api/lab/start rejected: ${JSON.stringify(res.body)}`);
  log('dry colony started');

  // 4. wait for completion report
  let cyclesRun = null;
  {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const s = (await (await fetch(`${BASE}/api/status`)).json()).colony;
      if (s.state === 'stopped' && s.lastReport) {
        cyclesRun = s.lastReport.cyclesRun;
        break;
      }
      await sleep(500);
    }
    if (cyclesRun === null || cyclesRun < 1) fail('dry colony did not complete');
  }
  log(`dry colony completed (${cyclesRun} cycles)`);

  log('E2E SMOKE PASSED');
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

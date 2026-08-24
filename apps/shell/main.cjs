const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// integration.md §3 rule 6: self-spawning-backend pattern — the shell owns
// the orchestrator process; renderer only ever talks to its HTTP API.
let orchestrator = null;
let quitting = false;

const SERVE_PORT = Number(process.env.ANTFARM_SERVE_PORT || 4177);
const STATUS_URL = `http://127.0.0.1:${SERVE_PORT}/api/status`;

/** Repo root in dev (packaged builds will use a bundled entrypoint, S15). */
function repoRoot() {
  return path.join(__dirname, '..', '..');
}

function startOrchestrator(homeDir) {
  const root = repoRoot();
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.join(root, 'apps', 'orchestrator', 'src', 'main.ts');
  const child = spawn(process.execPath, [tsxCli, entry, 'serve'], {
    cwd: root,
    env: { ...process.env, ANTFARM_HOME: homeDir, ANTFARM_SERVE_PORT: String(SERVE_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[orchestrator] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[orchestrator] ${d}`));
  return child;
}

function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(STATUS_URL, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() > deadline) reject(new Error('orchestrator did not become healthy in time'));
        else setTimeout(poll, 500);
      }
    };
    poll();
  });
}

async function createWindow() {
  // §3 rule 4 analog: data home is a fixed sandbox dir, never __dirname/CWD
  const homeDir = path.join(app.getPath('userData'), 'antfarm-home');
  orchestrator = startOrchestrator(homeDir);

  try {
    await waitForHealthy(30000);
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Antfarm backend failed to start', String(err));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Antfarm',
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${SERVE_PORT}/`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  quitting = true;
  app.quit();
});

app.on('before-quit', () => {
  if (orchestrator && !quitting) {
    quitting = true;
    // §3 rule 7: child of the exe so taskkill /T also reaches it
    orchestrator.kill();
  }
});

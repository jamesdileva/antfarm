const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const http = require('http');
const path = require('path');

// one colony, one shell — a second exe would fight over the serve port
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// integration.md §3 rule 6: self-spawning-backend pattern — the shell owns
// the orchestrator process; renderer only ever talks to its HTTP API.
let orchestrator = null;
let quitting = false;

const SERVE_PORT = Number(process.env.ANTFARM_SERVE_PORT || 4177);
// API bearer token (audit C1): minted per shell launch (or taken from the
// environment for e2e), handed to the backend via env and to the dashboard
// via the page URL — the dashboard JS attaches it as a header afterwards.
const API_TOKEN = process.env.ANTFARM_API_TOKEN || randomBytes(16).toString('hex');
const STATUS_URL = `http://127.0.0.1:${SERVE_PORT}/api/status`;

/** Repo root in dev (packaged builds will use a bundled entrypoint, S15). */
function repoRoot() {
  return path.join(__dirname, '..', '..');
}

function startOrchestrator(homeDir) {
  // ensure the data home exists BEFORE opening logs/spawning
  require('node:fs').mkdirSync(homeDir, { recursive: true });
  const root = repoRoot();
  let entry;
  let childEnv = { ...process.env, ANTFARM_HOME: homeDir, ANTFARM_SERVE_PORT: String(SERVE_PORT), ANTFARM_API_TOKEN: API_TOKEN };
  let childCwd = root;
  if (app.isPackaged) {
    // packaged: run the bundled orchestrator with Electron-as-Node,
    // native modules resolved from shipped resources via NODE_PATH
    entry = path.join(process.resourcesPath, 'orchestrator.cjs');
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    childEnv.NODE_PATH = path.join(process.resourcesPath, 'node_modules');
    childCwd = path.join(homeDir); // never the exe dir (it is read-only-ish)
  } else {
    const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    entry = path.join(root, 'apps', 'orchestrator', 'src', 'main.ts');
    childCwd = root;
  }
  // §3 rule 8: log startup milestones — GUI apps have no visible stdio
  const logFile = path.join(homeDir, 'orchestrator.log');
  const out = require('node:fs').openSync(logFile, 'a');
  const stamp = `=== launch ${new Date().toISOString()} entry=${entry} cwd=${childCwd} ===\n`;
  require('node:fs').writeSync(out, stamp);
  const child = spawn(process.execPath, [entry, 'serve', '--home', homeDir], {
    cwd: childCwd,
    env: childEnv,
    stdio: ['ignore', out, out],
  });
  child.on('exit', (code) => {
    require('node:fs').appendFileSync(logFile, `=== exited code=${code} ===\n`);
  });
  return child;
}

function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      // Identity check, not just any-200 (audit H3): a port squatter cannot
      // produce valid colony JSON without the per-launch token.
      const req = http.get(
        STATUS_URL,
        { headers: { 'x-antfarm-token': API_TOKEN } },
        (res) => {
          let raw = '';
          res.on('data', (c) => {
            raw += c.toString();
          });
          res.on('end', () => {
            try {
              const body = JSON.parse(raw);
              if (res.statusCode === 200 && body && body.colony && typeof body.colony.state === 'string') {
                return resolve();
              }
            } catch {
              /* not our backend — keep polling */
            }
            retry();
          });
        }
      );
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
  // §3 rule 4 analog: data home is a fixed sandbox dir, never __dirname/CWD.
  // --home <dir> (or --home=<dir>) overrides userData — used by e2e/tests
  // so smoke runs never touch the user's real lab.
  const argv = process.argv.slice(app.isPackaged ? 1 : 0);
  const homeFlag = argv.indexOf('--home');
  const flagValue = homeFlag >= 0 && argv[homeFlag + 1] ? argv[homeFlag + 1] : undefined;
  const eqArg = argv.find((a) => a.startsWith('--home='));
  const homeDir = path.resolve(flagValue || (eqArg && eqArg.split('=').slice(1).join('=')) || path.join(app.getPath('userData'), 'antfarm-home'));
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // No popups / navigations away — the dashboard is a single local page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (!navUrl.startsWith(`http://127.0.0.1:${SERVE_PORT}/`)) event.preventDefault();
  });
  await win.loadURL(`http://127.0.0.1:${SERVE_PORT}/?token=${encodeURIComponent(API_TOKEN)}`);
}

process.on('uncaughtException', (err) => {
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox('Antfarm error', String(err && err.stack ? err.stack : err));
  } catch {
    /* headless */
  }
  console.error(err);
});

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

# Sprint Plan — Antfarm Desktop (Electron + Full GUI)

Status: **COMPLETE** (2026-08-24, S13–S15). E2E smoke green: packaged exe
launches own orchestrator, lab created via control API, dry colony completes,
`taskkill /T` cleanup verified.

Lessons paid for during S15:
- esbuild cjs output turns `import.meta.url` into undefined → migrations are
  now embedded TS constants (no runtime fs lookup)
- env propagation through Electron-as-Node is unreliable → data home passes
  as `--home` CLI arg instead
- `openSync(file,'a')` does not create parent dirs — mkdir home first
- copying native modules: a path-based `filter` that mentions `node_modules`
  excludes everything; copy then `rmSync` transitive deps instead
- electron-builder needs an exact electron version; prebuild-install fetched
  the official electron-ABI better-sqlite3 binary (`-r electron -t <ver>`)
- GUI apps have no stdio: orchestrator logs to `<home>/orchestrator.log`,
  shell shows error dialogs on uncaught exceptions

Decisions made:
- Shell: **Electron** — integration.md §3 playbook de-risks it
- Control scope: **full GUI** (goal-setting, start/stop, stats — no terminal needed)
- Data home: **%APPDATA%\antfarm** when packaged; repo-root fallback in dev
- Endgame: standalone tool **and** Sentinel-registered (§2 layout, §5 feature tester, §7 preflight)
- Dev CLI remains fully supported throughout

---

## S13 — ANTFARM_HOME decoupling (foundation)

All paths resolve through one resolver instead of CWD-relative constants:

```
ANTFARM_HOME env  →  home dir
  ├─ lab.config.json
  └─ project/           (cfg.projectRoot still honored as a name under home)
       └─ lab.db / lab-dryrun.db
```

Dev default (`ANTFARM_HOME` unset) = current working directory — byte-for-byte
backward compatible with existing labs.

Consumers to migrate: orchestrator (init/reset/run/nursery/stats), dashboard,
observer-cli. Exported from orchestrator for reuse (`@antfarm/orchestrator/home.js`).

Exit criteria: `ANTFARM_HOME=<fresh>` produces a brand-new isolated lab;
unset behaves identically to today; full suite green.

## S14 — Electron shell + orchestrator serve mode

Architecture prerequisite: orchestrator gains `--serve` — one long-lived
process hosting the dashboard UI **and** a control API:

| Endpoint | Purpose |
|---|---|
| `POST /api/lab/init` | `{goal, mode, target}` — replaces `init` CLI |
| `POST /api/lab/start` / `stop` | colony lifecycle, graceful abort |
| `GET /api/status` | running/stopped, budgets, last errors |

Electron shell (`apps/shell`) per integration.md §3:

- Self-spawning-backend pattern (rule 6): main spawns orchestrator `--serve`
  as child with `ANTFARM_HOME` inside the sandboxed user-data dir, waits on
  `/api/status`, then loads the window
- `.cjs` main under `"type": "module"` (rule 1); bundler `base: "./"` (rule 2)
- CORS accepts `Origin: null` on control API (rule 5)
- Child-of-exe cleanup contract (rule 7): taskkill /T reaches orchestrator
- Renderer = dashboard + control bar (New Lab wizard, Start/Stop, stats,
  nursery) with `data-testid`s shipped (§5 rule 3)

Known risks: opencode binary discovery from packaged PATH (resolver +
friendly setup screen); better-sqlite3 native rebuild vs Electron ABI.

Exit criteria: exe-in-dev launches window; New Lab wizard creates+starts a
dry-run colony without touching a terminal.

## S15 — Packaging + Sentinel preflight

- electron-builder → `release/win-unpacked/Antfarm.exe`
  (§2 gotcha: `"directories": {"output": "../release"}` relative to shell pkg)
- better-sqlite3 electron-rebuild step; smoke opens DB before healthy
- Full §7 preflight checklist
- Sentinel feature tester (Python, `electron=True`): sandboxed user-data-dir,
  CDP drives GUI — create lab, assert Agents panel populates, screenshots
  (facts-block template, §8)
- Registration: query live Sentinel DB for exact project name casing (§4);
  slug + registry import gate

Exit criteria: §7 preflight fully green; feature tester passes end-to-end.

---

### Notes

- App name `Antfarm.exe`; not yet registered in Sentinel — at registration,
  match the DB's exact title-cased folder name per §4.
- Colony runs are orthogonal: nexus targeting keeps working via Settings
  regardless of packaging.

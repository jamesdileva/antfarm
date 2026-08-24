# AGENTS.md — Antfarm

A desktop "AI laboratory": two autonomous OpenCode agents in a shared
environment (mail, task board, memory, workspace) orchestrated by a
platform, observed live. Agents decide *what* to do; the platform decides
*when*, enforces budgets, and records everything.

## Doc map

| Doc | Contents |
|-----|----------|
| `docs/idea.md` | Original vision (playground, modes 1–3) |
| `docs/lateaddition.md` | Baby-agent vision (Nursery area) |
| `docs/architecture.md` | Components, design decisions D1–D6, schema, areas |
| `docs/implementation-guide.md` | Stack, repo layout, build order, code sketches |
| `docs/roadmap.md` | Phases/sprints with exit criteria, risk register |
| `docs/sprint-12-nexus.md` | Planned: session GC + external project targeting (nexus) |
| `docs/integration.md` | Sentinel integration playbook (Tier 0 contract) — rules this repo must obey |

## Standing rules

1. **Sprint workflow:** scope the sprint into `docs/roadmap.md` first
   (goals + exit criteria), implement, tests green, then **one commit +
   push per sprint**. Never leave a sprint uncommitted across sessions.
2. **Sentinel Tier 0 contract** (`docs/integration.md` §1): every script in
   root `package.json` must run as a bare shell line from repo root with a
   neutralized PATH (`npx ...`, never bare local binaries). Fresh-clone
   `npm install` must go green unattended.
3. **Idea-neutrality** (architecture §6): platform defines protocols, never
   content. No seeded goals/purposes/hints in prompts or config — agent
   ideas must originate from agents.
4. Budgets, permissions, sandboxing are enforced mechanically by the
   orchestrator, never by prompting (decision D6).

## Tech

- TypeScript / Node, npm workspaces monorepo
- `@opencode-ai/sdk` (agent sessions), `better-sqlite3` (state),
  `simple-git`, `zod`
- **Tests:** vitest — `npm test`. (Pytest belongs to Sentinel's tester
  modules, not this repo.)

## Commands

| Command | What it does |
|---------|--------------|
| `npm install` | Install all workspaces (must succeed on fresh clone) |
| `npm run dev` | Orchestrator in watch mode |
| `npm start` | Orchestrator (`init --goal`, `reset [--yes]`, `--dry-run`, `--live`) |
| `npm run build` | Type-check/build all workspaces |
| `npm test` | Vitest suite (unit + dry-run fixtures + chaos) |
| `npm run observe` | Terminal whiteboard over the lab DB |
| `npm run dashboard` | Web whiteboard at http://127.0.0.1:4177 |

Live mode burns tokens — gate with `ANTFARM_LIVE_SMOKE=1`. The orchestrator
spawns its own OpenCode server on an ephemeral port per run.

## Commit style

Conventional-ish, short subject: `feat(mail): typed message queues`,
`fix(orchestrator): resume after kill -9`. Sprint commits may bundle, but
the subject names the phase goal.

## Worklog

| Date | Sprint | Summary | Tests | Commit |
|------|--------|---------|-------|--------|
| 2026-08-23 | pre-1 | Docs authored: architecture, implementation guide, roadmap, areas/nursery design; repo initialized | n/a (docs only) | — |
| 2026-08-23 | S1 | Orchestrator skeleton: SQLite schema/repos/events, dry-run loop w/ scripted agents, wake policy, budgets, task state machine; exit criteria met | 11/11 pass · build green · dry-run 3 cycles | 28167a8 |
| 2026-08-23 | S2 | Real OpenCode SDK driver (structured output via json_schema), drive sheets (idea-neutral), Mode 1 goal seeding, workspace git wake signals; live smoke gated by ANTFARM_LIVE_SMOKE=1 | 21/21 pass · build green · dry-run regression green | 2d064b4 |
| 2026-08-23 | S3 | Environment hardening: wall-clock cycle timeouts w/ abort hook, mail threads + escalation (once per thread), malformed-output teaching WARNING (churn-guarded), idle backoff (mail overrides), orphan recovery sweep | 30/30 pass · build green · dry-run regression green | d6ec06c |
| 2026-08-23 | S4 | lab.config.json, DECISIONS.md protocol (event log + per-agent read pointers), board ownership enforcement, chaos suite (random kill points), scheduler stall detection; Phase 2 exit criteria met | 38/38 pass · build green · dry-run regression green | 3096619 |
| 2026-08-23 | S5 | MEMORY.md compaction protocol (current + archive + file mirror, injected per cycle), stuck-task sweep to blocked (once, windowed), review-livelock contested resolution with rotating authority | 44/44 pass · build green · dry-run regression green | 68d0a58 |
| 2026-08-23 | S6 | Build/test harness (events + situation summaries), Mode 2 selection gate (no activation pre-decision), unattended-run report polish; live overnight validation pending first real session | 51/51 pass · build green · dry-run regression green | 9d7b6b1 |
| 2026-08-23 | S7 | lab reset (fixes live-run state contamination), failure-visible run summaries, observer CLI (view builder + ANSI whiteboard), personality overlays as config; first live run happened but was invalidated by stale DB — rerun needed | 56/56 pass · build green · dry-run green post-reset | 97a9cf3 |
| 2026-08-23 | S7.1–8 | Live-run fixes: managed opencode server w/ ephemeral port + health probe, cold-start kickoff mail; clean Mode 2 validation (3 cycles, 1 DECISION, notes app chosen unprompted); web dashboard + Sentinel preflight; Phase 4 complete | 60/60 pass · build green · harness PASS on live workspace | 37bd9ca |
| 2026-08-23 | S9 | Nursery: procreation protocol (PROPOSE AGENT → distinct approval → birth), nursery registry + agent dirs (identity/purpose/permissions), rules-engine BabyDriver in the scheduler loop, stage-1 permission gateway; live run continues separately | 66/66 pass · build green · dry-run green (isolated lab-dryrun.db) | 45053b7 |
| 2026-08-23 | S10 | Promotions (PROMOTE AGENT → dual approval, one-stage rule, permissions mirror), babyStats, idea-neutrality audit + `nursery` subcommand; roadmap complete — next: polish + observe live colonies | 71/71 pass · build green · dry-run green | 691ad08 |
| 2026-08-23 | S11 | Colony ops: daemon `--live` (idle ticks, no quiet-round exit), budget exhaustion cooldown, real token/cost/model capture (migration 005), `stats` command, dashboard SSE push; first live colony ended after 3 cycles due to old stall-exit — rerun recommended | 75/75 pass · build green · dry-run green | 4e99009 |
| 2026-08-23 | S11.1 | Overnight findings fixed: workspace sandbox escape (.git exact-path check), dispute-thread livelock now counts TASK/WARNING standoffs, idle-tick streak cap (5 unproductive → stop), 300s default cycle timeout; colony built md-kb MVP (store+CLI+17 tests) despite sandbox bug; ~600k tokens total | 77/77 pass · build green · dry-run green | c99add3 |
| 2026-08-23 | S12 | Session GC (`sessionGc` setting + dispose on all cycle outcomes), external targeting (`workspacePath` → `query.directory` into sessions), harness SKIPPED for scriptless repos, `init --target`; md-kb archived to ../md-kb-archive; latent SHEETS.agent default bug found+fixed | 82/82 pass · build green · dry-run green | 1c53b3c |
| 2026-08-24 | S12.1 | Nexus run findings: TASK mails now create board rows (board could never grow before — masked since S1), cycle numbering survives restarts, inspect-deep reads workspacePath; colony executing nexus Phase 0 (S3 repos done test-first, 24 tests) amid healthy builder/critic friction incl. rejecting copied-in electron dogma | 83/83 pass · build green · dry-run green | 66301d7 |
| 2026-08-24 | S12.2 | Nexus drama root-caused: agent-a's long cycles die at ~5min with fetch failed (server/provider window, not our timeout) → same-session re-prompt retry preserves tool progress; GC now only disposes successful cycles (interrupted sessions are the only copy); human mail + board task injected for Tauri integration.md + commit cadence | 83/83 pass · build green | 034ca69 |
| 2026-08-24 | S12.4 | Board friction fixed: proposed→done/blocked legal, reviewer close/block rights (assignee keeps activate), harness pointed at nexus pytest (backend/.venv; 91 tests PASS verified); 42 move-rejections decomposed and eliminated; agents dropped+re-dropped human task #1 → drop-protection live | 84/84 pass · build green | 2ea9fc9 |
| 2026-08-24 | S12.5 | Builder segment-commit discipline (ONE committable slice per cycle — attacks the ~5min death window at cause), prompt_retried visibility event; board reconciled to git reality by human (#2/#4/#5 done, #6 dup); push-permission standing policy mailed to both agents | 86/86 pass · build green | bd72d87 |

<!--
Add one row per sprint at completion:
| YYYY-MM-DD | S<n> | <one-line outcome vs exit criteria> | <pass/fail counts> | <short hash> |
-->

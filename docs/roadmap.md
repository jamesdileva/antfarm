# Roadmap — Antfarm

> **STATUS: COMPLETE** (2026-08-23, end of Sprint 10). All five phases
> shipped. Ongoing work is polish, live observation, and the backlog below.

Sprint-by-sprint plan (2-week sprints assumed). Each sprint ends with
something runnable and observable. Sentinel preflight (`integration.md` §7)
runs at the end of every sprint that touches manifests or packaging.

---

## Phase 1 — Skeleton (Sprints 1–2)

**Goal:** two agents complete one directed task end-to-end.

- Monorepo scaffold, Sentinel-compliant root `package.json` (guide §2)
- `packages/db`: schema, migrations, repositories, event logging
- Orchestrator loop skeleton with a **fake agent driver** (scripted fixtures,
  dry-run mode) — proves scheduling, wake policy, restartability
- Real SDK driver: one session per cycle, structured output parsing (zod)
- Mode 1 only: human-seeded `PROJECT_GOAL.md`, direct file handoff between
  agents (no mail yet), git author tags in `/workspace`

**Exit criteria:** "create hello-world CLI" completes via A→B→A cycles;
kill -9 mid-run resumes cleanly; cost per run logged.

### Sprint 1 scope (2026-08-23)

Goals:

- Monorepo scaffold: npm workspaces, Sentinel-compliant root scripts
  (`npx`-prefixed, fresh-clone green)
- `packages/db`: full schema (messages/tasks/sessions/events per
  architecture §4), transactional migrations, typed repositories, event
  logging helper
- `apps/orchestrator`: cycle runner + scheduler skeleton, wake policy
  (pure fn), budgets v1 (per-cycle token cap, max-cycles/hour), task state
  machine validation, zod-validated structured actions
- **Fake agent driver** (scripted fixtures) — no OpenCode SDK yet; proves
  scheduling, mail filing, board moves, event audit trail

### Sprint 2 scope (2026-08-23)

Goals:

- **Real OpenCode driver** (`drivers/opencode.ts`): session-per-cycle via
  `session.create`/`session.prompt`, structured output through
  `format: json_schema` (zod-validated on receipt), drive-sheet system
  prompts (Builder/Critic incentive profiles — roles only, zero seeded
  ideas), defensive token/cost extraction
- **Mode 1 seeding**: `init --goal "<text>"` writes
  `project/shared/PROJECT_GOAL.md`; goal is injected verbatim into every
  situation report (human authors the goal, nothing else)
- **Git integration** (`workspace.ts`): `project/workspace` repo bootstrap,
  per-round change detection (HEAD/status) feeding the wake policy,
  diff-summary grounding in situation reports
- Signal polling hook in the scheduler (`signals(agent)` →
  workspaceChanged/ownedTaskChanged) so real agents wake on environment
  changes, not just scripted work
- Mocked-client unit tests; live smoke gated behind `ANTFARM_LIVE_SMOKE=1`
  (skipped by default — no token burn in CI)

Exit criteria:

- Dry-run suite still green (no regression); new driver unit tests pass
- `init --goal` produces PROJECT_GOAL.md visible in next situation report
- Workspace change flips the wake signal (unit-tested with a temp repo)
- Live smoke documented (manual command); runs green when invoked with
  credentials present

Exit criteria:

- Fresh clone → `npm install` exits 0 unattended
- `npm test`: unit tests (repos, task state machine, wake policy, budget
  caps) + dry-run integration test (multi-cycle run files mail, moves tasks,
  logs events)
- Restart test: close DB mid-run, reopen, queued mail and board state
  intact; loop resumes
- `npm run build` type-checks all workspaces

## Phase 2 — Environment (Sprints 3–4)

**Goal:** the environment becomes the product.

- `packages/mail`: typed messages, queues, delivery-on-wake, validation +
  malformed-output WARNING loop
- `packages/tasks`: board state machine (`proposed → active → blocked →
  done/dropped`), ownership rules; board snapshot in every cycle prompt
- Session persistence: full stop/restart of the platform preserves queues,
  read pointers, in-flight tasks
- Budget enforcement v1: per-cycle token cap, max-cycles/hour, wall-clock
  session timeout

**Exit criteria:** agents coordinate exclusively through mail + board; chaos
test (kill mid-cycle, restart, no lost work) green.

### Sprint 3 scope (2026-08-23)

Goals:

- **Wall-clock session timeout**: mechanical per-cycle timeout; timed-out
  sessions marked `timed_out`, driver `abort()` hook called
- **Mail escalation rules**: QUESTION/HELP threads unanswered past a
  staleness threshold escalate to an orchestrator WARNING (once per thread);
  replies sharing a `thread_id` mark originals `answered`
- **Malformed-output teaching loop**: invalid/failed driver output files a
  WARNING back to the sender with the error summary (environment teaches
  format, guide §4.2)
- **Orphan recovery**: on startup, sessions stuck `running` from a previous
  process are swept to `failed` with an audit event (Sentinel lesson §9:
  restarts self-heal)
- **Idle backoff**: unproductive cycles (zero actions filed) grow an
  exponential, capped re-wake delay; productive cycles reset it

Exit criteria:

- Timeout fires mechanically (tested with a never-resolving driver)
- Stale QUESTION escalates exactly once; thread reply suppresses escalation
- Malformed output produces a WARNING mail to the sender, loop continues
- Restart sweeps orphaned sessions; dry-run regression stays green

### Sprint 4 scope (2026-08-23)

Goals:

- **`lab.config.json`**: single config surface — budgets, cycle timeout,
  escalation threshold, backoff curve, project root; defaults built-in,
  file optional (guide §6)
- **DECISIONS.md protocol** (architecture §2.4): DECISION mails are logged
  as `decision_logged` events (SQLite = source of truth); every agent keeps
  a read pointer (`agent_state` table, migration 002); new decisions since
  the pointer are injected into the next situation report; pointer advances
  after a successful cycle; DECISIONS.md rendered as a derived view
- **Board ownership rules** (architecture §2.3): a task with an owner can
  only be moved by its owner (orchestrator/human exempt); claiming an
  unowned task via `active` + owner still allowed; violations logged as
  `task_move_rejected`
- **Phase 2 exit-criteria chaos suite**: repeated abrupt-termination
  simulation (close DB mid-run at varying rounds), reopen + orphan sweep,
  assert monotonic invariants (no mail/task loss, resume completes)

Exit criteria:

- Config overrides take effect (tested); absent file falls back to defaults
- DECISION mail → visible to the other agent exactly once via pointer
- Non-owner move rejected with audit event; claim flow unchanged
- Chaos suite green across ≥3 random termination points; full suite green

### Sprint 5 scope (2026-08-23)

Goals:

- **MEMORY.md compaction protocol** (architecture §2.4): structured output
  gains `memoryUpdate`; orchestrator persists current memory per agent
  (`memory_current`, migration 003), archives prior versions
  (`memory_archive`), mirrors to `project/<agent>/MEMORY.md`, and injects
  the memory block into subsequent situation reports
- **Stuck-task detection** (architecture §3.2): an `active` task with no
  board movement inside a sliding window of recent cycles is swept to
  `blocked` by the platform with a `task_stuck` audit event
- **Review-livelock escalation** (architecture §3.2): a REVIEW thread that
  exceeds N rounds without a DECISION is auto-resolved as `contested`,
  with resolution authority rotating between agents (odd/even rounds)

Out of scope (→ Sprint 6): build/test harness, Mode 2 brainstorm/decide
protocol, first unattended constrained-autonomy run.

Exit criteria:

- Second memory update archives the first; latest memory appears verbatim
  in the agent's next situation report
- Untouched active task flips to `blocked` exactly once with audit trail;
  recently-moved tasks are left alone
- A 4-round REVIEW thread produces one contested-decision event, never two;
  resolver rotation is deterministic

### Sprint 6 scope (2026-08-23)

Goals:

- **Build/test harness** (`src/harness.ts`): runs configurable build/test
  commands inside `project/workspace` (child process, wall-clock timeout,
  neutralized env), records `build_result`/`test_result` events with
  duration + output tail, feeds PASS/FAIL summaries into every situation
  report; injectable executor for tests
- **Mode 2 (constrained autonomy) protocol**: `mode: constrained` in
  lab.config.json — PROJECT_GOAL.md holds *constraints* only; the situation
  report announces a project-selection phase until the first
  `decision_logged` event; mechanically, task activation is rejected before
  any decision exists (platform enforces sequencing, never content)
- **Unattended-run ergonomics**: loop report extended (stuck/contested
  counts), final summary printout covers board + decisions + budget skips

Exit criteria:

- Harness records PASS and FAIL deterministically (injected executor);
  latest results appear verbatim in situation reports
- Constrained mode blocks pre-decision activation with an audit event;
  post-decision flow unaffected
- Directed-mode regression green end-to-end; suite fully green

### Sprint 7 scope (2026-08-23)

Findings from the first real live run (2026-08-23): stale dry-run state in
`project/lab.db` pre-satisfied the Mode 2 decision gate (contaminated
experiment); run stalled after 1 round without surfacing why.

Goals:

- **`reset` subcommand** (fixes contamination): wipes `project/lab.db`
  (+WAL/SHM) and, with `--yes`, the whole `project/` tree; every experiment
  starts from a clean lab
- **Failure-visible summaries** (fixes silent stalls): run report shows
  failed/timed-out session counts plus the last error tail per agent
- **Observer CLI** (`apps/observer-cli`, Phase 4): read-only terminal
  whiteboard polling SQLite — agent status, latest mail, board, checks,
  recent events; pure `buildView()` separated from ANSI rendering (testable)
- **Personalities** (Phase 4): incentive-profile overlays (Speed, Quality,
  Skeptic, Inventor) as swappable config (`lab.config.json` → drive prompt);
  idea-neutrality preserved — overlays shape *how* agents weigh options,
  never *what* to build

Out of scope (→ Sprint 8): web dashboard on SSE, Electron packaging +
Sentinel §7 preflight.

Exit criteria:

- `reset` leaves zero tasks/mail/events; `--live` then runs with empty
  board and the selection phase actually engaging in constrained mode
- Summary prints per-agent failure reasons when cycles fail
- Observer view builder tested against a seeded DB
- Personality overlays render in prompts; suite fully green

### Sprint 8 scope (2026-08-23)

First clean live validation happened during the Sprint 7 window
(2026-08-23): fresh lab → kickoff mail → 3 cycles, 1 DECISION (agents chose
a markdown notes app unprompted), harness ran, zero failed sessions. Mode 2
machinery confirmed against real OpenCode.

Goals:

- **Web dashboard** (`apps/dashboard`): dependency-free Node HTTP server;
  `GET /api/view` serves the same `ObserverView` JSON the CLI uses (shared
  via `@antfarm/observer-cli` main export); single-page whiteboard polls
  every second. Polling chosen over SSE for v0 — no new runtime deps,
  Sentinel-safe; SSE upgrade deferred
- **Sentinel preflight** (integration.md §7): fresh-clone `npm install`
  unattended, bare-shell `startup`/`test`/`build` extraction verified,
  headless test pass
- **Electron packaging: explicitly deferred** — the dashboard is a local
  dev tool, not a shipped product; packaging adds electron-builder weight
  for no current tester value. Revisit when a Sentinel DOM feature-tester
  is actually wanted (§5 recipe applies then)

Exit criteria:

- `npm run dashboard` serves the live lab state at localhost; view JSON
  identical to CLI's
- Preflight checklist §7 passes except packaged-exe item (N/A while deferral
  stands)
- Full suite green

## Phase 3 — Autonomy (Sprints 5–6)

**Goal:** agents run without a script.

- `packages/drives`: drive sheets + situation-report prompt generator
  (grounded 5 questions)
- `packages/memory`: MEMORY.md compaction protocol, DECISIONS.md propagation,
  archive to SQLite
- `packages/harness`: build/test runner for `/workspace`, results fed into
  prompts
- Guardrails: livelock escalation (N-round review rule), stuck-task
  detection (no artifact delta across M cycles), idle backoff
- **Mode 2 (constrained autonomy):** brainstorm→decide protocol via DECISION
  mail

**Exit criteria:** an unattended overnight Mode-2 run produces one small
working app without human input, within budget, with zero deadlock stalls
(measured from events table).

## Phase 4 — Observatory (Sprints 7–8)

**Goal:** make it fun and safe to watch.

- `apps/observer-cli`: terminal whiteboard over SQLite (status, live
  conversation, task counts, test/build state)
- `apps/dashboard`: web whiteboard on SDK SSE (`event.subscribe()`) + SQLite
- Personalities: incentive profiles (Inventor/Skeptic, Speed/Quality) as
  swappable config
- **Mode 3 (fully autonomous):** empty-workspace loop incl. "choose next
  project"
- If dashboard ships packaged: Electron checklist (`integration.md` §3),
  exe at `release/win-unpacked/`, full §7 preflight

**Exit criteria:** live dashboard shows a Mode-3 run in real time; Sentinel
indexes the project with green test/start/build.

## Phase 5 — Ecosystem / Nursery (Sprints 9–10)

**Goal:** parents can create, grow, and govern their own agents.

### Sprint 9 scope (2026-08-23)

Goals:

- **Nursery registry** (migration 004 `nursery_agents`): id, name, purpose,
  stage (default 1 = Observer), runtime (`rules-engine`), creators, status;
  agent directory mirrored at `project/agents/<id>/` (`identity.json`,
  `purpose.md` — verbatim from the parents' proposal)
- **Procreation protocol**: a parent files a DECISION mail with subject
  `PROPOSE AGENT <id>: <name>` (body carries Purpose + Evidence lines);
  birth requires a *second, distinct* actor approving via DECISION in the
  same thread; the platform validates structure and grants **minimum**
  capabilities (stage 1) no matter what was requested — safety matrix is
  mechanical, never negotiated away
- **Rules-engine baby runtime** (`drivers/baby.ts`): observe → decide → act
  → sleep as an `AgentDriver`, so babies join the same scheduler loop.
  Observer-stage rules: watch workspace deltas, acknowledge mail, file
  STATUS reports to creators; observations appended to the baby's log
- **Permission gateway** in `commitActions`: nursery actors have their
  mail types / task moves checked against stage capabilities; violations →
  `permission_denied` audit event (mechanical, D6)
- Cold-start parity: newborns receive an orchestrator kickoff carrying their
  recorded purpose — nothing more

Out of scope (→ Sprint 10): promotion stages (Analyst/Assistant/Specialist),
performance stats, promotion reviews; also deferred per user decision:
additional OpenCode-runtime children (more-of-the-same scaling, less
interesting than a genuinely different runtime).

Exit criteria:

- Two-agent proposal flow births a working baby end-to-end in dry-run:
  registry row, directory files, kickoff mail, scheduled cycles
- Self-approval and malformed proposals are rejected with audit events
- Stage-1 baby physically cannot move tasks or file non-report mail types
  (gateway-tested); its purpose file matches the parents' text byte-for-byte

### Sprint 10 scope (2026-08-23)

Goals:

- **Promotion protocol**: parents propose via DECISION mail
  `PROMOTE AGENT <id> TO STAGE <n>`; dual distinct approval required;
  platform enforces one-stage-at-a-time (Observer→Analyst→Assistant→
  Specialist), updates the registry and `permissions.json`, audits with
  `agent_promoted` events
- **Performance stats** (`babyStats`): per-baby cycle count, reports filed,
  permission denials, observation volume — surfaced in a `nursery`
  subcommand so parents' promotion proposals can cite real numbers
- **Idea-neutrality audit tooling** (`npm start -- nursery`): every
  `purpose.md` must trace through the event log back to its parents'
  proposal mail; tampering or untraceable purposes FAIL loudly

Exit criteria:

- Promotion refuses skips/self-approval/duplicate approvals; valid path
  updates stage + capabilities mechanically
- Stats reflect seeded activity; `nursery` output shows registry + audit
- Audit passes on a healthy lab and FAILS when purpose.md is tampered with

**Exit criteria:** parents autonomously identify a recurring problem and
spawn an agent for it (or demonstrably choose not to); baby operates within
its permission envelope; attempted permission violation is mechanically
blocked and logged.

**Design guardrail for this phase:** resist any urge to hint at useful
agent roles in drive sheets or cycle prompts. The experiment is precisely
whether the idea emerges.

## Post-roadmap sprints

### Sprint 12 scope (2026-08-24) — session GC + external targeting

Per `docs/sprint-12-nexus.md`. md-kb MVP archived to
`../md-kb-archive/` before this sprint's reset.

Goals:

- **Session GC** (`sessionGc` setting, default off): opencode sessions
  deleted after full capture in lab.db; Settings toggle; failure paths
  dispose too
- **External targeting** (`workspacePath` config): agents' opencode sessions
  run with `query.directory` set to the target repo; workspace bootstrap,
  harness, wake signals all redirect; `init --target` helper validates and
  wires everything; per-project labs via reset+init
- Harness soft-skips scriptless repos (`--if-present` defaults, SKIPPED
  event kind)

Exit criteria:

- GC on: zero session accumulation in opencode, full audit trail in lab.db
- Colony targeted at nexus reads its docs and commits agent-authored work
  to nexus's own git history (its `.git`, not the lab's)
- Antfarm default config unchanged and green

### Sprint 11 scope (2026-08-23) — colony operations

Findings from the first extended observation: live runs exit on the first
quiet round (stall detection), so colonies stop after ~3 cycles unless mail
keeps flowing; token/cost/model data was never captured; dashboard polls.

Goals:

- **Daemon live mode**: `--live` runs persistently — a quiet round sleeps
  `idleTickMs` (config, default 60s) instead of exiting; stall-break now
  applies only to one-shot/dry-run modes
- **Budget exhaustion cooldown**: an agent parked for exceeding
  `maxTokensPerCycle` auto-unparks after a cooldown window (config,
  default 10min) instead of forever
- **Real usage capture**: OpenCodeDriver records tokens/cost/model per
  cycle from AssistantMessage; migration 005 adds `sessions.model`;
  `deps.usageFor` wires real numbers into budgets and summaries
- **`stats` subcommand**: per-agent token/cost totals, per-model breakdown,
  recent session table
- **Dashboard SSE**: `/api/stream` tails the event log server-side; page
  uses EventSource and refreshes the view on new events (polling kept as
  fallback)

Exit criteria:

- Live run survives quiet rounds indefinitely (Ctrl+C to stop); dry-run
  regression unchanged
- Exhausted agent resumes after cooldown without restart
- `stats` shows non-zero real token/cost numbers and model ids after a
  live session; dashboard updates within ~1s of new events without polling

## Phase 6 — Desktop (S13–15)

**Goal:** standalone `Antfarm.exe` — full GUI lab lifecycle, Sentinel-indexable.

Per `docs/sprint-13-desktop.md`: S13 data-home decoupling (`ANTFARM_HOME`),
S14 Electron shell + orchestrator serve mode (control API + GUI lifecycle),
S15 packaging at `release/win-unpacked/` + §7 preflight + feature tester.

**Exit criteria:** double-click exe → dashboard; create+start a colony via
GUI alone; Sentinel preflight green end-to-end.

## Phase 7 — Colony lifecycle polish (S16)

**Goal:** finished projects are never lost to a reset. Archive snapshots a
lab (project tree + lab.db + config) into `<home>/archives/<timestamp>/`;
reset then becomes safe to run before starting the next experiment
(autonomous or constrained).

- `archive` CLI command + shared `archiveLab()` used by serve mode
- Serve control routes: `POST /api/lab/archive`, `POST /api/lab/reset`
  (both refuse while the colony is running)
- Dashboard: Archive + Reset buttons on the colony panel (reset confirms)
- Shell: single-instance lock (double-launch no longer spawns competing
  orchestrators)

**Exit criteria:** archive → reset → init new goal → fresh colony runs;
archived project + db fully intact and inspectable; all via GUI alone.


## Later / backlog

- First-run preflight in the packaged shell: detect a missing `opencode`
  install and guide/auto-fetch it before colony start (fresh machines
  currently fail at first live start)
- >2 parent agents and role specialization (schema already supports it;
  scheduling policies don't yet)
- Additional OpenCode-runtime children (more-of-the-same scaling; less
  interesting than genuinely different runtimes — user decision)
- Baby-agent runtime maturity: local-model brains, skill libraries,
  cross-project agent portability
- Networked labs (agents across machines; mail transport abstraction exists)

- >2 agents and role specialization (schema already supports it; scheduling
  policies don't yet)
- Baby-agent runtime maturity: local-model brains, skill libraries,
  cross-project agent portability (Phase 5 proves the identity model first)
- Networked labs (agents across machines; mail transport abstraction exists)
- Experiment harness: seed variations, metrics extraction from `events`
  (cycles-to-MVP, rework rate, deadlock frequency), side-by-side comparison
  of personality pairings
- Human mailbox UI (approve contested decisions from Mode 3 runs)
- Cost analytics dashboard from session token/cost columns

## Risk register

| Risk | Mitigation | Sprint |
|---|---|---|
| Token burn runaway | Mechanical budgets + quiet hours (D6) | 3 |
| REVIEW↔fix livelock | N-round escalation rule, contested-decision protocol | 5–6 |
| Context bloat | Session-per-cycle + compaction protocol | 5 |
| Structured output flakiness | zod validation, repair retry, WARNING teaching loop | 1–2 |
| Sentinel integration debt | Preflight every sprint touching manifests/packaging | all |
| Parents never (or constantly) procreate | Both are valid outcomes — measure and observe, don't tune toward either | 9–10 |
| Idea-poisoning from the platform | Protocol-not-content rule; audit trail from purpose.md back to parent DECISION mail | 9–10 |
| Scope creep toward full vision | Phases gate each capability behind a runnable exit criterion | all |

# Roadmap — Antfarm

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

- **Area abstraction:** Playground/Nursery capability flags; actor registry
  extended to platform-owned agents (`identity.json`, `purpose.md`,
  `permissions.json` per architecture §6.1)
- Procreation protocol: joint DECISION proposal with evidence refs,
  dual approval, orchestrator safety validation
- Baby runtime v1: simplest possible loop (observe → decide → act → sleep)
  as a rules-engine or local-model actor — deliberately *not* OpenCode, to
  prove runtime-agnostic identity
- Tool gateway: mechanical permission enforcement per stage (Observer →
  Analyst → Assistant → Specialist); promotion proposals from performance
  stats in `events`
- **Idea-neutrality test:** no seeded purposes anywhere in prompts or
  config; verify via audit that every `purpose.md` traces to parent
  DECISION mail citing observed problems

**Exit criteria:** parents autonomously identify a recurring problem and
spawn an agent for it (or demonstrably choose not to); baby operates within
its permission envelope; attempted permission violation is mechanically
blocked and logged.

**Design guardrail for this phase:** resist any urge to hint at useful
agent roles in drive sheets or cycle prompts. The experiment is precisely
whether the idea emerges.

## Later / backlog

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

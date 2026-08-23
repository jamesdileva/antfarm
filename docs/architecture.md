# Architecture — Antfarm

A desktop "AI laboratory": two autonomous OpenCode agents in a shared
environment (mail, task board, memory, workspace) driven by an orchestrator,
observed via a live whiteboard. See `idea.md` for the vision and
`integration.md` for the Sentinel integration constraints this design honors.

---

## 1. System overview

```
                ┌──────────────────────────────────────────┐
                │              ORCHESTRATOR                │
                │  cycle scheduler · session lifecycle ·   │
                │  budgets · deadlock guards · recovery    │
                └───────┬──────────────┬──────────────┬────┘
                        │              │              │
                 ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼──────┐
                 │  AGENT A   │ │  AGENT B   │ │  OBSERVER   │
                 │  Builder   │ │  Critic    │ │  CLI + Web  │
                 │ (OpenCode) │ │ (OpenCode) │ │  dashboard  │
                 └──────┬─────┘ └──────┬─────┘ └──────┬──────┘
                        │   mail / tasks / events     │
                        └──────┬───────┴──────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  SHARED PLATFORM    │
                    │  SQLite (state)     │
                    │  Shared files       │
                    │  /workspace (git)   │
                    └─────────────────────┘
```

**Key principle:** the orchestrator is a *platform*, not a puppeteer. Agents
decide what to do; the platform decides *when* they may act, enforces budgets,
and records everything.

## 2. Core components

### 2.1 Orchestrator (`apps/orchestrator`)

The only process with authority over agent lifecycle.

- **Cycle scheduler** — wakes agents per their drive state, not on a fixed
  clock. A cycle for one agent = one OpenCode session with a structured
  "situation report" prompt (the 5 questions from `idea.md`: what changed,
  what's unfinished, any mail, any errors, what next).
- **Session lifecycle** — creates/sends/prompts sessions via `@opencode-ai/sdk`
  (`createOpencode`, `session.create`, `session.prompt`). One session per
  cycle; never one infinite context.
- **Crash recovery** — all state lives in SQLite + files; on restart, agents
  resume from queued mail, open tasks, and their last MEMORY.md.
- **Budget enforcement** — per-run token/cost caps, max-cycles-per-hour,
  quiet hours. Hard stop when a budget is exhausted.
- **Event bus** — every orchestrator action, message, and SDK event lands in
  SQLite and fans out to observers.

### 2.2 Mail system (`packages/mail`)

Typed, persistent, asynchronous messaging — this replaces raw chat piping.

- Message types: `QUESTION | IDEA | TASK | REVIEW | WARNING | DECISION |
  STATUS | HELP`.
- Fields: `from`, `to`, `type`, `priority`, `subject`, `body`,
  `refs[]` (task ids, file paths), `thread_id`, `status`
  (`queued → delivered → read → answered`).
- Delivery: SQLite-backed queues. Mail is delivered to an agent as part of its
  next cycle prompt, never mid-session.
- Rules:
  - Every `QUESTION`/`HELP` must be answered within N cycles or it escalates
    to `WARNING` on the task board (see §4 Deadlock rules).
  - Agents cannot send mail directly between themselves; they emit structured
    output that the orchestrator validates and files.

### 2.3 Task board (`packages/tasks`)

Single source of truth for work items; prevents aimless chatter.

- States: `proposed → active → blocked → done | dropped`.
- Ownership: exactly one owner at a time; transitions require a `DECISION`
  mail or direct board write by the owner.
- Every `TASK` mail references a board row. Board rows reference artifacts
  (files, test runs) so progress is verifiable, not claimed.
- The orchestrator injects a board snapshot into every cycle prompt.

### 2.4 Memory layer (`packages/memory`)

```
/project
  /shared
    PROJECT_GOAL.md      # current mission (mode-dependent)
    DECISIONS.md         # append-only decision log
    KNOWLEDGE.md         # durable facts learned about the environment
    TASKS.md             # human-readable mirror of the board
  /agent-a
    MEMORY.md            # compacted working memory
    inbox/               # delivered mail snapshots
  /agent-b
    MEMORY.md
    inbox/
  /workspace             # the actual project being built (git repo)
```

- **Compaction protocol:** after each cycle the orchestrator asks the agent
  (in the same session, final turn) to rewrite MEMORY.md to ≤ N lines:
  current goal, open threads, key learnings. Old MEMORY.md versions are kept
  in SQLite for audit.
- **Propagation:** `DECISIONS.md` is shared; each cycle prompt includes recent
  decisions since the agent's last read pointer, so both agents converge on
  the same facts without full-context sync.
- Sessions (`session-*.json`) are stored per agent for replay/debugging;
  they are context, not memory — MEMORY.md is memory.

### 2.5 Agent drives (`packages/drives`)

Each agent gets a system-prompt-level "drive sheet" (per `idea.md`):

- Agent A (Builder): build useful software; reduce bugs; finish unfinished
  tasks; answer Critic.
- Agent B (Critic): ensure quality; review changes; find weaknesses; propose
  improvements.
- Personalities are incentive profiles layered on top of drives (Inventor vs
  Skeptic, Speed vs Quality). Stored as config, swappable without code change.

The 5-question cycle prompt is generated by the orchestrator from live state
(git diff summary, board snapshot, unread mail, last test/build result), not
asked open-endedly — grounding beats recall.

### 2.6 Whiteboard / Observer (`apps/observer-cli`, later `apps/dashboard`)

- v1: terminal dashboard reading SQLite directly (no coupling to agent
  processes).
- v2: web dashboard subscribing to `event.subscribe()` (SDK SSE stream) for
  live updates: agent status, current session goal, live conversation,
  task counts, test/build status.
- Read-only by design. Humans watch; they do not intervene through the same
  channel agents use (a separate `human` mail sender is allowed for Mode 1).

### 2.7 Build/test harness (`packages/harness`)

- Runs inside `/workspace`: install, build, test. Results recorded as events
  and summarized into cycle prompts ("Tests: 142 passing / 2 failing").
- Scripts follow the Sentinel Tier 0 contract (`docs/integration.md` §1):
  runnable as bare shell lines from the workspace root with neutralized PATH
  (`npx ...`, absolute-relative python paths).

## 3. Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Orchestrator wraps OpenCode via SDK; no OpenCode forks | Upgrades stay free; the hard problem is the environment, not the agent runtime |
| D2 | **One OpenCode server, two projects/directories** | Simpler ops; isolation comes from per-agent working dirs + separate sessions, not separate servers. Revisit if prompt/context bleed appears |
| D3 | All inter-agent communication through validated mail + board | Prevents "two chatbots chatting"; everything auditable and resumable |
| D4 | SQLite as the only cross-agent state store | Local, transactional, zero-ops; files are derived views where humans read them |
| D5 | Session-per-cycle, MEMORY.md as long-term memory | Bounded contexts, restartability, cheap compaction |
| D6 | Budgets enforced by the orchestrator, not prompted | Prompted self-restraint fails; caps must be mechanical |

### 3.1 Termination & cost control

- Per-cycle token cap and per-day cost cap; exceeded ⇒ agent parked with
  status `budget_exhausted`.
- Max cycles/hour per agent; idle backoff (exponential, capped) when an agent
  has no actionable input.
- Every session has a wall-clock timeout; the orchestrator kills and marks
  the cycle `timed_out`.

### 3.2 Deadlock & livelock rules

- **Wait-for:** agents never block waiting. Mail queues decouple them; a wake
  always makes progress on *something* (own task, review, memory).
- **Circular waits:** impossible by construction — there is no synchronous
  request/response channel.
- **Livelock (REVIEW→fix→REVIEW loops):** a thread that exceeds N review
  rounds without a passing gate escalates: the disagreement is logged to
  `DECISIONS.md` as `contested`, and resolution rotates (Builder decides odd
  rounds, Critic even) or defers to the human mailbox.
- **Stuck detection:** if the same task shows no artifact delta (git diff,
  test results) across M cycles, the orchestrator marks it `blocked` and
  surfaces it prominently.

### 3.3 Workspace isolation

- Each agent works in `/workspace` but commits through git with author tags
  (`agent-a`, `agent-b`) — attribution and rollback for free.
- File-write conflicts mitigated by convention: the board assigns module
  ownership per task; the critic reviews diffs before merge to `main`.

## 4. Data model (SQLite)

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,          -- 'agent-a' | 'agent-b' | 'orchestrator' | 'human'
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('QUESTION','IDEA','TASK','REVIEW',
                                     'WARNING','DECISION','STATUS','HELP')),
  priority INTEGER NOT NULL DEFAULT 5,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT,                         -- JSON array of {kind:'task'|'file'|'session', id}
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|delivered|read|answered
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed', -- proposed|active|blocked|done|dropped
  owner TEXT,                             -- agent id or NULL
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  artifact_refs TEXT                      -- JSON array of files/tests/commits
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running|done|timed_out|failed
  tokens_in INTEGER, tokens_out INTEGER, cost REAL,
  started_at TEXT NOT NULL, ended_at TEXT,
  summary TEXT                            -- agent's own end-of-cycle summary
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- mail_delivered, task_moved, cycle_started,
                                          -- build_result, budget_warning, ...
  actor TEXT NOT NULL,
  payload TEXT NOT NULL                   -- JSON
);
```

## 5. Experiment modes

| Mode | PROJECT_GOAL.md source | Autonomy |
|------|------------------------|----------|
| 1 Directed | Human writes the goal | Agents plan/build/test/improve within it |
| 2 Constrained | Human writes constraints; agents choose the project | Brainstorm → decide (vote protocol via DECISION mail) → build |
| 3 Autonomous | Empty workspace; agents decide purpose end-to-end | Full loop incl. choosing the next project after release |

Modes differ only in how `PROJECT_GOAL.md` is seeded and whether the
"choose project" phase is enabled — the rest of the machinery is identical.

## 6. Areas — Playground and Nursery

The platform hosts **Areas**: distinct environments sharing one substrate
(orchestrator, mail, board, memory, SQLite) but with different unlocked
capabilities.

| Area | Source | Unlocked | Idea-authorship |
|------|--------|----------|-----------------|
| **Playground** | `idea.md` | Modes 1–3: build software | Agents decide *what to build* |
| **Nursery** | `lateaddition.md` | Agent creation ("baby agents") | Agents decide *whether/what teammates to create* |

**Idea-neutrality rule (anti-poisoning):** the platform defines protocols,
never content. For the Nursery this means:

- The platform provides: proposal format, justification gate, permission
  stages, sandboxing, lifecycle bookkeeping.
- The parents provide: whether to procreate, the baby's purpose, its
  permissions request, promotion decisions.
- A baby's `purpose.md` must originate verbatim from a parents' `DECISION`
  mail that cites an *observed problem* (with event/task evidence). The
  orchestrator validates safety constraints only — never usefulness, never
  intent. If parents never identify a problem worth delegating, no babies
  are born, and that is a valid outcome.

### 6.1 Procreation protocol

1. Parents exchange DECISION mails proposing an agent (role, purpose,
   requested capabilities, justification with evidence refs).
2. Both must approve; disagreement follows the contested-decision protocol
   (§3.2).
3. Orchestrator validates the permission request against the safety matrix
   (below), creates the agent directory, registers it in SQLite.
4. The baby starts at Stage 1 with read-only tools.

```
/agents/scout-001/
  identity.json        # id, name, creator(s), birth cycle, runtime binding
  purpose.md           # verbatim from parents' DECISION mail
  permissions.json     # tool allowlist per stage
  memory.db            # own observations/reports
  sessions/            # own cycle history
  runtime/             # brain binding: opencode | local-llm | rules-engine
```

### 6.2 Baby agents as first-class actors

- A baby is a third class of actor (`agent-a`, `agent-b`, `scout-001`) with
  the same mail/board primitives but restricted permissions.
- **Runtime-agnostic identity:** identity, memory, purpose, history belong
  to the platform, not OpenCode. The `runtime` field is swappable; replacing
  a brain does not destroy the agent. Parents run on OpenCode today; babies
  may start as simple observe→decide→act loops on rules or a local model.
- **Growth stages:** Observer (read-only) → Analyst (+recommendations) →
  Assistant (+limited writes) → Specialist (+domain autonomy). Promotion is
  proposed by parents based on measured performance (accuracy stats from the
  events table) and granted by the orchestrator's safety check.
- **Sandboxing is mechanical:** permission enforcement lives in the
  orchestrator's tool gateway, not in prompts (same principle as D6).

## 7. Non-goals (v1)

- >2 agents (schema supports it; scheduling policies don't yet)
- Agent creation / Nursery area (designed in §6, built post-v1)
- Multi-machine distribution
- Modifying OpenCode itself
- Human-in-the-loop approvals beyond the Mode 1 goal seed

# Implementation Guide — Antfarm

How to build the platform described in `architecture.md`. Stack:
**TypeScript / Node**, **@opencode-ai/sdk**, **SQLite (better-sqlite3)**,
**Vite + React** for the later dashboard.

This project must stay Sentinel-integrable — every command below follows the
Tier 0 contract in `integration.md` §1: scripts run as bare shell lines from
repo root with a neutralized PATH, and a fresh-clone `npm install` goes green
unattended.

---

## 1. Repository layout

npm workspaces monorepo:

```
/antfarm
  package.json              # workspaces + Sentinel-extracted scripts
  tsconfig.base.json
  /packages
    /db                     # schema, migrations, repositories
    /mail                   # message types, queue ops, validation
    /tasks                  # board state machine
    /memory                 # MEMORY.md compaction, shared-file readers
    /drives                 # drive sheets + cycle-prompt generator
    /harness                # build/test runner for /workspace
  /apps
    /orchestrator           # the loop; CLI entrypoint
    /observer-cli           # terminal whiteboard
    /dashboard              # web whiteboard (later sprint)
  /project                  # created at runtime by `lab init`:
    /shared ...             # layout from architecture.md §2.4
```

## 2. Root package.json (Sentinel Tier 0 contract)

```jsonc
{
  "name": "antfarm",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "type": "module",
  "scripts": {
    "dev":    "npx tsx apps/orchestrator/src/main.ts --watch",
    "start":  "npx tsx apps/orchestrator/src/main.ts",
    "build":  "npx tsc -b",
    "test":   "npx vitest run"
  }
}
```

Contract compliance checklist:

- [x] All four commands are bare shell lines using `npx` (no reliance on
      `node_modules/.bin` on PATH) — `integration.md` §1 rule 1.
- [x] Fresh-clone `npm install` needs no venv or side effects — rule 4.
- If the dashboard ships as an Electron app later, follow `integration.md`
  §2–3 exactly (`.cjs` main under `"type": "module"`, `base: "./"`,
  HashRouter, exe-path root detection, output to `release/win-unpacked/`).

## 3. Dependencies

| Package | Purpose |
|---|---|
| `@opencode-ai/sdk` | Agent sessions, prompts, SSE events |
| `better-sqlite3` | Synchronous SQLite — simplest correct model for a single-process orchestrator |
| `simple-git` | Workspace git operations (diff summaries, commits with agent author tags) |
| `tsx`, `typescript`, `vitest` | Dev toolchain |
| `zod` | Validate structured agent output (mail emission, action choice) |

## 4. Build order

Build in this sequence; each layer is testable before the next:

1. `packages/db` → 2. `packages/mail` → 3. `packages/tasks` →
4. `apps/orchestrator` loop skeleton → 5. agent driver (SDK integration) →
6. `packages/memory` → 7. `packages/drives` → 8. `packages/harness` →
9. `apps/observer-cli` → 10. `apps/dashboard`.

### 4.1 DB layer

- Schema per `architecture.md` §4. Use plain SQL migrations
  (`migrations/001_init.sql`) applied in a transaction at startup.
- Repositories expose typed CRUD (`MailRepo.enqueue`, `TaskRepo.move`, …).
  Every write also inserts an `events` row — one helper,
  `withEvent(kind, actor, payload, fn)`.

### 4.2 Mail system

```ts
export const MessageTypes = ['QUESTION','IDEA','TASK','REVIEW',
  'WARNING','DECISION','STATUS','HELP'] as const;

const MailInput = z.object({
  to: z.enum(['agent-a','agent-b']),
  type: z.enum(MessageTypes),
  subject: z.string().max(120),
  body: z.string(),
  refs: z.array(z.object({ kind: z.enum(['task','file','session']),
                           id: z.string() })).default([]),
});
```

Agents never send mail directly. The driver parses their structured output,
validates with `MailInput`, and files it. Invalid output becomes an
orchestrator `WARNING` back to the sender ("your message was malformed") —
the environment teaches the format.

Delivery: when building a cycle prompt, take all `queued` mail for that
agent, mark `delivered`, embed verbatim in the prompt.

### 4.3 Orchestrator loop

```ts
async function runCycle(agent: AgentId): Promise<CycleResult> {
  if (!budgets.canRun(agent)) return { status: 'budget_exhausted' };

  const situation = await buildSituationReport(agent); // git diff summary,
  // unread mail, board snapshot, last test/build result, recent DECISIONS.md

  const session = await client.session.create({
    directory: paths.workspaceFor(agent),
    systemPrompt: drives.promptFor(agent),        // drive sheet + personality
  });

  const reply = await client.session.prompt({
    sessionId: session.id,
    parts: [{ type: 'text', text: situation }],
  });

  const actions = ActionsOutput.parse(reply);     // zod: mails[], taskMoves[],
                                                  // memoryUpdate, summary
  await commitActions(agent, actions);            // file mail, move tasks,
                                                  // compact MEMORY.md, log event
  return { status: 'done', tokens: usage(reply) };
}
```

Top-level scheduler (pseudo):

```ts
while (running) {
  for (const agent of agents) {
    if (shouldWake(agent)) await runCycle(agent);   // has mail, open task,
                                                    // workspace changed, or idle-backoff expired
  }
  checkBudgets(); detectStuckTasks(); escalateDeadlocks();
  await sleep(tickMs);
}
```

Wake policy v1 (keep simple): an agent wakes when (a) queued mail exists,
(b) its owned task's state changed, (c) new commits landed in `/workspace`,
or (d) its backoff timer expired — whichever first.

### 4.4 Structured agent output

End every cycle prompt with the required response shape:

```
Respond ONLY with JSON matching:
{
  "mails": [ { "to": "...", "type": "...", "subject": "...", "body": "...", "refs": [] } ],
  "taskMoves": [ { "taskId": 12, "state": "active", "note": "..." } ],
  "memoryUpdate": "≤20 lines replacing your MEMORY.md",
  "summary": "one-line status for the whiteboard"
}
```

Use the SDK's structured-output support where available; otherwise parse +
zod-validate with one repair retry, then fall back to orchestrator WARNING.

### 4.5 Memory manager

- After committing actions, write `memoryUpdate` to the agent's MEMORY.md;
  archive the previous version into SQLite.
- Compute each agent's read pointer on `DECISIONS.md`; inject only new
  decisions into subsequent cycle prompts.

### 4.6 Drives

Drive sheets are data, not code:

```yaml
# packages/drives/sheets/builder.yaml
agent: agent-a
primary_goal: Build useful software in the shared workspace
needs: [reduce bugs, complete unfinished tasks, respond to critic]
personality: pragmatic-speed   # swappable: quality-hawk, inventor, skeptic
cycle_questions:               # grounded by the situation report, not free recall
  - What changed since your last cycle?
  - What remains unfinished?
  - Any unanswered mail?
  - Any failing tests/builds?
  - What is the single next best action?
```

### 4.7 Harness

Runs inside `/workspace` only. Same Tier 0 rules apply to the *generated*
project: instruct Builder to scaffold with Sentinel-compliant scripts
(`npx`-prefixed). Harness records pass/fail + counts as events and summarizes
them into the next situation report.

### 4.8 Observer CLI

Read-only: polls SQLite every second, renders the whiteboard mock from
`idea.md` (agent status, live conversation = latest messages, task counts,
last test/build result). No SDK dependency — SQLite only.

## 5. Testing strategy

- **Unit:** repos, mail validation, task state machine, wake-policy function
  (pure functions — keep them pure).
- **Dry-run mode (`--dry-run`):** replace the OpenCode client with scripted
  fixtures — deterministic agent outputs stored as JSON. The full loop,
  budgets, escalation rules, and observers run against them. This is how you
  test deadlock/livelock guards without burning tokens.
- **Integration (1 real pair):** a single directed Mode-1 run with a tiny
  goal ("create hello-world CLI"), capped at N cycles and $X — smoke test,
  also serves as the Sentinel `test` target via a tag filter.
- **Chaos:** kill -9 the orchestrator mid-cycle in tests; assert restart
  resumes from queued mail and no task is lost.

## 6. Operational notes

- Config in one `lab.config.yaml`: budgets, tick interval, backoff curve,
  quiet hours, drive sheet paths, mode.
- Logs: structured JSON to file per component; the `events` table is the
  audit log of record.
- Secrets: API keys via env only; never written to SQLite, sessions, or
  MEMORY.md (scrub in the memory compaction step).

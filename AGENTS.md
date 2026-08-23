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
| `npm start` | Orchestrator |
| `npm run build` | Type-check/build all workspaces |
| `npm test` | Vitest suite (unit + dry-run fixtures) |

## Commit style

Conventional-ish, short subject: `feat(mail): typed message queues`,
`fix(orchestrator): resume after kill -9`. Sprint commits may bundle, but
the subject names the phase goal.

## Worklog

| Date | Sprint | Summary | Tests | Commit |
|------|--------|---------|-------|--------|
| 2026-08-23 | pre-1 | Docs authored: architecture, implementation guide, roadmap, areas/nursery design; repo initialized | n/a (docs only) | — |

<!--
Add one row per sprint at completion:
| YYYY-MM-DD | S<n> | <one-line outcome vs exit criteria> | <pass/fail counts> | <short hash> |
-->

# Sprint 12 Plan — Session GC + External Project Targeting

Status: **planned** (build next session). This doc exists so placement in
roadmap.md doesn't matter; it will be folded into the worklog once done.

Two features requested after first overnight observation:

1. **Session GC** — opencode sessions accumulate per cycle (~2,900/day with
   idle ticks at 60s). Fine for days, gigabytes over months.
2. **External project targeting** — point the two parent agents at a real
   user-owned repo (`J:/projects/nexus`, currently docs-only) and have them
   execute its documented plan instead of playing in the sandbox workspace.

---

## Part 1 — Session GC

### Design

- New setting `"sessionGc": boolean` (default **false** = keep transcripts,
  matching current debuggability-first posture).
- When true: after a cycle is fully recorded in SQLite (summary, tokens,
  cost, model extracted), the orchestrator calls
  `client.session.delete({ path: { id } })` for that opencode session.
  Applies to done, failed, AND timed_out sessions — everything is captured
  in our DB before deletion, so nothing of value is lost.
- Mechanics: `OpenCodeDriver.run()` already creates the session id — store
  it per agent (`lastSessionId` map); add optional driver method
  `disposeSession(agent)` called by `runCycle` after `sessions.finish`.
- Babies are unaffected (rules-engine runtime, no opencode sessions).
- Dashboard Settings gains a checkbox; saves into lab.config.json like the
  other fields.

### Tasks

- [ ] `OpenCodeDriver`: track lastSessionId per agent; implement
      `disposeSession(agent)` via `session.delete`
- [ ] `runCycle`: call `driver.disposeSession?.(agent)` after terminal
      session state is written (all three outcomes)
- [ ] Config field `sessionGc` + mergeConfig support + Settings UI toggle
- [ ] Tests: mocked client asserts delete called when enabled, not called
      when disabled; failure paths still dispose

## Part 2 — External project targeting (Nexus)

### Context decisions (from discussion)

- Nexus = fresh git repo, **docs only** (architecture defines the stack;
  no code yet). Agents scaffold from the docs.
- **No branch isolation**: fresh repo, agents may commit directly to the
  current branch with their author tags (`agent-a` / `agent-b`).
- **Harness must degrade gracefully**: until agents scaffold a runnable
  project, build/test commands should soft-skip rather than FAIL. Default
  `testCmd` changes from `npm test` to `npm run --if-present test` so an
  empty repo reports "skipped" instead of red.
- **Per-project lab lifecycle**: one lab per target project. Retargeting =
  `reset --yes` + `init` again (colony memory/decisions don't carry across
  different missions). Antfarm's own playground remains its own lab.

### Design

- Config: `"workspacePath": "<path>"` (absolute or ~-relative). Default
  stays `project/workspace`. Everything that touches the workspace
  redirects through it:
  - `Workspace` bootstrap/poll/diffSummary (already no-ops re-init on
    existing repos)
  - harness `workspaceDir`
  - baby drivers' observation source
- **Session directory context**: pass nexus path as `query.directory` on
  `session.create`/`session.prompt` (verified present in installed SDK's
  types) so agents' file/edit tools operate inside nexus, not the lab repo.
  `OpenCodeDriver` gains optional `directory` option; main.ts passes
  `cfg.workspacePath`.
- **Safety consideration**: agents gain write access to a real user repo.
  Mitigations already mechanical: budgets, cycle timeouts, ownership rules
  apply unchanged; git history + author tags make every edit attributable
  and revertable. Docs-only repo = low blast radius for the first run.
- **`init --target <path> [--goal "..."]` helper**:
  1. validates path exists and is a git repo
  2. sets `workspacePath` in lab.config.json
  3. writes PROJECT_GOAL.md — Mode 1 semantics, human-authored text. For
     nexus the natural goal: *"Work in `<path>`. Read its docs/
     (architecture, implementation guide, roadmap) and execute the sprint
     plan."* — or whatever the human writes. Idea-neutrality intact: docs
     are the human's content.

### Tasks

- [ ] Config `workspacePath` + Settings UI input
- [ ] Redirect all workspace consumers through the configured path
- [ ] `OpenCodeDriver.directory` → `query.directory` on create/prompt;
      ground-truth check against SDK types first (docs have drifted before)
- [ ] Harness default `testCmd` → `npm run --if-present test`; treat
      "script not found" as SKIPPED event rather than FAIL
- [ ] `init --target` helper
- [ ] Tests: targeting wires directory into prompt calls; harness skips
      gracefully on scriptless repos; ensureRepo does not re-init nexus

## Exit criteria (both parts)

- With `sessionGc: true`, an overnight-style run leaves ~zero accumulated
  opencode sessions while `lab.db` retains full audit trail
- Colony pointed at nexus: situation reports show nexus diffs, agents read
  its docs and produce commits authored by agent-a/b in nexus's history,
  harness events show SKIPPED/PASS appropriately as they scaffold
- Antfarm's own lab still runs unchanged with default config

## Risks

| Risk | Mitigation |
|---|---|
| Agents wander outside nexus via absolute paths | Acceptable v1 (trusted local env); tool-gateway path scoping is future work |
| query.directory drift between SDK versions | Ground-truth against installed types before building (S11 lesson) |
| Harness FAIL noise on empty repo | `--if-present` defaults + SKIPPED event kind |
| User forgets reset when retargeting | `init --target` warns if sessions exist in lab.db |

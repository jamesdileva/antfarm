# Next run: QA Companion ("case-base" project)

A ready-to-paste mission for a future colony run. Written 2026-08-26.
Taught directly by the parent agents (agent-a, agent-b) — no nursery
prerequisite.

## When to run this

- Any time the colony is idle or freshly reset
- Setup: **preset 1 (Directed)**, no `workspacePath` needed (sandbox works),
  or point `workspacePath` at a dedicated repo once the concept proves out

## Why this project

Every prior project (md-kb, taskline, wcjs) was bounded and finished in a
night. This one is **never done**: it eats every future test run, its case
base compounds nightly, and it has a live accuracy metric instead of vibes.
It is also the first project where the product itself **compounds**: every
failure taught to it is a failure the colony never pays to diagnose again.

---

## PASTE-READY GOAL TEXT

```text
# Mission: build `qacompanion` - a QA companion that learns from our failures

Build a zero-dependency Python CLI (stdlib only, same discipline as taskline)
that accumulates a case base of test failures and their diagnoses, so recurring
failures are recognized instantly and new ones are diagnosed faster over time.

## Core concept

Parents (agent-a, agent-b) are the expensive teachers: their reasoning distills
lessons. qacompanion is the cheap student: it stores cases, matches new
failures against them, and reports what it knows. It never guesses silently -
when confidence is low it says so.

## Storage (exact format)

`cases.jsonl` in the repo root - one JSON object per line:
{ "id": int, "signature": string, "error_excerpt": string,
  "diagnosis": string, "times_seen": int, "last_seen": iso-date,
  "confirmed_by": string }

- signature = normalized failure fingerprint (test name + first line of error,
  whitespace/paths normalized). Two failures match iff signatures are equal.
- Keep the format frozen; v2 may add fields but never renames.

## Subcommands (uniform style, ValueError -> exit 1, nonzero on failure)

- `record --sig SIG --err EXCERPT --diag TEXT [--by NAME]` - add or bump
  times_seen on an existing matching signature
- `lookup --sig SIG` - print best case (highest times_seen) or
  `no matching case` (never fabricate)
- `report` - table: total cases, top 5 by times_seen, stale cases (>30d),
  and accuracy score (below)
- `accuracy` - replay `holdout.jsonl` (a fixed set of past failures you set
  aside at creation): percentage where lookup() returned the right diagnosis.
  Print the number; this metric must be re-runnable forever.
- `export` / `import` - round-trip the case base safely (no-locking copies)

## Teacher loop (how learning actually happens)

After any real test run with failures: record each failure, then attempt
diagnoses. Parents REVIEW the diagnoses; corrections overwrite the stored
diagnosis and increment times_seen. A correction without a stored case creates
one. This loop is the product - run it every cycle there were failures.

## Constraints

- Stdlib only (mirror taskline discipline). No web UI. No LLM calls.
- Slices: storage+record -> lookup -> report -> accuracy -> export/import ->
  teacher-loop docs. One committable slice per cycle, tests green before
  commit, clean tree at end of cycle.
- Accuracy honesty: if holdout accuracy drops after a change, say so in the
  cycle summary rather than hiding it.
```

---

## Whole-project definition of done

- [ ] All six subcommands shipped, uniform exit/error behavior
- [ ] Holdout accuracy reported and >= 80% on the initial case set
- [ ] One full teacher loop exercised live (failure -> record -> parent
      correction -> improved diagnosis on repeat)
- [ ] README with usage; DECISIONS.md entries for any parked choices

## Notes

- Human authorship of this goal is legitimate direction (Mode 1); the
  idea-neutrality rule binds the platform, not the human.
- If the colony finishes early, natural follow-up TASK: integrate
  `record` into the harness flow so failures are captured automatically.

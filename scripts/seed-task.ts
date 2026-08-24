import { openDb } from '@antfarm/db';

const db = openDb('project/lab.db');
const now = new Date().toISOString();

const desc = [
  'Requirements:',
  "1. Adapt the antfarm Sentinel playbook (Tier 0 contract) to THIS project's approved stack: Tauri 2.0+ (Rust shell), NOT Electron.",
  '2. Must cover: bare-shell npx-prefixed scripts (dev/build/test) green on fresh clone; packaged exe at src-tauri/target/release/*.exe; startup milestones logged; cleanup contract (taskkill by exe name); preflight checklist.',
  '3. No Electron-specific rules (.cjs main, electron-builder layouts, HashRouter) unless explicitly justified as dev-fallback-only.',
  '4. Acceptance: doc exists at docs/integration.md, internally consistent with 01_Master_Architecture.md, and every command referenced actually runs from repo root.',
].join('\n');

const info = db
  .prepare(
    `INSERT INTO tasks (title, description, state, owner, created_by, created_at, updated_at, artifact_refs)
     VALUES (?, ?, 'proposed', NULL, 'human', ?, ?, '[]')`
  )
  .run(
    'Author docs/integration.md — Tauri-adapted Sentinel integration playbook',
    desc,
    now,
    now
  );
console.log('inserted task', info.lastInsertRowid);

const mail = db.prepare(
  `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority, subject, body, refs, status, created_at)
   VALUES (?, 'human', ?, 'STATUS', 1, ?, ?, '[]', 'queued', ?)`
);
const t = randomUUID();
function randomUUID(): string {
  return crypto.randomUUID();
}
import { randomUUID as uuid } from 'node:crypto';
mail.run(uuid(), 'agent-a', 'from the human: commit cadence + new board task',
  'Two things: (1) COMMIT YOUR WORK — 66 files untracked is a data-loss risk. Commit incrementally with clear messages each cycle; this is now standing policy. (2) New board task: author a Tauri-adapted docs/integration.md (yes, human-requested — see board).', now);
mail.run(uuid(), 'agent-b', 'from the human: commit cadence + new board task',
  'Two things: (1) COMMIT YOUR WORK — 66 files untracked is a data-loss risk. Commit incrementally with clear messages each cycles; this is now standing policy. (2) New board task: author a Tauri-adapted docs/integration.md (human-requested; your out-of-scope concern is addressed by rewriting it for Tauri).', now);
console.log('queued 2 human mails');
db.close();

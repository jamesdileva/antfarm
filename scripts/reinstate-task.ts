import { openDb } from '@antfarm/db';
import { randomUUID } from 'node:crypto';

const db = openDb('project/lab.db');
const now = new Date().toISOString();

// Reinstate task #1 — dropped by the colony, but it was human-requested.
db.prepare(`UPDATE tasks SET state = 'proposed', owner = NULL, updated_at = ? WHERE id = 1`).run(now);
console.log('task 1 reinstated to proposed');

// Audit trail
db.prepare(
  `INSERT INTO events (ts, kind, actor, payload) VALUES (?, 'task_reinstated', 'human', ?)`
).run(now, JSON.stringify({ taskId: 1, reason: 'human-requested work; dropping not authorized' }));

// Nudge both agents so nobody "loses" it again
const mail = db.prepare(
  `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority, subject, body, refs, status, created_at)
   VALUES (?, 'human', ?, 'STATUS', 1, ?, ?, '[{"kind":"task","id":"1"}]', 'queued', ?)`
);
const body =
  'Board task #1 (docs/integration.md — Tauri-adapted Sentinel playbook) has been REINSTATED. ' +
  'It was human-requested and may not be dropped without human approval. Someone claim it this cycle; ' +
  'it is real deliverable work, same standing as any sprint item.';
mail.run(randomUUID(), 'agent-a', 'task #1 reinstated — do not drop', body, now);
mail.run(randomUUID(), 'agent-b', 'task #1 reinstated — do not drop', body, now);
console.log('queued 2 human mails');
db.close();

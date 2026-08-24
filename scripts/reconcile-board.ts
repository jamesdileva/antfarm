import { openDb, createRepos } from '@antfarm/db';
import { randomUUID } from 'node:crypto';

const db = openDb('project/lab.db');
const r = createRepos(db);
const now = new Date().toISOString();

// Human bookkeeping: reconcile board rows with verified git reality.
// Evidence: nexus git log (commits listed per task) + reviewer verification mails.
const actions: Array<{ id: number; state: 'done' | 'dropped'; why: string }> = [
  { id: 2, state: 'done', why: 'collector fix committed (711b974), reviewer-verified HEAD green' },
  { id: 4, state: 'done', why: 'lifespan/error-handler tests committed (398e005); main.py coverage 100%' },
  { id: 5, state: 'done', why: 'Vitest infra landed with S8 dashboard (457dc2f)' },
  { id: 6, state: 'dropped', why: 'duplicate of task #4' },
];

for (const a of actions) {
  r.tasks.move('orchestrator', a.id, a.state);
  r.events.append({
    ts: now,
    kind: 'task_reconciled',
    actor: 'human',
    payload: JSON.stringify({ taskId: a.id, state: a.state, evidence: a.why }),
  } as never);
  console.log(`#${a.id} -> ${a.state} (${a.why})`);
}

const mail = db.prepare(
  `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority, subject, body, refs, status, created_at)
   VALUES (?, 'human', ?, 'STATUS', 2, ?, ?, '[]', 'queued', ?)`
);
for (const to of ['agent-a', 'agent-b']) {
  mail.run(
    randomUUID(),
    to,
    'board reconciled by human',
    'I audited the board against nexus git history: #2/#4/#5 marked done (commit hashes on record), ' +
      '#6 dropped as duplicate of #4. Task #7 (CORS hardening) remains genuinely open — it is the only ' +
      'pre-Phase-0 review item not yet evidenced in a commit. Please keep board states current going forward; ' +
      'the platform now supports finishing without ceremony.',
    now
  );
}
console.log('queued 2 reconciliation mails');
db.close();

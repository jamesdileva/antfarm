import { openDb } from '@antfarm/db';
import { randomUUID } from 'node:crypto';

const db = openDb('project/lab.db');
const now = new Date().toISOString();

const body =
  'From the human, standing policy effective now:\n' +
  'You are GRANTED permission to PUSH to origin after every verified-green milestone.\n' +
  'Rules: (1) only push when your own test suite is green and your reviewer has verified HEAD, ' +
  '(2) never force-push, (3) push incrementally — do not batch multiple milestones into one push.\n' +
  'This applies to both of you. Local-only commits are no longer sufficient.';

const mail = db.prepare(
  `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority, subject, body, refs, status, created_at)
   VALUES (?, 'human', ?, 'STATUS', 1, 'standing policy: you may push to origin', ?, '[]', 'queued', ?)`
);

mail.run(randomUUID(), 'agent-a', body, now);
mail.run(randomUUID(), 'agent-b', body, now);
console.log('queued 2 human mails (push permission)');
db.close();

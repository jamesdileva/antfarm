import { openDb } from '@antfarm/db';
import { randomUUID } from 'node:crypto';

const db = openDb('project/lab.db');
const now = new Date().toISOString();

const body =
  'From the human: origin is falling behind. ~26 commits are on local main but NOT on GitHub.\n' +
  'You already have standing permission to push after verified-green milestones — please use it this cycle:\n' +
  'run `git push origin main` from the repo root.\n' +
  'If the push fails for ANY reason (auth, network, permissions), file a HELP mail immediately with the exact error output so I can fix it.';

const mail = db.prepare(
  `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority, subject, body, refs, status, created_at)
   VALUES (?, 'human', ?, 'STATUS', 1, 'ACTION: push origin now (26 commits behind)', ?, '[{"kind":"file","id":"."}]', 'queued', ?)`
);

mail.run(randomUUID(), 'agent-a', body, now);
mail.run(randomUUID(), 'agent-b', body, now);
console.log('queued 2 human mails (push now + report failures)');
db.close();

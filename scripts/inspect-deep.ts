import { openDb, createRepos } from '@antfarm/db';
import { simpleGit } from 'simple-git';

const db = openDb('project/lab.db');
const r = createRepos(db);

console.log('=== tasks ===');
for (const t of r.tasks.list()) console.log(`#${t.id} [${t.state}] ${t.title} owner=${t.owner} by=${t.created_by}`);

console.log('\n=== decisions ===');
for (const e of r.events.byKind('decision_logged')) {
  const p = JSON.parse(e.payload);
  console.log(`D#${e.id} ${p.from}: ${p.subject}`);
}

console.log('\n=== last 15 mails ===');
const filed = r.events.byKind('mail_filed').slice(-15).reverse();
for (const e of filed) {
  const p = JSON.parse(e.payload);
  console.log(`${e.ts.slice(11, 19)} ${p.type.padEnd(8)} ${e.actor} -> ${p.to}: ${p.subject.slice(0, 60)}`);
}

console.log('\n=== escalations/contests ===');
for (const k of ['mail_escalated', 'thread_contested', 'task_stuck', 'task_move_rejected', 'permission_denied']) {
  const evs = r.events.byKind(k);
  if (evs.length) console.log(k, evs.length, '| last:', evs.at(-1)!.payload.slice(0, 110));
}

console.log('\n=== workspace git log ===');
try {
  const git = simpleGit({ baseDir: 'project/workspace' });
  const log = await git.log({ maxCount: 12 });
  for (const c of log.all) console.log(c.date?.slice(0, 16), c.authorName?.padEnd(9), c.message.slice(0, 60));
  const status = await git.status();
  console.log('dirty files:', status.files.length);
} catch (err) {
  console.log('(workspace git error)', (err as Error).message.slice(0, 100));
}
db.close();

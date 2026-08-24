import { openDb, createRepos } from '@antfarm/db';

const db = openDb('project/lab.db');
const r = createRepos(db);

console.log('=== last 12 mails ===');
const filed = r.events.byKind('mail_filed').slice(-12).reverse();
for (const e of filed) {
  const p = JSON.parse(e.payload);
  console.log(`${e.ts.slice(11, 19)} ${p.type.padEnd(8)} ${e.actor} -> ${p.to}: ${p.subject.slice(0, 70)}`);
}

console.log('\n=== last 6 sessions ===');
for (const s of r.sessions.list().slice(-6)) {
  console.log(`#${s.id} ${s.agent} ${s.status} c${s.cycle} | ${(s.summary ?? '').slice(0, 80)}`);
}

console.log('\n=== board ===');
for (const t of r.tasks.list()) console.log(`#${t.id} [${t.state}] ${t.title.slice(0, 60)} owner=${t.owner}`);

db.close();

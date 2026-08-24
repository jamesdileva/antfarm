import { openDb, createRepos } from '@antfarm/db';

const db = openDb('project/lab.db');
const r = createRepos(db);
const sessions = r.sessions.list();
console.log('total sessions:', sessions.length);
console.log('=== last 8 ===');
for (const s of sessions.slice(-8)) {
  console.log(`#${s.id} ${s.agent} ${s.status} c${s.cycle} ${s.started_at} -> ${s.ended_at ?? ''} | ${(s.summary ?? '').slice(0, 60)}`);
}
for (const k of ['cycle_skipped', 'cycle_failed', 'cycle_timed_out']) {
  const evs = r.events.byKind(k);
  if (evs.length) console.log(`${k}: ${evs.length}, last:`, evs.at(-1)!.payload.slice(0, 140));
}
const all = r.events.all();
console.log('=== last 5 events ===');
for (const e of all.slice(-5)) console.log(' ', e.ts, e.kind, e.actor);
db.close();

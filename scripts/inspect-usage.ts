import { openDb, createRepos } from '@antfarm/db';

const db = openDb('project/lab.db');
const r = createRepos(db);

const kinds = [
  'decision_logged', 'task_created', 'task_moved', 'task_move_rejected',
  'build_result', 'test_result', 'mail_filed', 'cycle_done', 'cycle_timed_out', 'cycle_failed',
];
console.log('kind'.padEnd(20), 'count');
for (const k of kinds) {
  console.log(k.padEnd(20), String(r.events.byKind(k).length).padStart(5));
}

console.log('\n=== decisions timeline ===');
for (const e of r.events.byKind('decision_logged')) {
  console.log(e.ts.slice(5, 16), JSON.parse(e.payload).from.padEnd(7), JSON.parse(e.payload).subject.slice(0, 60));
}

console.log('\n=== task events timeline ===');
for (const e of [...r.events.byKind('task_created'), ...r.events.byKind('task_moved')].sort((a, b) => a.id - b.id)) {
  const p = JSON.parse(e.payload);
  console.log(e.ts.slice(5, 16), e.kind.padEnd(13), 'task#' + p.taskId, p.state ?? '', e.actor);
}

console.log('\n=== harness results timeline (last 10) ===');
for (const e of r.events.all().filter((x) => x.kind === 'build_result' || x.kind === 'test_result').slice(-10)) {
  const p = JSON.parse(e.payload);
  console.log(e.ts.slice(5, 16), e.kind.padEnd(13), p.skipped ? 'SKIPPED' : p.ok ? 'PASS' : 'FAIL');
}
db.close();

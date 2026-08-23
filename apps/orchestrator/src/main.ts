import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRepos, openDb } from '@antfarm/db';
import { Budgets } from './budgets.js';
import { FakeDriver } from './drivers/fake.js';
import { runLoop } from './loop.js';
import type { OrchestratorDeps } from './cycle.js';

const demoScripts = {
  'agent-a': [
    {
      mails: [{ to: 'agent-b', type: 'IDEA', subject: 'MVP proposal', body: 'Local markdown notes with full-text search.' }],
      taskMoves: [],
      summary: 'proposed MVP',
    },
    {
      mails: [],
      taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-a' }],
      summary: 'starting backend',
    },
  ],
  'agent-b': [
    {
      mails: [{ to: 'agent-a', type: 'REVIEW', subject: 'Scope too broad', body: 'Agreed with notes MVP. Created task #1 for the spec.', priority: 3 }],
      taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-b' }],
      summary: 'reviewed, created task',
    },
  ],
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  if (!dryRun) {
    console.error('Only --dry-run is supported until the OpenCode driver lands (Sprint 2).');
    process.exit(1);
  }

  mkdirSync('project', { recursive: true });
  const db = openDb(join('project', 'lab.db'));
  const repos = createRepos(db);
  const deps: OrchestratorDeps = {
    repos,
    budgets: new Budgets({ maxTokensPerCycle: 2000, maxCyclesPerHour: 30 }),
    drivers: { 'agent-a': new FakeDriver(demoScripts), 'agent-b': new FakeDriver(demoScripts) },
    agents: ['agent-a', 'agent-b'],
  };

  // Seed one proposed task so scripted moves have a target.
  if (repos.tasks.list().length === 0) {
    repos.tasks.create('human', { title: 'Write architecture specification' });
  }

  const report = await runLoop(deps);
  console.log(`dry-run complete: ${report.cyclesRun} cycles over ${report.rounds} rounds`);
  console.log(`tasks: ${repos.tasks.list().map((t) => `#${t.id}[${t.state}]`).join(' ')}`);
  console.log(`events logged: ${repos.events.all().length}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

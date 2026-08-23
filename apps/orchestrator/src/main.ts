import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRepos, openDb } from '@antfarm/db';
import { Budgets } from './budgets.js';
import { runLoop } from './loop.js';
import type { OrchestratorDeps } from './cycle.js';
import { FakeDriver } from './drivers/fake.js';
import { OpenCodeDriver } from './drivers/opencode.js';
import { Workspace, workspacePath } from './workspace.js';
import { seedGoal } from './goal.js';
import { recoverOrphans } from './recover.js';
import { loadConfig, type LabConfig } from './config.js';
import { harnessSummary, runHarness } from './harness.js';

export const PROJECT_ROOT = 'project';

const demoScripts = {
  'agent-a': [
    {
      mails: [{ to: 'agent-b', type: 'IDEA', subject: 'MVP proposal', body: 'Local markdown notes with full-text search.' }],
      taskMoves: [],
      summary: 'proposed MVP',
    },
    {
      mails: [{ to: 'agent-b', type: 'STATUS', subject: 'spec received', body: 'Starting backend work per your spec.' }],
      taskMoves: [],
      summary: 'starting backend',
    },
  ],
  'agent-b': [
    {
      mails: [{ to: 'agent-a', type: 'DECISION', subject: 'Scope agreed: notes MVP', body: 'MVP is local markdown notes with full-text search. Task #1 tracks the spec.', priority: 3 }],
      taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-b' }],
      summary: 'reviewed, decided scope, claimed spec task',
    },
  ],
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function init(): Promise<void> {
  const goal = argValue('--goal');
  if (!goal) {
    console.error('usage: npm start -- init --goal "<text>"   (Mode 1: the human authors the goal)');
    process.exit(1);
  }
  mkdirSync(PROJECT_ROOT, { recursive: true });
  const path = seedGoal(PROJECT_ROOT, goal);
  console.log(`goal seeded: ${path}`);
}

async function makeDeps(dbPath: string, live: boolean): Promise<OrchestratorDeps> {
  const cfg: LabConfig = loadConfig();
  const projectRoot = cfg.projectRoot;
  mkdirSync(projectRoot, { recursive: true });
  const db = openDb(dbPath);
  const swept = recoverOrphans(db);
  if (swept > 0) console.log(`orphan recovery: swept ${swept} stale running session(s)`);
  const repos = createRepos(db);

  if (live) {
    const workspace = new Workspace(workspacePath(projectRoot));
    await workspace.ensureRepo();
    const drivers: OrchestratorDeps['drivers'] = {};
    for (const agent of ['agent-a', 'agent-b']) {
      drivers[agent] = new OpenCodeDriver({ driveSheet: OpenCodeDriver.sheetFor(agent) });
    }
    return {
      repos,
      budgets: new Budgets(cfg.budgets),
      drivers,
      agents: ['agent-a', 'agent-b'],
      situation: {
        projectRoot,
        mode: cfg.mode,
        workspaceSummary: await workspace.diffSummary(),
      },
      signals: async (agent) => ({ ownedTaskChanged: false, workspaceChanged: await workspace.poll(agent) }),
      onCycleDone: async (agent) => {
        await workspace.markSeen(agent);
        // refresh checks between cycles so agents see fresh PASS/FAIL
        await runHarness(repos, {
          workspaceDir: workspacePath(projectRoot),
          buildCmd: cfg.harness.buildCmd ?? 'npm run --if-present build',
          testCmd: cfg.harness.testCmd ?? 'npm test',
          timeoutMs: cfg.harness.timeoutMs,
        });
      },
      cycleTimeoutMs: cfg.cycleTimeoutMs,
      usageFor: () => ({ tokensIn: 0, tokensOut: 0 }),
    };
  }

  return {
    repos,
    budgets: new Budgets({ maxTokensPerCycle: 2000, maxCyclesPerHour: 30 }),
    drivers: { 'agent-a': new FakeDriver(demoScripts), 'agent-b': new FakeDriver(demoScripts) },
    agents: ['agent-a', 'agent-b'],
    situation: { projectRoot },
  };
}

async function run(): Promise<void> {
  const live = hasFlag('--live');
  const dryRun = hasFlag('--dry-run');
  if (!live && !dryRun) {
    console.error('usage: npm start -- --dry-run | --live');
    process.exit(1);
  }
  if (live && !process.env.ANTFARM_LIVE_SMOKE) {
    console.error('live mode burns tokens — set ANTFARM_LIVE_SMOKE=1 to confirm');
    process.exit(1);
  }

  const deps = await makeDeps(join(loadConfig().projectRoot, 'lab.db'), live);

  // Seed one proposed task so scripted moves have a target (dry-run only).
  if (!live && deps.repos.tasks.list().length === 0) {
    deps.repos.tasks.create('human', { title: 'Write architecture specification' });
  }

  const report = await runLoop(deps);
  console.log(`${live ? 'live' : 'dry'}-run complete: ${report.cyclesRun} cycles over ${report.rounds} rounds`);
  console.log(`tasks: ${deps.repos.tasks.list().map((t) => `#${t.id}[${t.state}]`).join(' ')}`);
  const decisions = deps.repos.events.byKind('decision_logged');
  if (decisions.length) {
    const lastDecision = JSON.parse(decisions.at(-1)!.payload) as { subject: string };
    console.log(`decisions logged: ${decisions.length} (latest: "${lastDecision.subject}")`);
  }
  for (const line of harnessSummary(deps.repos)) console.log(line);
  console.log(`events logged: ${deps.repos.events.all().length}`);
  if (report.skipped.length) console.log(`skipped: ${report.skipped.join(', ')}`);
  if (report.stucked.length) console.log(`stuck tasks swept: ${report.stucked.join(', ')}`);
  if (report.contested) console.log(`contested threads: ${report.contested}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  // `run` is also the implicit command when only flags are passed
  if (cmd === 'init') await init();
  else if (cmd === undefined || cmd === 'run' || cmd.startsWith('--')) await run();
  else {
    console.error(`unknown command: ${cmd} (try: init | run)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

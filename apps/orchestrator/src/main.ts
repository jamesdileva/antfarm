import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRepos, openDb } from '@antfarm/db';
import { Budgets } from './budgets.js';
import { runLoop } from './loop.js';
import type { OrchestratorDeps } from './cycle.js';
import { FakeDriver } from './drivers/fake.js';
import { OpenCodeDriver, createManagedClient, assertServerHealthy } from './drivers/opencode.js';
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
    // Spawn a managed OpenCode server (createOpencode) — do NOT assume an
    // external one is listening (S7 rerun lesson: "fetch failed").
    const managed = await createManagedClient();
    const version = await assertServerHealthy(managed.serverUrl);
    console.log(`opencode server up (v${version}) at ${managed.serverUrl}`);
    const shutdown = (): void => {
      try {
        managed.close();
      } catch {
        /* best effort */
      }
    };
    process.once('exit', shutdown);
    for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM'] as NodeJS.Signals[]) {
      try {
        process.once(sig, () => {
          shutdown();
          process.exit(0);
        });
      } catch {
        /* signal unsupported on this platform */
      }
    }

    const workspace = new Workspace(workspacePath(projectRoot));
    await workspace.ensureRepo();

    // Cold-start bootstrap: a pristine lab has zero wake triggers (no mail,
    // empty workspace). Idea-neutral kickoff — announces the environment,
    // never suggests what to do in it.
    if (repos.sessions.list().length === 0 && repos.mail.queuedFor('agent-a').length === 0) {
      for (const agent of ['agent-a', 'agent-b'] as const) {
        repos.mail.enqueue('orchestrator', {
          to: agent,
          type: 'STATUS',
          subject: 'laboratory open',
          body: 'The shared workspace is ready. Your situation reports carry everything you need.',
          priority: 3,
        });
      }
    }

    const drivers: OrchestratorDeps['drivers'] = {};
    for (const agent of ['agent-a', 'agent-b']) {
      drivers[agent] = new OpenCodeDriver({
        client: managed.client,
        driveSheet: OpenCodeDriver.sheetFor(agent),
        personality: cfg.personalities[agent],
      });
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

  // failure visibility: a stall is only mysterious if we hide the reasons
  const failed = deps.repos.sessions.list().filter((s) => s.status === 'failed' || s.status === 'timed_out');
  for (const agent of deps.agents) {
    const lastFailed = failed.filter((s) => s.agent === agent).at(-1);
    if (lastFailed) console.log(`${agent}: last failure [${lastFailed.status}] ${lastFailed.summary ?? '(no detail)'}`);
  }
  if (!failed.length && report.cyclesRun > 0) console.log('no failed or timed-out sessions');

  console.log(`events logged: ${deps.repos.events.all().length}`);
  if (report.skipped.length) console.log(`skipped: ${report.skipped.join(', ')}`);
  if (report.stucked.length) console.log(`stuck tasks swept: ${report.stucked.join(', ')}`);
  if (report.contested) console.log(`contested threads: ${report.contested}`);
}

async function reset(): Promise<void> {
  const cfg = loadConfig();
  const all = hasFlag('--yes');
  const dbPath = join(cfg.projectRoot, 'lab.db');
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  console.log(`removed ${dbPath}`);
  if (all) {
    rmSync(cfg.projectRoot, { recursive: true, force: true });
    console.log(`removed ${cfg.projectRoot}/ entirely (--yes)`);
  } else {
    console.log('workspace/shared/agent dirs kept; pass --yes to wipe the whole project/ tree');
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  // `run` is also the implicit command when only flags are passed
  if (cmd === 'init') await init();
  else if (cmd === 'reset') await reset();
  else if (cmd === undefined || cmd === 'run' || cmd.startsWith('--')) await run();
  else {
    console.error(`unknown command: ${cmd} (try: init | reset | run)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

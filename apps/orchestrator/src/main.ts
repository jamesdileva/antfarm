import { mkdirSync, existsSync, rmSync } from 'node:fs';
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
import { BabyDriver } from './drivers/baby.js';
import { auditNursery, babyStats } from './nursery.js';

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
    const managed = await createManagedClient({ model: cfg.model });
    const version = await assertServerHealthy(managed.serverUrl);
    console.log(`opencode server up (v${version}) at ${managed.serverUrl}${cfg.model ? ` · model: ${cfg.model}` : ''}`);
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
    // Nursery actors join the same scheduler loop with their own runtime
    const babies = repos.nursery.alive();
    for (const baby of babies) {
      drivers[baby.id] = new BabyDriver(baby.id, repos, workspace, projectRoot);
    }
    return {
      repos,
      budgets: new Budgets(cfg.budgets, cfg.exhaustionCooldownMs),
      drivers,
      agents: ['agent-a', 'agent-b', ...babies.map((b) => b.id)],
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

  const cfg = loadConfig();
  // Isolation rule: dry-run NEVER shares a database with live runs —
  // demo fixtures must not leak into real experiments (S8 lesson).
  const dbName = live ? 'lab.db' : 'lab-dryrun.db';
  const deps = await makeDeps(join(cfg.projectRoot, dbName), live);

  // Seed one proposed task so scripted moves have a target (dry-run only).
  if (!live && deps.repos.tasks.list().length === 0) {
    deps.repos.tasks.create('human', { title: 'Write architecture specification' });
  }

  const report = await runLoop(deps, live
    ? { persistent: true, idleTickMs: cfg.idleTickMs, maxRounds: 1_000_000 }
    : {});
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

async function nurseryCmd(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = join(cfg.projectRoot, 'lab.db');
  if (!existsSync(dbPath)) {
    console.error(`no lab database at ${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  const repos = createRepos(db);
  const babies = repos.nursery.alive();

  if (!babies.length) {
    console.log('nursery: no living nursery agents');
    db.close();
    return;
  }

  for (const baby of babies) {
    const stats = babyStats(repos, cfg.projectRoot, baby.id);
    const creators = JSON.parse(baby.created_by).join(', ');
    console.log(`${baby.id} "${baby.name}" — stage ${baby.stage} (${baby.runtime})`);
    console.log(`  parents: ${creators}`);
    console.log(`  purpose: ${baby.purpose}`);
    console.log(
      `  stats: cycles=${stats.cycles} reports=${stats.reportsFiled} ` +
        `observations=${stats.observationsLogged} permission_denials=${stats.permissionDenials}`
    );
  }

  const audit = auditNursery(repos, cfg.projectRoot);
  const failures = audit.filter((a) => !a.ok);
  console.log(`idea-neutrality audit: ${audit.length - failures.length}/${audit.length} traced`);
  for (const fail of failures) console.log(`  FAIL ${fail.id}: ${fail.reason}`);
  db.close();
}

function stats(): void {
  const cfg = loadConfig();
  const dbPath = join(cfg.projectRoot, 'lab.db');
  if (!existsSync(dbPath)) {
    console.error(`no lab database at ${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  const repos = createRepos(db);
  const sessions = repos.sessions.list();

  console.log(`sessions: ${sessions.length}`);
  const perAgent = new Map<string, { tokens: number; cost: number; cycles: number; models: Set<string> }>();
  for (const s of sessions) {
    const agg = perAgent.get(s.agent) ?? { tokens: 0, cost: 0, cycles: 0, models: new Set<string>() };
    agg.tokens += s.tokens_in + s.tokens_out;
    agg.cost += s.cost;
    if (s.status === 'done') agg.cycles++;
    if (s.model) agg.models.add(s.model);
    perAgent.set(s.agent, agg);
  }
  for (const [agent, a] of perAgent) {
    console.log(
      `${agent}: ${a.cycles} completed cycles · ${a.tokens.toLocaleString()} tokens · $${a.cost.toFixed(4)}` +
        ` · models: ${[...a.models].join(', ') || 'n/a'}`
    );
  }

  console.log('\nrecent sessions:');
  for (const s of sessions.slice(-10)) {
    console.log(
      `#${s.id} ${s.agent} ${s.status} c${s.cycle} in=${s.tokens_in} out=${s.tokens_out} ` +
        `$${s.cost.toFixed(4)} ${s.model || ''} | ${(s.summary ?? '').slice(0, 50)}`
    );
  }
  db.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  // `run` is also the implicit command when only flags are passed
  if (cmd === 'init') await init();
  else if (cmd === 'reset') await reset();
  else if (cmd === 'nursery') await nurseryCmd();
  else if (cmd === 'stats') stats();
  else if (cmd === undefined || cmd === 'run' || cmd.startsWith('--')) await run();
  else {
    console.error(`unknown command: ${cmd} (try: init | reset | nursery | stats | run)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

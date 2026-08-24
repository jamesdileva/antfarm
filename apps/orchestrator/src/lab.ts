import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRepos, openDb, type Repos } from '@antfarm/db';
import { Budgets } from './budgets.js';
import { FakeDriver } from './drivers/fake.js';
import { OpenCodeDriver, assertServerHealthy, createManagedClient } from './drivers/opencode.js';
import { BabyDriver } from './drivers/baby.js';
import { Workspace } from './workspace.js';
import { runHarness } from './harness.js';
import { loadConfig, type LabConfig } from './config.js';
import { recoverOrphans } from './recover.js';
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
      taskMoves: [{ taskId: 1, state: 'active', owner: 'agent-b' }],
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

export interface BuiltLab {
  deps: OrchestratorDeps;
  repos: Repos;
  cfg: LabConfig;
  /** release live resources (managed opencode server) and close the DB */
  close: () => void;
}

/**
 * Build orchestrator deps for a colony run — shared by the CLI and serve
 * mode so GUI-started colonies behave identically to CLI-started ones.
 * `projectRoot` must be resolved by the caller (ANTFARM_HOME-aware).
 */
export async function buildDeps(opts: {
  dbPath: string;
  projectRoot: string;
  live: boolean;
}): Promise<BuiltLab> {
  const cfg = loadConfig();
  mkdirSync(opts.projectRoot, { recursive: true });
  const db = openDb(opts.dbPath);
  const swept = recoverOrphans(db);
  if (swept > 0) console.log(`orphan recovery: swept ${swept} stale running session(s)`);
  const repos = createRepos(db);

  if (!opts.live) {
    return {
      deps: dryRunDeps(repos, opts.projectRoot),
      repos,
      cfg,
      close: () => db.close(),
    };
  }

  // --- live colony ---
  const wsDir = cfg.workspacePath ?? join(opts.projectRoot, 'workspace');
  const workspace = new Workspace(wsDir);
  await workspace.ensureRepo();

  // Cold-start bootstrap: pristine labs have zero wake triggers (S7 lesson).
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

  console.log('spawning managed opencode server...');
  const managed = await createManagedClient({ model: cfg.model });
  const version = await assertServerHealthy(managed.serverUrl);
  console.log(`opencode server up (v${version})${cfg.model ? ` · model: ${cfg.model}` : ''}`);

  const drivers: OrchestratorDeps['drivers'] = {};
  for (const agent of ['agent-a', 'agent-b'] as const) {
    drivers[agent] = new OpenCodeDriver({
      client: managed.client,
      driveSheet: OpenCodeDriver.sheetFor(agent),
      personality: cfg.personalities[agent],
      directory: wsDir,
    });
  }
  for (const baby of repos.nursery.alive()) {
    drivers[baby.id] = new BabyDriver(baby.id, repos, workspace, opts.projectRoot);
  }

  return {
    deps: {
      repos,
      budgets: new Budgets(cfg.budgets, cfg.exhaustionCooldownMs),
      drivers,
      agents: ['agent-a', 'agent-b', ...repos.nursery.alive().map((b) => b.id)],
      situation: {
        projectRoot: opts.projectRoot,
        mode: cfg.mode,
        workspaceDir: wsDir,
        workspaceSummary: await workspace.diffSummary(),
      },
      signals: async (agent) => ({
        ownedTaskChanged: false,
        workspaceChanged: await workspace.poll(agent),
      }),
      onCycleDone: async (agent) => {
        await workspace.markSeen(agent);
        await runHarness(repos, {
          workspaceDir: wsDir,
          buildCmd: cfg.harness.buildCmd ?? 'npm run --if-present build',
          testCmd: cfg.harness.testCmd ?? 'npm run --if-present test',
          timeoutMs: cfg.harness.timeoutMs,
        });
      },
      cycleTimeoutMs: cfg.cycleTimeoutMs,
    },
    repos,
    cfg,
    close: () => {
      try {
        managed.close();
      } catch {
        /* best effort */
      }
      db.close();
    },
  };

  function dryRunDeps(repos: Repos, root: string): OrchestratorDeps {
    return {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 2000, maxCyclesPerHour: 30 }),
      drivers: { 'agent-a': new FakeDriver(demoScripts), 'agent-b': new FakeDriver(demoScripts) },
      agents: ['agent-a', 'agent-b', ...repos.nursery.alive().map((b) => b.id)],
      situation: { projectRoot: root },
    };
  }
}

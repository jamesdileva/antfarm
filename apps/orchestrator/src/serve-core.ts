import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop, type LoopReport } from './loop.js';
import { buildDeps } from './lab.js';
import { loadConfigFrom, writeConfig, type LabConfig } from './config.js';
import { homePaths } from './home.js';
import { seedGoal, GOAL_FILE } from './goal.js';
import { openDb, createRepos, type Repos } from '@antfarm/db';

export type ColonyState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface ColonyStatus {
  state: ColonyState;
  live: boolean;
  startedAt: string | null;
  lastReport: LoopReport | null;
  lastError: string | null;
}

/**
 * Owns colony lifecycle for serve mode — GUI and CLI share identical
 * behavior because both go through buildDeps/runLoop.
 */
export class ColonyManager {
  private state: ColonyState = 'stopped';
  private live = false;
  private startedAt: string | null = null;
  private lastReport: LoopReport | null = null;
  private lastError: string | null = null;
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  status(): ColonyStatus {
    return {
      state: this.state,
      live: this.live,
      startedAt: this.startedAt,
      lastReport: this.lastReport,
      lastError: this.lastError,
    };
  }

  async start(live: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.state !== 'stopped') {
      return { ok: false, error: `colony is ${this.state}` };
    }
    this.state = 'starting';
    try {
      const cfg = loadConfigFrom(homePaths().config);
      const paths = homePaths(cfg.projectRoot);
      const built = await buildDeps({
        dbPath: paths.db(live ? 'lab.db' : 'lab-dryrun.db'),
        projectRoot: paths.project,
        live,
      });
      // dry-run convenience: scripted moves need a target task
      if (!live && built.repos.tasks.list().length === 0) {
        built.repos.tasks.create('human', { title: 'Write architecture specification' });
      }

      const controller = new AbortController();
      this.controller = controller;
      this.live = live;
      this.startedAt = new Date().toISOString();
      this.state = 'running';

      const loopOpts = live
        ? { persistent: true as const, idleTickMs: cfg.idleTickMs, maxRounds: 1_000_000, signal: controller.signal }
        : { maxRounds: 100_000, signal: controller.signal };

      this.loopPromise = runLoop(built.deps, loopOpts)
        .then((report) => {
          this.lastReport = report;
        })
        .catch((err) => {
          this.lastError = String(err).slice(0, 300);
        })
        .finally(() => {
          this.state = 'stopped';
          this.controller = null;
          this.loopPromise = null;
          built.close();
        });
      return { ok: true };
    } catch (err) {
      this.state = 'stopped';
      this.lastError = String(err).slice(0, 300);
      return { ok: false, error: String(err).slice(0, 300) };
    }
  }

  async stop(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.controller || !this.loopPromise) {
      return { ok: false, error: 'colony not running' };
    }
    this.state = 'stopping';
    this.controller.abort();
    await this.loopPromise;
    return { ok: true };
  }
}

// --- lab lifecycle operations shared with CLI semantics ---

export function initLab(input: {
  goal?: string;
  mode?: 'directed' | 'constrained';
  target?: string;
  clearGoal?: boolean;
}): { ok: true; message: string } | { ok: false; error: string } {
  const paths = homePaths(loadConfigFrom(homePaths().config).projectRoot);
  if (input.clearGoal) {
    rmSync(join(paths.project, 'shared', GOAL_FILE), { force: true });
    return { ok: true, message: 'goal cleared — autonomous mode' };
  }
  if (input.target) {
    if (!existsSync(input.target)) return { ok: false, error: `target does not exist: ${input.target}` };
    if (!existsSync(resolve(input.target, '.git'))) {
      return { ok: false, error: `target is not a git repo: ${input.target}` };
    }
    if (existsSync(paths.db())) {
      return { ok: false, error: 'lab.db already exists — reset first (`reset --yes`) for a fresh per-project lab' };
    }
    const cfg: LabConfig = { ...loadConfigFrom(paths.config), workspacePath: resolve(input.target) };
    writeConfig(paths.config, cfg);
  }
  if (input.mode) {
    const cfg: LabConfig = { ...loadConfigFrom(paths.config), mode: input.mode };
    writeConfig(paths.config, cfg);
  }
  let message = '';
  if (input.goal) {
    message += `goal seeded: ${seedGoal(paths.project, input.goal)} `;
  }
  if (input.target) message += 'workspace target set';
  return { ok: true, message: message.trim() || 'lab initialized' };
}

export function currentConfig(): LabConfig {
  return loadConfigFrom(homePaths().config);
}

export function configPath(): string {
  return homePaths().config;
}

// --- human voice: direct mail + task creation from the GUI ---

const AGENTS = ['agent-a', 'agent-b'];
const MAIL_TYPES = ['QUESTION', 'IDEA', 'TASK', 'REVIEW', 'WARNING', 'DECISION', 'STATUS', 'HELP'] as const;

function labRepos(): { repos: Repos; close: () => void } {
  const cfg = loadConfigFrom(homePaths().config);
  const db = openDb(homePaths(cfg.projectRoot).db());
  return { repos: createRepos(db), close: () => db.close() };
}

export interface HumanResult {
  ok: boolean;
  id?: number;
  error?: string;
}

export function humanMail(input: { to?: string; type?: string; subject?: string; body?: string }): HumanResult {
  const to = AGENTS.includes(input.to ?? '') ? input.to! : null;
  if (!to) return { ok: false, error: `to must be one of ${AGENTS.join(', ')}` };
  const type = (MAIL_TYPES as readonly string[]).includes(input.type ?? '') ? (input.type as (typeof MAIL_TYPES)[number]) : 'STATUS';
  const subject = (input.subject ?? '').trim();
  if (!subject) return { ok: false, error: 'subject required' };
  const body = input.body ?? '';
  const { repos, close } = labRepos();
  try {
    const filed = repos.mail.enqueue('human', { to, type, subject, body, priority: 1 });
    repos.events.append({
      kind: 'mail_filed',
      actor: 'human',
      payload: { messageId: filed.id, to, type, subject },
    });
    return { ok: true, id: filed.id };
  } finally {
    close();
  }
}

export function humanTask(input: { title?: string; owner?: string }): HumanResult {
  const title = (input.title ?? '').trim();
  if (!title) return { ok: false, error: 'title required' };
  const owner = AGENTS.includes(input.owner ?? '') ? input.owner! : null;
  const { repos, close } = labRepos();
  try {
    const task = repos.tasks.create('human', { title, owner });
    repos.events.append({
      kind: 'task_created',
      actor: 'human',
      payload: { taskId: task.id, from: 'human', assignedTo: owner },
    });
    return { ok: true, id: task.id };
  } finally {
    close();
  }
}

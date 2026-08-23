import type { Repos } from '@antfarm/db';
import type { AgentDriver } from './driver.js';
import type { ActionsOutputT } from './actions.js';
import type { Budgets } from './budgets.js';
import { buildSituation, type SituationContext } from './situation.js';

export interface OrchestratorDeps {
  repos: Repos;
  budgets: Budgets;
  drivers: Record<string, AgentDriver>;
  agents: string[];
  situation?: SituationContext;
  /** per-agent environment signals polled each round (workspace changes etc.) */
  signals?: (agent: string) => Promise<{ ownedTaskChanged: boolean; workspaceChanged: boolean }>;
  /** called after a successful cycle — e.g. workspace head snapshots */
  onCycleDone?: (agent: string) => Promise<void>;
  usageFor?: (output: ActionsOutputT) => { tokensIn: number; tokensOut: number };
  /** wall-clock cap per cycle; exceeding it marks the session timed_out */
  cycleTimeoutMs?: number;
}

export interface CycleResult {
  agent: string;
  status: 'done' | 'skipped';
  sessionId?: number;
  reason?: string;
  timedOut?: boolean;
  productive?: boolean;
}

const defaultUsage = () => ({ tokensIn: 120, tokensOut: 80 });

class CycleTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`cycle exceeded wall-clock timeout of ${ms}ms`);
  }
}

/** Run exactly one cycle for one agent. */
export async function runCycle(deps: OrchestratorDeps, agent: string, cycle: number): Promise<CycleResult> {
  const { repos, budgets, drivers } = deps;

  const budget = budgets.canRun(agent);
  if (!budget.ok) {
    repos.events.append({ kind: 'cycle_skipped', actor: agent, payload: { reason: budget.reason } });
    return { agent, status: 'skipped', reason: budget.reason };
  }

  const driver = deps.drivers[agent];
  if (!driver) throw new Error(`no driver for ${agent}`);

  const mail = repos.mail.queuedFor(agent);
  repos.mail.markDelivered(mail.map((m) => m.id));
  const situation = buildSituation(repos, agent, deps.situation ?? { projectRoot: 'project' });

  const session = repos.sessions.start({ agent, cycle, goal: driverGoal(deps, agent) });

  let output: ActionsOutputT;
  try {
    output = await withTimeout(
      driver.run({ agent, cycle, situation }),
      deps.cycleTimeoutMs,
      () => void driver.abort?.(agent)
    );
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      repos.sessions.finish(session.id, 'timed_out', {}, err.message);
      repos.events.append({
        kind: 'cycle_timed_out',
        actor: agent,
        payload: { sessionId: session.id, timeoutMs: err.ms },
      });
      return { agent, status: 'done', sessionId: session.id, timedOut: true };
    }
    // Malformed-output teaching loop (guide §4.2): the environment files a
    // WARNING back to the sender instead of dropping the failure silently.
    // Only one outstanding warning per agent — prevents fail↔warn churn.
    repos.sessions.finish(session.id, 'failed', {}, truncate(String(err), 300));
    const hasOutstanding = repos.mail
      .queuedFor(agent)
      .some((m) => m.type === 'WARNING' && m.subject.includes('could not be processed'));
    if (!hasOutstanding) {
      repos.mail.enqueue('orchestrator', {
        to: agent,
        type: 'WARNING',
        subject: 'your last output could not be processed',
        body: `Error: ${truncate(String(err), 300)}. Respond again with actions matching the required schema.`,
        priority: 1,
      });
    }
    repos.events.append({ kind: 'cycle_failed', actor: agent, payload: { error: truncate(String(err), 300) } });
    return { agent, status: 'done', sessionId: session.id, productive: false };
  }

  commitActions(deps, agent, session.id, output);

  const usage = deps.usageFor?.(output) ?? defaultUsage();
  repos.sessions.finish(session.id, 'done', usage, output.summary);
  budgets.recordCycle(agent, usage.tokensIn, usage.tokensOut);
  const productive = output.mails.length + output.taskMoves.length > 0;
  repos.events.append({
    kind: 'cycle_done',
    actor: agent,
    payload: { sessionId: session.id, mails: output.mails.length, taskMoves: output.taskMoves.length },
  });

  return { agent, status: 'done', sessionId: session.id, productive };
}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined, onTimeout: () => void): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new CycleTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function driverGoal(deps: OrchestratorDeps, agent: string): string {
  const sheet = (deps.drivers[agent] as { sheet?: { role?: string } }).sheet;
  return sheet?.role ? `${agent} (${sheet.role}) cycle` : `${agent} cycle`;
}

function commitActions(deps: OrchestratorDeps, agent: string, sessionId: number, output: ActionsOutputT): void {
  const { repos } = deps;
  for (const m of output.mails) {
    const filed = repos.mail.enqueue(agent, m);
    repos.events.append({
      kind: 'mail_filed',
      actor: agent,
      payload: { messageId: filed.id, to: m.to, type: m.type, subject: m.subject },
    });
  }
  for (const move of output.taskMoves) {
    try {
      const task = repos.tasks.move(agent, move.taskId, move.state, move.owner ?? undefined);
      repos.events.append({
        kind: 'task_moved',
        actor: agent,
        payload: { taskId: task.id, state: task.state, sessionId },
      });
    } catch (err) {
      repos.events.append({
        kind: 'task_move_rejected',
        actor: agent,
        payload: { taskId: move.taskId, requested: move.state, error: String(err) },
      });
    }
  }
}

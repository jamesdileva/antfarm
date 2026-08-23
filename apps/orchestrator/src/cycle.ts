import type { Repos } from '@antfarm/db';
import type { AgentDriver } from './driver.js';
import type { ActionsOutputT } from './actions.js';
import type { Budgets } from './budgets.js';
import { buildSituation } from './situation.js';

export interface OrchestratorDeps {
  repos: Repos;
  budgets: Budgets;
  drivers: Record<string, AgentDriver>;
  agents: string[];
  usageFor?: (output: ActionsOutputT) => { tokensIn: number; tokensOut: number };
}

export interface CycleResult {
  agent: string;
  status: 'done' | 'skipped';
  sessionId?: number;
  reason?: string;
}

const defaultUsage = () => ({ tokensIn: 120, tokensOut: 80 });

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
  const situation = buildSituation(repos, agent);
  // markDelivered happened after building the snapshot text; rebuild is
  // unnecessary — queuedFor was captured before marking.

  const session = repos.sessions.start({ agent, cycle, goal: 'scripted dry-run cycle' });

  let output: ActionsOutputT;
  try {
    output = await driver.run({ agent, cycle, situation });
  } catch (err) {
    repos.sessions.finish(session.id, 'failed', {}, String(err));
    repos.events.append({ kind: 'cycle_failed', actor: agent, payload: { error: String(err) } });
    return { agent, status: 'done', sessionId: session.id };
  }

  commitActions(deps, agent, session.id, output);

  const usage = deps.usageFor?.(output) ?? defaultUsage();
  repos.sessions.finish(session.id, 'done', usage, output.summary);
  budgets.recordCycle(agent, usage.tokensIn, usage.tokensOut);
  repos.events.append({
    kind: 'cycle_done',
    actor: agent,
    payload: { sessionId: session.id, mails: output.mails.length, taskMoves: output.taskMoves.length },
  });

  return { agent, status: 'done', sessionId: session.id };
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

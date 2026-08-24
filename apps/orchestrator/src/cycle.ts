import type { Repos } from '@antfarm/db';
import type { AgentDriver } from './driver.js';
import type { ActionsOutputT } from './actions.js';
import type { Budgets } from './budgets.js';
import { buildSituation, hasDecision, type SituationContext } from './situation.js';
import { applyMemoryUpdate } from './memory.js';
import { capabilitiesFor, parsePromotion, parseProposal, tryBirth, tryPromotion } from './nursery.js';

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
  /** session GC: delete opencode sessions after full capture in lab.db */
  sessionGc?: boolean;
}

export interface CycleResult {
  agent: string;
  status: 'done' | 'skipped';
  sessionId?: number;
  reason?: string;
  timedOut?: boolean;
  productive?: boolean;
  failed?: boolean;
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
      await disposeIfGc(deps, driver, agent);
      return { agent, status: 'done', sessionId: session.id, timedOut: true, failed: true };
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
    await disposeIfGc(deps, driver, agent);
    return { agent, status: 'done', sessionId: session.id, productive: false, failed: true };
  }

  commitActions(deps, agent, session.id, output);

  // real runtime usage (live) beats estimator overrides beats defaults
  const sampled = driver.lastUsage?.(agent);
  const usage = sampled ?? deps.usageFor?.(output) ?? defaultUsage();
  repos.sessions.finish(session.id, 'done', usage, output.summary);
  budgets.recordCycle(agent, usage.tokensIn, usage.tokensOut);
  const productive = output.mails.length + output.taskMoves.length > 0;
  repos.events.append({
    kind: 'cycle_done',
    actor: agent,
    payload: { sessionId: session.id, mails: output.mails.length, taskMoves: output.taskMoves.length },
  });

  // advance the DECISIONS.md read pointer — this agent is now current
  const decisionEvents = repos.events.byKind('decision_logged');
  if (decisionEvents.length) {
    repos.state.setDecisionPointer(agent, decisionEvents[decisionEvents.length - 1]!.id);
  }

  await disposeIfGc(deps, driver, agent);
  return { agent, status: 'done', sessionId: session.id, productive };
}

/** Session GC (S12): opencode transcript is disposable once captured. */
async function disposeIfGc(deps: OrchestratorDeps, driver: AgentDriver, agent: string): Promise<void> {
  if (!deps.sessionGc) return;
  try {
    const d = driver as { disposeSession?: (a: string) => Promise<void> };
    await d.disposeSession?.(agent);
  } catch (err) {
    deps.repos.events.append({
      kind: 'session_gc_failed',
      actor: agent,
      payload: { error: String(err).slice(0, 200) },
    });
  }
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
  applyMemoryUpdate(repos, deps.situation?.projectRoot ?? 'project', agent, output.memoryUpdate);
  const caps = capabilitiesFor(repos, agent); // null for unrestricted parent agents
  for (const m of output.mails) {
    if (caps && !caps.mailTypes.includes(m.type)) {
      // Tool gateway (D6): stage violations are blocked mechanically
      repos.events.append({
        kind: 'permission_denied',
        actor: agent,
        payload: { action: `mail:${m.type}`, stage: 'observer' },
      });
      continue;
    }
    const filed = repos.mail.enqueue(agent, m);
    repos.events.append({
      kind: 'mail_filed',
      actor: agent,
      payload: { messageId: filed.id, to: m.to, type: m.type, subject: m.subject },
    });
    // TASK mails become real board rows — otherwise the board can never grow
    // beyond human-seeded tasks (overnight-nexus finding).
    if (m.type === 'TASK') {
      const existing = repos.tasks
        .list()
        .find((t) => t.state !== 'done' && t.state !== 'dropped' && t.title === m.subject);
      if (!existing) {
        const task = repos.tasks.create(agent, {
          title: m.subject,
          description: m.body,
          owner: m.to === 'agent-a' || m.to === 'agent-b' ? m.to : null,
        });
        repos.events.append({
          kind: 'task_created',
          actor: agent,
          payload: { taskId: task.id, from: agent, assignedTo: m.to, messageId: filed.id },
        });
      }
    }
    // DECISIONS.md protocol: decisions enter the shared event log
    if (m.type === 'DECISION') {
      repos.events.append({
        kind: 'decision_logged',
        actor: agent,
        payload: { from: agent, subject: m.subject, body: m.body, threadId: filed.thread_id },
      });
      repos.mail.markAnswered(filed.id);
      // Procreation hook: a DECISION may be a proposal or an approval
      void maybeProcreate(deps, filed);
    }
  }
  for (const move of output.taskMoves) {
    if (caps && !caps.taskMoves) {
      repos.events.append({
        kind: 'permission_denied',
        actor: agent,
        payload: { action: `task:${move.state}`, taskId: move.taskId },
      });
      continue;
    }
    // Mode 2 sequencing: no project work before a project is chosen.
    if (
      deps.situation?.mode === 'constrained' &&
      !hasDecision(repos) &&
      (move.state === 'active' || move.state === 'done')
    ) {
      repos.events.append({
        kind: 'move_rejected_predecision',
        actor: agent,
        payload: { taskId: move.taskId, requested: move.state },
      });
      continue;
    }
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

/** A DECISION mail may be a nursery proposal, promotion, or approval. */
function maybeProcreate(deps: OrchestratorDeps, filed: import('@antfarm/db').MailRow): void {
  const { repos } = deps;
  const projectRoot = deps.situation?.projectRoot ?? 'project';
  if (parseProposal(filed)) {
    repos.events.append({
      kind: 'agent_proposed',
      actor: filed.from_agent,
      payload: { threadId: filed.thread_id, subject: filed.subject },
    });
    return;
  }
  if (parsePromotion(filed)) {
    repos.events.append({
      kind: 'promotion_proposed',
      actor: filed.from_agent,
      payload: { threadId: filed.thread_id, subject: filed.subject },
    });
    return;
  }
  const birth = tryBirth(repos, projectRoot, filed);
  if (birth.ok) return;
  if (birth.reason !== 'no proposal in thread') {
    repos.events.append({
      kind: 'procreation_failed',
      actor: filed.from_agent,
      payload: { reason: birth.reason },
    });
    return;
  }
  const promotion = tryPromotion(repos, projectRoot, filed);
  if (!promotion.ok && promotion.reason !== 'no promotion in thread') {
    repos.events.append({
      kind: 'promotion_failed',
      actor: filed.from_agent,
      payload: { reason: promotion.reason },
    });
  }
}

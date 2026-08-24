import type { OrchestratorDeps } from './cycle.js';
import { runCycle } from './cycle.js';
import { shouldWake } from './wake.js';
import { escalateStale, escalateReviewLivelock, type EscalationConfig } from './escalation.js';
import { Backoff } from './backoff.js';
import { detectStuckTasks } from './stuck.js';
import { loadConfig } from './config.js';

export interface LoopOptions {
  maxRounds?: number;
  /** mail escalation thresholds (default: config/1h) */
  escalation?: Pick<EscalationConfig, 'staleAfterMs'>;
  /** active task stuck after this many movement-free recent cycles (default 6) */
  stuckWindow?: number;
  /**
   * daemon mode (live colonies): a quiet round sleeps idleTickMs instead of
   * exiting — the lab keeps breathing until budgets stop it or Ctrl+C.
   * Omitted in one-shot modes, where stall-break applies as before.
   */
  persistent?: boolean;
  idleTickMs?: number;
}

export interface LoopReport {
  rounds: number;
  cyclesRun: number;
  skipped: string[];
  escalated: number;
  stucked: number[];
  contested: number;
}

const noSignals = { ownedTaskChanged: false, workspaceChanged: false };

/**
 * Scheduler v3: round-robin over agents; wake = actionable input AND not
 * in idle-backoff (queued mail overrides backoff). Runs the escalation
 * sweep every round. All state in SQLite; resumable.
 */
export async function runLoop(deps: OrchestratorDeps, opts: LoopOptions = {}): Promise<LoopReport> {
  const { repos, drivers, agents } = deps;
  const maxRounds = opts.maxRounds ?? 100;

  const cycleCounters = new Map<string, number>(agents.map((a) => [a, 0]));
  const lastCycleAt = new Map<string, number>();
  const backoff = new Backoff(500, 60_000);
  /** consecutive unproductive cycles — caps idle-tick burning (S11.1) */
  const idleStreak = new Map<string, number>();
  const IDLE_STREAK_MAX = 5;
  const report: LoopReport = { rounds: 0, cyclesRun: 0, skipped: [], escalated: 0, stucked: [], contested: 0 };
  const cfg = loadConfig();

  for (let round = 1; round <= maxRounds; round++) {
    report.rounds = round;
    let progressedThisRound = false;

    for (const agent of agents) {
      const driver = drivers[agent];
      if (!driver) continue;

      // budget gate first — exhaustion must surface even when backoff would
      // otherwise mask the skip
      const budget = deps.budgets.canRun(agent);
      if (!budget.ok) {
        repos.events.append({ kind: 'cycle_skipped', actor: agent, payload: { reason: budget.reason } });
        report.skipped.push(`${agent}:${budget.reason}`);
        continue;
      }

      const queued = repos.mail.queuedFor(agent).length;
      const signals = deps.signals ? await deps.signals(agent) : noSignals;
      const wakeable = shouldWake({
        pendingWork: driver.pending(agent),
        queuedMail: queued,
        ownedTaskChanged: signals.ownedTaskChanged,
        workspaceChanged: signals.workspaceChanged,
      });
      // daemon mode: proactive idle cycles so colonies keep acting even
      // when the environment is quiet — but an agent that burns several
      // idle ticks without filing anything stops getting them until a
      // real signal (mail / workspace / task change) arrives
      const last = lastCycleAt.get(agent) ?? 0;
      const streak = idleStreak.get(agent) ?? 0;
      const idleDue =
        opts.persistent === true &&
        Date.now() - last > (opts.idleTickMs ?? 60_000) &&
        streak < IDLE_STREAK_MAX;
      if (!wakeable && !idleDue) continue;
      // backoff yields to unread mail or a due idle tick — never to silence
      if (queued === 0 && !idleDue && !backoff.isReady(agent, last)) continue;

      const nextCycle = (cycleCounters.get(agent) ?? 0) + 1;
      const result = await runCycle(deps, agent, nextCycle);
      if (result.status === 'done') {
        cycleCounters.set(agent, nextCycle);
        report.cyclesRun++;
        backoff.record(agent, result.productive ?? false);
        if (!result.productive && !wakeable) {
          idleStreak.set(agent, streak + 1);
        } else {
          idleStreak.delete(agent);
        }
        lastCycleAt.set(agent, Date.now());
        if (!result.failed) {
          progressedThisRound = true;
          await deps.onCycleDone?.(agent);
        }
      } else if (result.reason) {
        report.skipped.push(`${agent}:${result.reason}`);
      }
    }

    report.escalated += escalateStale(repos, {
      staleAfterMs: opts.escalation?.staleAfterMs ?? cfg.escalationStaleAfterMs,
    }).length;
    report.stucked.push(
      ...detectStuckTasks(repos, { windowSize: opts.stuckWindow ?? 6 })
    );
    report.contested += escalateReviewLivelock(repos, { maxReviewRounds: 4 }).length;

    // Stall handling: one-shot modes exit; daemon mode breathes.
    if (!progressedThisRound) {
      if (!opts.persistent) break;
      await new Promise((resolve) => setTimeout(resolve, opts.idleTickMs ?? 60_000));
    }
  }

  return report;
}

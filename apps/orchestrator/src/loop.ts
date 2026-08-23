import type { OrchestratorDeps } from './cycle.js';
import { runCycle } from './cycle.js';
import { shouldWake } from './wake.js';

export interface LoopOptions {
  maxRounds?: number;
}

export interface LoopReport {
  rounds: number;
  cyclesRun: number;
  skipped: string[];
}

const noSignals = { ownedTaskChanged: false, workspaceChanged: false };

/**
 * Scheduler v2: round-robin over agents; each agent wakes when
 * shouldWake() says so — scripted work, queued mail, or polled environment
 * signals (workspace changes). All state in SQLite; resumable.
 */
export async function runLoop(deps: OrchestratorDeps, opts: LoopOptions = {}): Promise<LoopReport> {
  const { repos, drivers, agents } = deps;
  const maxRounds = opts.maxRounds ?? 100;

  const cycleCounters = new Map<string, number>(agents.map((a) => [a, 0]));
  const report: LoopReport = { rounds: 0, cyclesRun: 0, skipped: [] };

  for (let round = 1; round <= maxRounds; round++) {
    report.rounds = round;
    let actedThisRound = false;

    for (const agent of agents) {
      const driver = drivers[agent];
      if (!driver) continue;
      const signals = deps.signals ? await deps.signals(agent) : noSignals;
      const wake = shouldWake({
        pendingWork: driver.pending(agent),
        queuedMail: repos.mail.queuedFor(agent).length,
        ownedTaskChanged: signals.ownedTaskChanged,
        workspaceChanged: signals.workspaceChanged,
      });
      if (!wake) continue;

      const nextCycle = (cycleCounters.get(agent) ?? 0) + 1;
      const result = await runCycle(deps, agent, nextCycle);
      if (result.status === 'done') {
        cycleCounters.set(agent, nextCycle);
        report.cyclesRun++;
        actedThisRound = true;
        if (deps.signals) await deps.onCycleDone?.(agent);
      } else if (result.reason) {
        report.skipped.push(`${agent}:${result.reason}`);
      }
    }

    // Stop when nobody has scripted work left and nothing is pending.
    const anyPending = agents.some((a) => drivers[a]?.pending(a));
    const anyQueued = agents.some((a) => repos.mail.queuedFor(a).length > 0);
    if (!actedThisRound && !anyPending && !anyQueued) break;
  }

  return report;
}

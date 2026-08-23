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

/**
 * Scheduler v1: round-robin over agents; each agent wakes when
 * shouldWake() says so. Deterministic, resumable — all state is in SQLite.
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
      const wake = shouldWake({
        pendingWork: driver.pending(agent),
        queuedMail: repos.mail.queuedFor(agent).length,
        ownedTaskChanged: false,
        workspaceChanged: false,
      });
      if (!wake) continue;

      const nextCycle = (cycleCounters.get(agent) ?? 0) + 1;
      const result = await runCycle(deps, agent, nextCycle);
      if (result.status === 'done') {
        cycleCounters.set(agent, nextCycle);
        report.cyclesRun++;
        actedThisRound = true;
      } else if (result.reason) {
        report.skipped.push(`${agent}:${result.reason}`);
      }
    }

    // Stop when nobody has scripted work left and no mail is pending.
    const anyPending = agents.some((a) => drivers[a]?.pending(a));
    const anyQueued = agents.some((a) => repos.mail.queuedFor(a).length > 0);
    if (!actedThisRound && !anyPending && !anyQueued) break;
  }

  return report;
}

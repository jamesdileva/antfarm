import type { Repos } from '@antfarm/db';

export interface StuckConfig {
  /** an active task with no movement inside this many recent cycles → blocked */
  windowSize: number;
}

/**
 * Stuck detection (architecture §3.2): if the same active task shows no
 * board delta across the recent-cycle window, the platform marks it
 * `blocked` — once. Orchestrator is privileged so ownership doesn't block
 * this sweep.
 */
export function detectStuckTasks(repos: Repos, cfg: StuckConfig): number[] {
  const cycleEvents = repos.events.byKind('cycle_done');
  if (cycleEvents.length < cfg.windowSize) return [];

  const movedRecently = new Set(
    repos.events
      .byKind('task_moved')
      .slice(-cfg.windowSize)
      .map((e) => (JSON.parse(e.payload) as { taskId: number }).taskId)
  );

  const stucked: number[] = [];
  for (const task of repos.tasks.list()) {
    if (task.state !== 'active' || movedRecently.has(task.id)) continue;
    const alreadyFlagged = repos.events
      .byKind('task_stuck')
      .some((e) => (JSON.parse(e.payload) as { taskId: number }).taskId === task.id);
    if (alreadyFlagged) continue;
    try {
      repos.tasks.move('orchestrator', task.id, 'blocked');
    } catch {
      continue; // raced with another transition — fine
    }
    repos.events.append({
      kind: 'task_stuck',
      actor: 'orchestrator',
      payload: { taskId: task.id, windowSize: cfg.windowSize },
    });
    stucked.push(task.id);
  }
  return stucked;
}

import type { Db } from '@antfarm/db';

/**
 * Orphan recovery (Sentinel lesson, integration §9): a killed process can
 * leave sessions stuck at 'running'. Every restart sweeps them to 'failed'
 * so state is never ambiguous after recovery.
 */
export function recoverOrphans(db: Db): number {
  const info = db
    .prepare(`UPDATE sessions SET status = 'failed', ended_at = ?, summary = ?
              WHERE status = 'running'`)
    .run(new Date().toISOString(), 'swept by orphan recovery');
  return Number(info.changes);
}

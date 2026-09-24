import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { antfarmHome } from './home.js';

/**
 * Cross-process colony lock (audit M4): the Electron single-instance lock
 * is per-userData, so a `--user-data-dir` shell or a bare CLI `serve`
 * against the same home would otherwise run two writers on one SQLite DB
 * (or reset/archive under a live colony). The lock lives in the data-home
 * as `colony.lock`; a lock whose owner pid is gone is stale and replaced.
 */

export const LOCK_FILE = 'colony.lock';

export interface ColonyLock {
  pid: number;
  startedAt: string;
  live: boolean;
}

/** Liveness probe — signal 0 throws when the pid is gone (ESRCH). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function lockPath(): string {
  return join(antfarmHome(), LOCK_FILE);
}

export function readLock(): ColonyLock | null {
  try {
    if (!existsSync(lockPath())) return null;
    const raw = JSON.parse(readFileSync(lockPath(), 'utf8')) as Partial<ColonyLock>;
    if (typeof raw.pid !== 'number') return null;
    return { pid: raw.pid, startedAt: String(raw.startedAt ?? ''), live: raw.live === true };
  } catch {
    return null;
  }
}

/** The live lock, if any — stale locks (dead owner) are swept on sight. */
export function liveLock(): ColonyLock | null {
  const lock = readLock();
  if (!lock) return null;
  if (pidAlive(lock.pid)) return lock;
  try {
    rmSync(lockPath(), { force: true });
  } catch {
    /* best effort */
  }
  return null;
}

export function writeLock(live: boolean): void {
  writeFileSync(
    lockPath(),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), live }),
    'utf8'
  );
}

export function clearLock(): void {
  try {
    rmSync(lockPath(), { force: true });
  } catch {
    /* best effort */
  }
}

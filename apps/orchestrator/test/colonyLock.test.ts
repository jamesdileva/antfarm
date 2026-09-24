import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLock,
  liveLock,
  lockPath,
  pidAlive,
  readLock,
  writeLock,
} from '../src/colonyLock.js';
import { archiveLab, resetLab } from '../src/archive.js';
import { loadConfigFrom } from '../src/config.js';
import { ColonyManager } from '../src/serve-core.js';
import { existsSync, writeFileSync } from 'node:fs';

describe('colony lockfile (audit M4)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'antfarm-lock-'));
    process.env.ANTFARM_HOME = home;
  });

  afterEach(() => {
    delete process.env.ANTFARM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips write/read/clear for the current process', () => {
    expect(readLock()).toBeNull();
    writeLock(false);
    expect(existsSync(lockPath())).toBe(true);
    const lock = readLock();
    expect(lock?.pid).toBe(process.pid);
    expect(liveLock()?.pid).toBe(process.pid);
    clearLock();
    expect(readLock()).toBeNull();
  });

  it('detects liveness and sweeps stale locks', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    // a lock pointing at a dead pid is swept on sight
    writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 30, startedAt: 'x', live: true }), 'utf8');
    expect(liveLock()).toBeNull();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('archive and reset refuse while a live lock is held', () => {
    const cfg = loadConfigFrom(join(home, 'lab.config.json'));
    writeLock(false);
    expect(archiveLab(cfg).ok).toBe(false);
    expect(archiveLab(cfg).error).toContain('lock held');
    expect(resetLab(cfg, true).ok).toBe(false);
    expect(resetLab(cfg, true).error).toContain('lock held');
    clearLock();
  });

  it('a second manager cannot start while the lock is held', async () => {
    writeLock(false);
    const manager = new ColonyManager();
    const result = await manager.start(false);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('lock held');
    clearLock();
  });
});

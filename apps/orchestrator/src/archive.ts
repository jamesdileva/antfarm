import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homePaths, antfarmHome } from './home.js';
import { loadConfigFrom, type LabConfig } from './config.js';

export interface ArchiveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Snapshot the current lab into <home>/archives/<timestamp>/:
 * project/ tree (workspace, shared, agent dirs), lab.db (+wal/shm),
 * and lab.config.json. The live lab is left untouched — reset is a
 * separate, explicit step.
 */
export function archiveLab(config: LabConfig): ArchiveResult {
  const paths = homePaths(config.projectRoot);
  if (!existsSync(paths.db())) {
    return { ok: false, error: `no lab database at ${paths.db()} — nothing to archive` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(antfarmHome(), 'archives', stamp);
  if (existsSync(dest)) {
    return { ok: false, error: `archive already exists: ${dest}` };
  }
  mkdirSync(dest, { recursive: true });

  try {
    cpSync(paths.project, join(dest, 'project'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const dbFile = `${paths.db()}${suffix}`;
      if (existsSync(dbFile)) cpSync(dbFile, join(dest, `lab.db${suffix}`));
    }
    if (existsSync(paths.config)) cpSync(paths.config, join(dest, 'lab.config.json'));
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    return { ok: false, error: String(err).slice(0, 300) };
  }
  return { ok: true, path: dest };
}

export interface ResetResult {
  ok: boolean;
  error?: string;
}

/** Wipe lab.db (+wal/shm) and optionally the whole project/ tree. */
export function resetLab(config: LabConfig, all: boolean): ResetResult {
  const paths = homePaths(config.projectRoot);
  if (!existsSync(paths.db()) && !existsSync(paths.project)) {
    return { ok: false, error: 'nothing to reset — no lab found' };
  }
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${paths.db()}${suffix}`, { force: true });
  }
  if (all) rmSync(paths.project, { recursive: true, force: true });
  return { ok: true };
}

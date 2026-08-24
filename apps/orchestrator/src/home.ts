import { join, resolve } from 'node:path';

/**
 * Data-home resolution (S13): every lab artifact lives under one home dir.
 * Resolution order: CLI override (--home, used by the packaged shell since
 * env propagation through Electron-as-Node proved unreliable — S15 lesson)
 * → ANTFARM_HOME env → CWD fallback (dev, byte-identical to pre-S13 labs).
 */
let homeOverride: string | null = null;

export function setAntfarmHome(dir: string): void {
  homeOverride = resolve(dir);
}

export function antfarmHome(): string {
  if (homeOverride) return homeOverride;
  if (process.env.ANFARM_HOME && process.env.ANFARM_HOME.trim()) {
    return resolve(process.env.ANFARM_HOME.trim());
  }
  return process.cwd();
}

export interface HomePaths {
  home: string;
  /** lab.config.json location */
  config: string;
  /** project data root (cfg.projectRoot name resolved under home) */
  project: string;
  db: (name?: string) => string;
}

export function homePaths(projectRootName = 'project'): HomePaths {
  const home = antfarmHome();
  const project = resolve(home, projectRootName);
  return {
    home,
    config: join(home, 'lab.config.json'),
    project,
    db: (name = 'lab.db') => join(project, name),
  };
}

import { join, resolve } from 'node:path';

/**
 * Data-home resolution (S13): every lab artifact lives under one home dir.
 * Packaged builds set ANTFARM_HOME (shell uses %APPDATA%\antfarm); dev falls
 * back to the working directory so existing labs stay byte-identical.
 */
export function antfarmHome(): string {
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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { antfarmHome, homePaths } from '../src/home.js';
import { loadConfigFrom } from '../src/config.js';

const cleanEnv = (): void => {
  delete process.env.ANFARM_HOME;
};

describe('ANTFARM_HOME resolution (S13)', () => {
  afterEach(cleanEnv);

  it('defaults to CWD when unset — existing labs unaffected', () => {
    cleanEnv();
    expect(antfarmHome()).toBe(process.cwd());
    const paths = homePaths();
    expect(paths.config).toContain('lab.config.json');
    expect(paths.db().replace(/\\/g, '/')).toMatch(/project\/lab\.db$/);
  });

  it('respects ANTFARM_HOME for every artifact path', () => {
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home-'));
    process.env.ANFARM_HOME = home;

    expect(antfarmHome()).toBe(home);
    const paths = homePaths();
    expect(paths.home).toBe(home);
    expect(paths.config).toBe(join(home, 'lab.config.json'));
    expect(paths.db().replace(/\\/g, '/')).toBe(
      join(home, 'project', 'lab.db').replace(/\\/g, '/')
    );
    expect(paths.db('lab-dryrun.db').replace(/\\/g, '/')).toBe(
      join(home, 'project', 'lab-dryrun.db').replace(/\\/g, '/')
    );
    rmSync(home, { recursive: true, force: true });
  });

  it('config + db round-trip inside a custom home', () => {
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home2-'));
    process.env.ANFARM_HOME = home;
    const paths = homePaths();

    writeFileSync(paths.config, JSON.stringify({ mode: 'constrained', model: 'test/model' }));
    const cfg = loadConfigFrom(paths.config);
    expect(cfg.mode).toBe('constrained');
    expect(cfg.model).toBe('test/model');

    rmSync(home, { recursive: true, force: true });
  });

  it('tolerates a BOM at the start of lab.config.json (PowerShell-written)', () => {
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home3-'));
    process.env.ANFARM_HOME = home;
    const paths = homePaths();
    writeFileSync(paths.config, '\uFEFF' + JSON.stringify({ model: 'x/y' }), 'utf8');
    expect(loadConfigFrom(paths.config).model).toBe('x/y');
    rmSync(home, { recursive: true, force: true });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { antfarmHome, homePaths } from '../src/home.js';
import { loadConfigFrom } from '../src/config.js';

const cleanEnv = (): void => {
  delete process.env.ANFARM_HOME;
  delete process.env.ANTFARM_HOME;
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
    process.env.ANTFARM_HOME = home;

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
    process.env.ANTFARM_HOME = home;
    const paths = homePaths();

    writeFileSync(paths.config, JSON.stringify({ mode: 'constrained', model: 'test/model' }));
    const cfg = loadConfigFrom(paths.config);
    expect(cfg.mode).toBe('constrained');
    expect(cfg.model).toBe('test/model');

    rmSync(home, { recursive: true, force: true });
  });

  it('tolerates a BOM at the start of lab.config.json (PowerShell-written)', () => {
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home3-'));
    process.env.ANTFARM_HOME = home;
    const paths = homePaths();
    writeFileSync(paths.config, '﻿' + JSON.stringify({ model: 'x/y' }), 'utf8');
    expect(loadConfigFrom(paths.config).model).toBe('x/y');
    rmSync(home, { recursive: true, force: true });
  });

  it('accepts the legacy ANFARM_HOME misspelling as an alias', () => {
    cleanEnv();
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home-alias-'));
    process.env.ANFARM_HOME = home;
    expect(antfarmHome()).toBe(home);
    rmSync(home, { recursive: true, force: true });
  });

  it('prefers the documented ANTFARM_HOME over the legacy alias', () => {
    cleanEnv();
    const home = mkdtempSync(join(tmpdir(), 'antfarm-home-doc-'));
    const legacy = mkdtempSync(join(tmpdir(), 'antfarm-home-leg-'));
    process.env.ANFARM_HOME = legacy;
    process.env.ANTFARM_HOME = home;
    expect(antfarmHome()).toBe(home);
    rmSync(home, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  });
});

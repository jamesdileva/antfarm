import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveLab, resetLab } from '../src/archive.js';
import { loadConfigFrom } from '../src/config.js';

describe('archive + reset lab lifecycle', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'antfarm-archive-'));
    process.env.ANFARM_HOME = home;
  });
  afterEach(() => {
    delete process.env.ANFARM_HOME;
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });

  function seedLab(): void {
    const project = join(home, 'project');
    const shared = join(project, 'shared');
    const ws = join(project, 'workspace');
    mkdirSync(shared, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(shared, 'PROJECT_GOAL.md'), 'build something local-first');
    writeFileSync(join(ws, 'notes.txt'), 'agent work product');
    writeFileSync(join(home, 'lab.config.json'), JSON.stringify(loadConfigFrom(join(home, 'lab.config.json'))));
    writeFileSync(join(home, 'project', 'lab.db'), 'fake-db-bytes');
  }

  it('refuses to archive a lab that does not exist', () => {
    const result = archiveLab(loadConfigFrom(join(home, 'lab.config.json')));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no lab database');
  });

  it('archives project tree, db and config without touching the live lab', () => {
    seedLab();
    const result = archiveLab(loadConfigFrom(join(home, 'lab.config.json')));
    expect(result.ok).toBe(true);
    const dest = result.path!;
    expect(existsSync(join(dest, 'project', 'shared', 'PROJECT_GOAL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'project', 'workspace', 'notes.txt'), 'utf8')).toBe('agent work product');
    expect(readFileSync(join(dest, 'lab.db'), 'utf8')).toBe('fake-db-bytes');
    expect(existsSync(join(dest, 'lab.config.json'))).toBe(true);
    // live lab untouched
    expect(existsSync(join(home, 'project', 'lab.db'))).toBe(true);
    expect(readdirSync(join(home, 'archives')).length).toBe(1);
  });

  it('reset removes db and project tree; refuses when there is no lab', () => {
    expect(resetLab(loadConfigFrom(join(home, 'lab.config.json')), true).ok).toBe(false);

    seedLab();
    const result = resetLab(loadConfigFrom(join(home, 'lab.config.json')), true);
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, 'project', 'lab.db'))).toBe(false);
    expect(existsSync(join(home, 'project'))).toBe(false);

    // archive made before reset survives
    seedLab();
    const arch = archiveLab(loadConfigFrom(join(home, 'lab.config.json')));
    resetLab(loadConfigFrom(join(home, 'lab.config.json')), true);
    expect(existsSync(join(arch.path!, 'project', 'lab.db'))).toBe(true);
  });
});


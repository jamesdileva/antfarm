import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, workspacePath } from '../src/workspace.js';

describe('Workspace', () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-ws-'));
    ws = new Workspace(dir);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  });

  it('bootstraps a repo and detects first-cycle changes', async () => {
    await ws.ensureRepo();
    expect(await ws.currentHead()).toBe('(empty)');

    // empty + clean workspace → no change signal for a fresh agent
    expect(await ws.poll('agent-a')).toBe(false);

    writeFileSync(join(dir, 'hello.txt'), 'hi');
    expect(await ws.poll('agent-b')).toBe(true);
    expect((await ws.diffSummary()).length).toBeGreaterThan(0);
  });

  it('marks cycles seen so only new work re-triggers the wake', async () => {
    await ws.ensureRepo();
    writeFileSync(join(dir, 'a.txt'), '1');
    await ws.poll('agent-a');
    await ws.markSeen('agent-a');
    // uncommitted file still present — dirty status keeps the signal on
    expect(await ws.poll('agent-a')).toBe(true);

    const git = (await import('simple-git')).simpleGit({ baseDir: dir });
    await git.add(['.']);
    await git.commit('wip');
    await ws.markSeen('agent-a');
    expect(await ws.poll('agent-a')).toBe(false);

    writeFileSync(join(dir, 'b.txt'), '2');
    await git.add(['.']);
    await git.commit('more work');
    expect(await ws.poll('agent-a')).toBe(true);
  });

  it('workspacePath nests under the project root', () => {
    expect(workspacePath('project').replace(/\\/g, '/')).toMatch(/project\/workspace$/);
  });
});

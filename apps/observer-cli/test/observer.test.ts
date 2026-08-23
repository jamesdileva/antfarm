import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db } from '@antfarm/db';
import { buildView } from '../src/view.js';
import { render } from '../src/render.js';
import {
  PERSONALITIES,
  renderDrivePrompt,
  resolvePersonality,
} from '../../orchestrator/src/drives.js';
import { BUILDER, CRITIC } from '../../orchestrator/src/drives.js';

describe('observer view', () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-obs-'));
    dbPath = join(dir, 'lab.db');
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('builds a full view from a seeded lab', () => {
    const repos = createRepos(db);
    repos.sessions.start({ agent: 'agent-a', cycle: 1, goal: 'g' });
    repos.sessions.finish(1, 'done', { tokensIn: 1 }, 'implemented search');
    repos.tasks.create('human', { title: 'spec the thing' });
    const m = repos.mail.enqueue('agent-b', { to: 'agent-a', type: 'REVIEW', subject: 'looks ok', body: 'b' });
    void m;
    repos.events.append({
      kind: 'mail_filed',
      actor: 'agent-b',
      payload: { messageId: m.id, to: m.to, type: m.type, subject: m.subject },
    });
    repos.events.append({ kind: 'build_result', actor: 'orchestrator', payload: { ok: true, durationMs: 1200 } });
    repos.events.append({
      kind: 'decision_logged',
      actor: 'agent-a',
      payload: { from: 'agent-a', subject: 'use sqlite', body: 'state' },
    });

    const view = buildView(dbPath);

    expect(view.agents.find((a) => a.agent === 'agent-a')).toMatchObject({
      status: 'done',
      cycles: 1,
      lastSession: 'implemented search',
    });
    expect(view.agents.find((a) => a.agent === 'agent-b')?.status).toBe('never run');
    expect(view.board[0]).toMatchObject({ state: 'proposed', title: 'spec the thing' });
    expect(view.latestMail[0]!.subject).toBe('looks ok');
    expect(view.checks.build).toContain('PASS');
    expect(view.checks.test).toBe('not run yet');
    expect(view.decisions).toBe(1);
  });

  it('renders a readable board without crashing on an empty lab', () => {
    const text = render(buildView(dbPath));
    expect(text).toContain('ANTFARM');
    expect(text).toContain('(no mail yet)');
    expect(text).toContain('never run');
  });
});

describe('personalities', () => {
  it('overlay renders into drive prompts when selected', () => {
    const withP = renderDrivePrompt(BUILDER, 'speed');
    const withoutP = renderDrivePrompt(BUILDER);
    expect(withP).toContain('Speed');
    expect(withP).toContain('smallest implementation');
    expect(withoutP).not.toContain('Operational personality');

    const skepticCritic = renderDrivePrompt(CRITIC, 'skeptic');
    expect(skepticCritic).toContain('Skeptic');
    expect(skepticCritic).toContain('disconfirm');
  });

  it('every personality stays idea-neutral (no project suggestions)', () => {
    for (const [name, p] of Object.entries(PERSONALITIES)) {
      void name;
      const blob = `${p.emphasis} ${p.biases.join(' ')}`.toLowerCase();
      // word boundaries so innocuous words like "approach" don't trip /app/
      expect(blob).not.toMatch(/\b(app|tracker|notes|todo|game|website|chat)s?\b/);
    }
  });

  it('resolvePersonality rejects unknown names', () => {
    expect(resolvePersonality('speed')).toBe('speed');
    expect(resolvePersonality('chaos')).toBeUndefined();
    expect(resolvePersonality(undefined)).toBeUndefined();
  });
});

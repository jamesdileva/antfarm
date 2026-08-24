import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import {
  auditNursery,
  babyStats,
  parsePromotion,
  tryBirth,
  tryPromotion,
} from '../src/nursery.js';

function setup(): { db: Db; repos: Repos; dir: string; projectRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s10-'));
  const db = openDb(join(dir, 'lab.db'));
  const projectRoot = join(dir, 'project');
  return { db, repos: createRepos(db), dir, projectRoot };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Birth a scout through the full protocol so we have something to promote. */
function birthScout(repos: Repos, projectRoot: string): void {
  const proposal = repos.mail.enqueue('agent-a', {
    to: 'agent-b',
    type: 'DECISION',
    subject: 'PROPOSE AGENT scout-001: Scout',
    body: 'Purpose: Monitor the workspace and surface problems.\nEvidence: manual diff reading is slow.',
  });
  const approval = repos.mail.enqueue('agent-b', {
    to: 'agent-a', type: 'DECISION', subject: 'approved', body: 'APPROVE', threadId: proposal.thread_id,
  });
  const result = tryBirth(repos, projectRoot, approval);
  if (!result.ok) throw new Error(`fixture birth failed: ${result.reason}`);
}

describe('promotion protocol', () => {
  let d: ReturnType<typeof setup>;

  beforeEach(() => {
    d = setup();
  });

  afterEach(() => cleanup(d.dir));

  it('parses promotions strictly', () => {
    const { repos } = d;
    const mail = repos.mail.enqueue('agent-a', {
      to: 'agent-b', type: 'DECISION', subject: 'PROMOTE AGENT scout-001 TO STAGE 2', body: '94% accuracy',
    });
    expect(parsePromotion(mail)).toMatchObject({ id: 'scout-001', stage: 2 });

    const wrongType = repos.mail.enqueue('agent-a', {
      to: 'x', type: 'STATUS', subject: 'PROMOTE AGENT scout-001 TO STAGE 2', body: '',
    });
    expect(parsePromotion(wrongType)).toBeNull();
  });

  it('promotes one stage at a time with dual approval; blocks skips and self-approval', () => {
    const { repos, projectRoot } = d;
    birthScout(repos, projectRoot);

    // stage skip attempt (1 → 3) — even with dual approval
    const skipProposal = repos.mail.enqueue('agent-a', {
      to: 'agent-b', type: 'DECISION', subject: 'PROMOTE AGENT scout-001 TO STAGE 3', body: 'genius baby',
    });
    const skipApproval = repos.mail.enqueue('agent-b', {
      to: 'a', type: 'DECISION', subject: 'ok', body: 'yes', threadId: skipProposal.thread_id,
    });
    expect(tryPromotion(repos, projectRoot, skipApproval)).toEqual({
      ok: false,
      reason: 'cannot jump from stage 1 to 3',
    });
    expect(repos.events.byKind('promotion_rejected')).toHaveLength(1);

    // self-approval rejected
    const selfProposal = repos.mail.enqueue('agent-a', {
      to: 'b', type: 'DECISION', subject: 'PROMOTE AGENT scout-001 TO STAGE 2', body: 'evidence',
    });
    const selfApproval = repos.mail.enqueue('agent-a', {
      to: 'a', type: 'DECISION', subject: 'ok', body: 'me too', threadId: selfProposal.thread_id,
    });
    expect(tryPromotion(repos, projectRoot, selfApproval)).toEqual({ ok: false, reason: 'self-approval' });

    // valid path: 1 → 2
    const promo = repos.mail.enqueue('agent-a', {
      to: 'agent-b', type: 'DECISION', subject: 'PROMOTE AGENT scout-001 TO STAGE 2',
      body: 'Evidence: reports accurate across last cycles.',
    });
    const approval = repos.mail.enqueue('agent-b', {
      to: 'a', type: 'DECISION', subject: 'granted', body: 'APPROVE', threadId: promo.thread_id,
    });
    expect(tryPromotion(repos, projectRoot, approval)).toEqual({ ok: true, babyId: 'scout-001', stage: 2 });
    expect(repos.nursery.byId('scout-001')!.stage).toBe(2);

    // permissions.json mirrored
    const perms = JSON.parse(
      readFileSync(join(projectRoot, 'agents', 'scout-001', 'permissions.json'), 'utf8')
    );
    expect(perms.taskMoves).toBe(false); // stage 2 = Analyst still can't move tasks
    expect(perms.mailTypes).toContain('QUESTION');

    // notification queued
    expect(repos.mail.queuedFor('scout-001').some((m) => m.subject === 'stage advancement')).toBe(true);
    expect(repos.events.byKind('agent_promoted')).toHaveLength(1);
  });

  it('refuses promotions for unknown agents', () => {
    const { repos, projectRoot } = d;
    const promo = repos.mail.enqueue('agent-a', {
      to: 'b', type: 'DECISION', subject: 'PROMOTE AGENT ghost-9 TO STAGE 2', body: '?',
    });
    const approval = repos.mail.enqueue('agent-b', {
      to: 'a', type: 'DECISION', subject: 'sure', body: 'yes', threadId: promo.thread_id,
    });
    expect(tryPromotion(repos, projectRoot, approval).ok).toBe(false);
  });
});

describe('baby stats', () => {
  let d: ReturnType<typeof setup>;

  beforeEach(() => {
    d = setup();
  });

  afterEach(() => cleanup(d.dir));

  it('counts cycles, reports, denials, observations from the event log', () => {
    const { repos, projectRoot } = d;
    birthScout(repos, projectRoot);

    repos.sessions.start({ agent: 'scout-001', cycle: 1, goal: 'observe' });
    repos.events.append({
      kind: 'mail_filed', actor: 'scout-001',
      payload: { messageId: 1, to: 'agent-a', type: 'STATUS', subject: 'report' },
    });
    repos.events.append({
      kind: 'permission_denied', actor: 'scout-001', payload: { action: 'mail:IDEA' },
    });
    const logDir = join(projectRoot, 'agents', 'scout-001');
    writeFileSync(join(logDir, 'observations.log'), 'obs1\nobs2\nobs3\n', 'utf8');

    const stats = babyStats(repos, projectRoot, 'scout-001');
    expect(stats).toEqual({ cycles: 1, reportsFiled: 1, permissionDenials: 1, observationsLogged: 3 });
  });
});

describe('idea-neutrality audit', () => {
  let d: ReturnType<typeof setup>;

  beforeEach(() => {
    d = setup();
  });

  afterEach(() => cleanup(d.dir));

  it('passes on a healthy lab and fails on tampering or orphans', () => {
    const { repos, projectRoot } = d;
    birthScout(repos, projectRoot);

    const healthy = auditNursery(repos, projectRoot);
    expect(healthy).toEqual([{ id: 'scout-001', ok: true }]);

    // tamper with purpose.md → FAIL
    writeFileSync(join(projectRoot, 'agents', 'scout-001', 'purpose.md'), 'new evil purpose\n', 'utf8');
    expect(auditNursery(repos, projectRoot)[0]).toMatchObject({ ok: false, reason: /tampered/ });
    writeFileSync(join(projectRoot, 'agents', 'scout-001', 'purpose.md'), 'Monitor the workspace and surface problems.\n', 'utf8');

    // registry row without a traceable proposal → FAIL
    repos.nursery.register({
      id: 'ghost-1', name: 'Ghost', purpose: 'appeared from nowhere',
      createdBy: ['agent-a'], proposalThread: 'nonexistent-thread',
    });
    const audit = auditNursery(repos, projectRoot);
    expect(audit.find((a) => a.id === 'ghost-1')).toMatchObject({ ok: false });
    expect(audit.find((a) => a.id === 'scout-001')).toMatchObject({ ok: true });
  });
});

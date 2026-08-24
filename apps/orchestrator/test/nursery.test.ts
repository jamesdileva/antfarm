import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '@antfarm/db';
import { Budgets } from '../src/budgets.js';
import { runCycle, type OrchestratorDeps } from '../src/cycle.js';
import { BabyDriver } from '../src/drivers/baby.js';
import { STAGE_CAPABILITIES, parseProposal, tryBirth, capabilitiesFor } from '../src/nursery.js';
import { Workspace } from '../src/workspace.js';

function setup(): { db: Db; repos: Repos; dir: string; projectRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'antfarm-s9-'));
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

function proposeMail(repos: Repos, from: string): ReturnType<Repos['mail']['enqueue']> {
  return repos.mail.enqueue(from, {
    to: 'agent-b',
    type: 'DECISION',
    subject: 'PROPOSE AGENT scout-001: Scout',
    body: 'Purpose: Monitor the workspace and surface problems.\nEvidence: We spend many cycles reading diffs manually.',
  });
}

describe('procreation protocol', () => {
  let d: ReturnType<typeof setup>;

  beforeEach(() => {
    d = setup();
  });

  afterEach(() => cleanup(d.dir));

  it('parses proposals strictly (type + format + Purpose/Evidence)', () => {
    const { repos } = d;
    const good = proposeMail(repos, 'agent-a');
    const p = parseProposal(good);
    expect(p).toMatchObject({ id: 'scout-001', name: 'Scout', proposer: 'agent-a' });
    expect(p!.purpose).toContain('Monitor the workspace');

    // wrong type → not a proposal
    const wrongType = repos.mail.enqueue('agent-a', {
      to: 'agent-b', type: 'IDEA', subject: 'PROPOSE AGENT x: X', body: 'Purpose: p\nEvidence: e',
    });
    expect(parseProposal(wrongType)).toBeNull();

    // missing evidence → rejected
    const noEvidence = repos.mail.enqueue('agent-a', {
      to: 'agent-b', type: 'DECISION', subject: 'PROPOSE AGENT y: Y', body: 'Purpose: p only',
    });
    expect(parseProposal(noEvidence)).toBeNull();
  });

  it('births on second distinct approval; writes identity/purpose/permissions verbatim', () => {
    const { repos, projectRoot } = d;
    const proposal = proposeMail(repos, 'agent-a');

    // self-approval rejected
    const self = repos.mail.enqueue('agent-a', {
      to: 'agent-a', type: 'DECISION', subject: 'approved', body: 'APPROVE', threadId: proposal.thread_id,
    });
    expect(tryBirth(repos, projectRoot, self)).toEqual({ ok: false, reason: 'self-approval' });

    // distinct approval births
    const approval = repos.mail.enqueue('agent-b', {
      to: 'agent-a', type: 'DECISION', subject: 'approved with restrictions', body: 'APPROVE — stage 1 only',
      threadId: proposal.thread_id,
    });
    const result = tryBirth(repos, projectRoot, approval);
    expect(result).toEqual({ ok: true, babyId: 'scout-001' });

    const baby = repos.nursery.byId('scout-001')!;
    expect(baby.stage).toBe(1); // minimum granted regardless of request
    expect(JSON.parse(baby.created_by)).toEqual(['agent-a', 'agent-b']);

    const agentDir = join(projectRoot, 'agents', 'scout-001');
    expect(existsSync(join(agentDir, 'identity.json'))).toBe(true);
    expect(readFileSync(join(agentDir, 'purpose.md'), 'utf8')).toBe(
      'Monitor the workspace and surface problems.\n'
    ); // verbatim
    expect(JSON.parse(readFileSync(join(agentDir, 'permissions.json'), 'utf8'))).toEqual(STAGE_CAPABILITIES[1]);

    // kickoff queued to the newborn
    const kickoff = repos.mail.queuedFor('scout-001');
    expect(kickoff).toHaveLength(1);
    expect(kickoff[0]!.body).toContain('verbatim from your creators');
    expect(repos.events.byKind('agent_born')).toHaveLength(1);

    // duplicate id blocked
    expect(tryBirth(repos, projectRoot, approval).ok).toBe(false);
  });

  it('records procreation_rejected for self-approvals via cycle gateway', async () => {
    const { repos, projectRoot } = d;
    const proposal = proposeMail(repos, 'agent-a');
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: {
        'agent-a': {
          pending: () => false,
          run: async () => ({
            mails: [{
              to: 'agent-b', type: 'DECISION', subject: 'self ok', body: 'APPROVE',
            }],
            taskMoves: [],
            summary: 'trying to self-approve',
          }),
        },
      },
      agents: ['agent-a'],
      situation: { projectRoot },
    };
    await runCycle(deps, 'agent-a', 1);
    // different thread → 'no proposal in thread' → silently ignored, no birth
    expect(repos.nursery.byId('scout-001')).toBeUndefined();
    expect(repos.events.byKind('agent_born')).toHaveLength(0);
    void projectRoot;
  });
});

describe('permission gateway', () => {
  it('blocks non-report mail and task moves from stage-1 babies', async () => {
    const { repos, dir } = d2();
    repos.nursery.register({
      id: 'scout-001',
      name: 'Scout',
      purpose: 'watch',
      createdBy: ['agent-a', 'agent-b'],
      proposalThread: 't',
    });

    const driver: OrchestratorDeps['drivers']['agent-a'] = {
      pending: () => false,
      run: async () => ({
        mails: [
          { to: 'agent-a', type: 'STATUS', subject: 'allowed report', body: 'all quiet' },
          { to: 'agent-a', type: 'IDEA', subject: 'big idea', body: 'should not pass' },
        ],
        taskMoves: [{ taskId: 1, state: 'active' }],
        summary: 'attempted overreach',
      }),
    };
    const deps: OrchestratorDeps = {
      repos,
      budgets: new Budgets({ maxTokensPerCycle: 5000, maxCyclesPerHour: 50 }),
      drivers: { 'scout-001': driver as never },
      agents: ['scout-001'],
      situation: { projectRoot: join(dir, 'project') },
    };
    repos.tasks.create('human', { title: 'tempting task' });
    repos.mail.enqueue('orchestrator', { to: 'scout-001', type: 'STATUS', subject: 'wake', body: 'go' });

    await runCycle(deps, 'scout-001', 1);

    const filed = repos.events.byKind('mail_filed').map((e) => JSON.parse(e.payload).type);
    expect(filed).toEqual(['STATUS']); // only the allowed type passed
    expect(repos.tasks.byId(1).state).toBe('proposed'); // move blocked
    const denied = repos.events.byKind('permission_denied').map((e) => JSON.parse(e.payload).action);
    expect(denied).toContain('mail:IDEA');
    expect(denied).toContain('task:active');
    cleanup(dir);
  });

  it('capabilitiesFor returns null for parent agents', () => {
    const { repos, dir } = d2();
    expect(capabilitiesFor(repos, 'agent-a')).toBeNull();
    cleanup(dir);
  });

  function d2(): { repos: Repos; dir: string; db: Db } {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-s9b-'));
    const db = openDb(join(dir, 'lab.db'));
    return { repos: createRepos(db), dir, db };
  }
});

describe('baby rules-engine runtime', () => {
  it('observes workspace deltas, logs them, reports to creators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-s9c-'));
    const db = openDb(join(dir, 'lab.db'));
    const repos = createRepos(db);
    const projectRoot = join(dir, 'project');
    const wsRoot = join(dir, 'ws');
    const ws = new Workspace(wsRoot);
    await ws.ensureRepo();

    repos.nursery.register({
      id: 'scout-001', name: 'Scout', purpose: 'watch', createdBy: ['agent-a'], proposalThread: 't',
    });

    const driver = new BabyDriver('scout-001', repos, ws, projectRoot);

    // first run: baseline observation, nothing to report yet
    const first = await driver.run({ agent: 'scout-001', cycle: 1, situation: 'Unread mail:\n  (none)' });
    expect(first.mails).toHaveLength(0);
    expect(readFileSync(join(projectRoot, 'agents', 'scout-001', 'observations.log'), 'utf8'))
      .toContain('workspace clean');

    // workspace changes → next cycle reports
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(wsRoot, 'new-file.txt'), 'data');
    await ws.markSeen('ignored-marker'); // ensure lastHead differs after commit below
    const second = await driver.run({ agent: 'scout-001', cycle: 2, situation: 'Unread mail:\n  (none)' });
    void second;
    // commit so head changes
    const git = (await import('simple-git')).simpleGit({ baseDir: wsRoot });
    await git.add(['.']);
    await git.commit('agents did work');
    const third = await driver.run({ agent: 'scout-001', cycle: 3, situation: 'Unread mail:\n  (none)' });

    expect(third.mails.length).toBeGreaterThanOrEqual(1);
    expect(third.mails.every((m) => m.type === 'STATUS')).toBe(true);
    expect(third.mails[0]!.to).toBe('agent-a'); // reports to its creator

    // pending() reflects unread mail
    repos.mail.enqueue('x', { to: 'scout-001', type: 'QUESTION', subject: '?', body: '?' });
    expect(driver.pending()).toBe(true);

    db.close();
    cleanup(dir);
  });
});

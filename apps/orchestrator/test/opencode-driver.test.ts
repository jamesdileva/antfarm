import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILDER,
  CRITIC,
  renderDrivePrompt,
} from '../src/drives.js';
import { OpenCodeDriver, extractJson, extractUsage } from '../src/drivers/opencode.js';
import type { OpencodeSessionClient } from '../src/drivers/opencode.js';

function fakeClient(response: {
  structured?: unknown;
  text?: string;
  error?: { name?: string; message?: string };
  tokens?: Record<string, number>;
}): { client: OpencodeSessionClient; calls: { created: string[]; prompts: string[]; systems: string[] } } {
  const calls = { created: [] as string[], prompts: [] as string[], systems: [] as string[] };
  const client: OpencodeSessionClient = {
    session: {
      create: async (args) => {
        const id = `sess-${calls.created.length + 1}`;
        calls.created.push(args.body.title ?? '');
        return { data: { id } };
      },
      prompt: async (args) => {
        calls.prompts.push(args.body.parts[0]!.text);
        calls.systems.push(args.body.system ?? '');
        expect(args.body.system).toContain('RESPONSE FORMAT');
        const text = response.text ?? JSON.stringify(response.structured ?? {});
        return {
          data: {
            info: { error: response.error, tokens: response.tokens },
            parts: [{ type: 'text', text }],
          },
        };
      },
    },
  };
  return { client, calls };
}

describe('drive sheets', () => {
  it('render role prompts with no seeded ideas (idea-neutrality)', () => {
    for (const sheet of [BUILDER, CRITIC]) {
      const prompt = renderDrivePrompt(sheet);
      expect(prompt).toContain(sheet.role);
      // no project suggestions, no tech stack hints
      expect(prompt.toLowerCase()).not.toMatch(/app|tracker|notes|todo|game|website/);
    }
    expect(BUILDER.needs.length).toBeGreaterThan(0);
    expect(CRITIC.primaryGoal).toMatch(/quality|challenge/i);
  });

  it('builder carries the segment-commit discipline; critic does not', () => {
    const builder = renderDrivePrompt(BUILDER);
    expect(builder).toContain('Operational discipline');
    expect(builder).toContain('ONE committable segment per cycle');
    expect(builder).toContain('never hold uncommitted work');

    const critic = renderDrivePrompt(CRITIC);
    expect(critic).not.toContain('Operational discipline');
  });
});

describe('OpenCodeDriver', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'antfarm-oc-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('creates a session per cycle and returns zod-validated actions', async () => {
    const structured = {
      mails: [{ to: 'agent-b', type: 'REVIEW', subject: 'looks good', body: 'ship it' }],
      taskMoves: [{ taskId: 3, state: 'active', owner: 'agent-a' }],
      summary: 'reviewed',
    };
    const { client, calls } = fakeClient({ structured });
    const driver = new OpenCodeDriver({
      client,
      driveSheet: BUILDER,
      context: () => 'PROJECT GOAL: test goal',
    });

    const actions = await driver.run({ agent: 'agent-a', cycle: 1, situation: 'SITUATION REPORT — test' });

    expect(calls.created).toEqual(['agent-a · cycle 1']);
    expect(actions.mails[0]!.subject).toBe('looks good');
    expect(actions.taskMoves[0]!.taskId).toBe(3);
    // drive sheet + context go in system; situation is the user message
    expect(calls.systems[0]).toContain('Builder');
    expect(calls.systems[0]).toContain('PROJECT GOAL');
    expect(calls.prompts[0]).toContain('SITUATION REPORT');
  });

  it('throws on assistant errors instead of parsing garbage', async () => {
    const { client } = fakeClient({ error: { name: 'ProviderAuthError', message: 'no key' } });
    const driver = new OpenCodeDriver({ client, driveSheet: CRITIC });
    await expect(driver.run({ agent: 'agent-b', cycle: 1, situation: 's' })).rejects.toThrow(/assistant error/i);
  });

  it('rejects malformed agent output via schema validation', async () => {
    const { client } = fakeClient({ structured: { mails: [{ to: 'agent-b', type: 'GOSSIP', subject: '', body: '' }] } });
    const driver = new OpenCodeDriver({ client, driveSheet: BUILDER });
    await expect(driver.run({ agent: 'agent-a', cycle: 1, situation: 's' })).rejects.toThrow();
  });

  it('extracts JSON from fenced and prose-wrapped responses', () => {
    expect(extractJson('```json\n{"summary":"x"}\n```')).toEqual({ summary: 'x' });
    expect(extractJson('Here are my actions:\n{"mails":[],"summary":"done"} hope that helps!'))
      .toEqual({ mails: [], summary: 'done' });
    expect(() => extractJson('no json here at all')).toThrow(/no JSON object/);
    expect(() => extractJson('{"broken": ')).toThrow(/no JSON object|not valid JSON/);
  });

  it('extracts usage defensively across shapes', () => {
    expect(extractUsage({ tokens: { input: 10, output: 5 }, cost: 0.02 }))
      .toEqual({ tokensIn: 10, tokensOut: 5, cost: 0.02, model: '' });
    expect(extractUsage({ tokens: { inputTokens: 7, outputTokens: 3 }, modelID: 'm', providerID: 'p' }))
      .toEqual({ tokensIn: 7, tokensOut: 3, cost: 0, model: 'p/m' });
    expect(extractUsage({})).toEqual({ tokensIn: 0, tokensOut: 0, cost: 0, model: '' });
  });
});

describe('mode 1 goal seeding', () => {
  it('seeds PROJECT_GOAL.md verbatim and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-goal-'));
    const { seedGoal, readGoal } = await import('../src/goal.js');
    const projectRoot = join(dir, 'project');

    expect(readGoal(projectRoot)).toBeNull();
    seedGoal(projectRoot, 'Build a desktop habit tracker.\n');
    expect(readGoal(projectRoot)).toBe('Build a desktop habit tracker.');

    rmSync(dir, { recursive: true, force: true });
  });

  it('injects the goal into the situation report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antfarm-sit-'));
    const projectRoot = join(dir, 'project');
    const { mkdirSync: md } = await import('node:fs');
    md(join(projectRoot, 'shared'), { recursive: true });
    writeFileSync(join(projectRoot, 'shared', 'PROJECT_GOAL.md'), 'Make something useful.');

    const { buildSituation } = await import('../src/situation.js');
    const db = (await import('@antfarm/db')).openDb(join(dir, 'lab.db'));
    const repos = (await import('@antfarm/db')).createRepos(db);

    const report = buildSituation(repos, 'agent-a', { projectRoot, workspaceSummary: '2 changed file(s): src/x.ts' });
    expect(report).toContain('Make something useful.');
    expect(report).toContain('2 changed file(s)');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

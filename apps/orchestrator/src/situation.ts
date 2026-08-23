import type { Repos } from '@antfarm/db';
import { readGoal } from './goal.js';

export interface SituationContext {
  projectRoot: string;
  workspaceSummary?: string | null;
}

/** Decisions the agent hasn't seen yet — DECISIONS.md protocol (§2.4). */
export function decisionsSince(repos: Repos, agent: string): { id: number; lines: string[]; latest: number } {
  const pointer = repos.state.getDecisionPointer(agent);
  const all = repos.events.byKind('decision_logged').filter((e) => e.id > pointer);
  const lines = all.map((e) => {
    const p = JSON.parse(e.payload) as { from: string; subject: string; body: string };
    return `  [D#${e.id}] ${p.from}: ${p.subject} — ${p.body}`;
  });
  const latest = all.length ? Math.max(...all.map((e) => e.id)) : pointer;
  return { id: pointer, lines, latest };
}

/** Human-readable mirror of the decision log (derived view, D4). */
export function renderDecisionsMarkdown(repos: Repos): string {
  const all = repos.events.byKind('decision_logged');
  return [
    '# DECISIONS',
    '',
    ...all.map((e) => {
      const p = JSON.parse(e.payload) as { from: string; subject: string; body: string; cycle?: number };
      return `- D#${e.id} (${p.from}${p.cycle !== undefined ? `, cycle ${p.cycle}` : ''}): ${p.subject} — ${p.body}`;
    }),
    '',
  ].join('\n');
}

/** Human-readable situation report injected into each cycle prompt. */
export function buildSituation(repos: Repos, agent: string, ctx: SituationContext): string {
  const mail = repos.mail.queuedFor(agent);
  const tasks = repos.tasks.list();
  const board = tasks.length
    ? tasks.map((t) => `  #${t.id} [${t.state}] ${t.title} (owner: ${t.owner ?? 'none'})`).join('\n')
    : '  (empty)';

  const goal = readGoal(ctx.projectRoot);
  const decisions = decisionsSince(repos, agent);
  const memory = repos.memory.current(agent);

  const lines = [
    `SITUATION REPORT — ${agent}`,
    '',
    ...(goal ? ['PROJECT GOAL (authored by the human; treat as the mission):', goal, ''] : []),
    ...(memory ? ['YOUR MEMORY.md (your own compacted working memory):', memory, ''] : []),
    ...(ctx.workspaceSummary ? ['Workspace:', `  ${ctx.workspaceSummary}`, ''] : []),
    'Unread mail:',
    ...(mail.length
      ? mail.map((m) => `  [${m.type}] #${m.id} from ${m.from_agent}: ${m.subject}\n      ${m.body}`)
      : ['  (none)']),
    '',
    'Task board:',
    board,
    '',
    'New decisions since your last review:',
    ...(decisions.lines.length ? decisions.lines : ['  (none)']),
    '',
    'Before answering, consider updating your memoryUpdate (compact working',
    'memory: current goal, open threads, key learnings — ≤20 lines).',
    'Answer with structured actions (mails, task moves, memoryUpdate, summary).',
  ];
  return lines.join('\n');
}

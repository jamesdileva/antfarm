import type { MailRow, Repos } from '@antfarm/db';
import { readGoal } from './goal.js';
import { harnessSummary } from './harness.js';

export interface SituationContext {
  projectRoot: string;
  workspaceSummary?: string | null;
  /** absolute path of the (possibly external) workspace — shown to agents */
  workspaceDir?: string;
  /** constrained = agents must decide what to build before building (Mode 2) */
  mode?: 'directed' | 'constrained';
}

export function hasDecision(repos: Repos): boolean {
  return repos.events.byKind('decision_logged').length > 0;
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

/** Standing human directives — durable provenance for human mail/task authorizations. */
function humanDirectives(repos: Repos): string[] {
  const all = repos.events.byKind('human_directive');
  if (!all.length) return ['  (none)'];
  return all.slice(-5).map((e) => {
    const p = JSON.parse(e.payload) as { channel: string; id: number; to?: string; type?: string; subject?: string; title?: string; owner?: string | null };
    const what = p.channel === 'mail'
      ? `${p.type} mail #${p.id} to ${p.to}: ${p.subject}`
      : `task #${p.id} (owner ${p.owner ?? 'anyone'}): ${p.title}`;
    return `  [${p.channel}] ${what}`;
  });
}

/** Human-readable situation report injected into each cycle prompt. */
export function buildSituation(
  repos: Repos,
  agent: string,
  ctx: SituationContext,
  /** pre-captured inbox — MUST be fetched before markDelivered (S2 regression guard) */
  inbox?: MailRow[]
): string {
  const mail = inbox ?? repos.mail.queuedFor(agent);
  const tasks = repos.tasks.list();
  const board = tasks.length
    ? tasks.map((t) => `  #${t.id} [${t.state}] ${t.title} (owner: ${t.owner ?? 'none'})`).join('\n')
    : '  (empty)';

  const goal = readGoal(ctx.projectRoot);
  const decisions = decisionsSince(repos, agent);
  const memory = repos.memory.current(agent);
  const constrainedSelection =
    ctx.mode === 'constrained' && !hasDecision(repos);

  const lines = [
    `SITUATION REPORT — ${agent}`,
    '',
    ...(goal ? ['PROJECT GOAL (authored by the human; treat as the mission):', goal, ''] : []),
    ...(constrainedSelection
      ? [
          'PHASE: project selection.',
          'No project has been chosen yet. Brainstorm via IDEA mail, converge,',
          'and file a DECISION naming the project before starting any work.',
          '',
        ]
      : []),
    ...(memory ? ['YOUR MEMORY.md (your own compacted working memory):', memory, ''] : []),
    ...(ctx.workspaceDir
      ? ['WORKSPACE (all file work happens here):', `  ${ctx.workspaceDir}`, '']
      : []),
    ...(ctx.workspaceSummary ? ['Workspace:', `  ${ctx.workspaceSummary}`, ''] : []),
    'Checks:',
    ...harnessSummary(repos).map((s) => `  ${s}`),
    '',
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
    'Standing human directives (authorizations from the human — cite these IDs as provenance):',
    ...humanDirectives(repos),
    '',
    'Before answering, consider updating your memoryUpdate (compact working',
    'memory: current goal, open threads, key learnings — ≤20 lines).',
    'Answer with structured actions (mails, task moves, memoryUpdate, summary).',
  ];
  return lines.join('\n');
}

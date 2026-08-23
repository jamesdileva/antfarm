import type { Repos } from '@antfarm/db';
import { readGoal } from './goal.js';

export interface SituationContext {
  projectRoot: string;
  workspaceSummary?: string | null;
}

/** Human-readable situation report injected into each cycle prompt. */
export function buildSituation(repos: Repos, agent: string, ctx: SituationContext): string {
  const mail = repos.mail.queuedFor(agent);
  const tasks = repos.tasks.list();
  const board = tasks.length
    ? tasks.map((t) => `  #${t.id} [${t.state}] ${t.title} (owner: ${t.owner ?? 'none'})`).join('\n')
    : '  (empty)';

  const goal = readGoal(ctx.projectRoot);

  const lines = [
    `SITUATION REPORT — ${agent}`,
    '',
    ...(goal ? ['PROJECT GOAL (authored by the human; treat as the mission):', goal, ''] : []),
    ...(ctx.workspaceSummary ? ['Workspace:', `  ${ctx.workspaceSummary}`, ''] : []),
    'Unread mail:',
    ...(mail.length
      ? mail.map((m) => `  [${m.type}] #${m.id} from ${m.from_agent}: ${m.subject}\n      ${m.body}`)
      : ['  (none)']),
    '',
    'Task board:',
    board,
    '',
    'Answer with structured actions (mails to file, task moves, summary).',
  ];
  return lines.join('\n');
}

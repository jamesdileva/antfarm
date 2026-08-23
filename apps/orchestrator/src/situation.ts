import type { Repos } from '@antfarm/db';

/** Human-readable situation report injected into each cycle prompt. */
export function buildSituation(repos: Repos, agent: string): string {
  const mail = repos.mail.queuedFor(agent);
  const tasks = repos.tasks.list();
  const board = tasks.length
    ? tasks.map((t) => `  #${t.id} [${t.state}] ${t.title} (owner: ${t.owner ?? 'none'})`).join('\n')
    : '  (empty)';

  const lines = [
    `SITUATION REPORT — ${agent}`,
    '',
    'Unread mail:',
    ...(mail.length
      ? mail.map((m) => `  [${m.type}] #${m.id} from ${m.from_agent}: ${m.subject}`)
      : ['  (none)']),
    '',
    'Task board:',
    board,
    '',
    'Answer with structured actions (mails to file, task moves, summary).',
  ];
  return lines.join('\n');
}

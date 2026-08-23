import type { MailRow, Repos } from '@antfarm/db';

export interface EscalationConfig {
  /** QUESTION/HELP older than this (ms since delivery) escalate */
  staleAfterMs: number;
  now?: () => number;
}

/**
 * Livelock guard (architecture §3.2): a question that sits unanswered
 * escalates to an orchestrator WARNING — exactly once per thread.
 */
export function escalateStale(repos: Repos, cfg: EscalationConfig): MailRow[] {
  const now = cfg.now?.() ?? Date.now();
  const escalated: MailRow[] = [];

  for (const { root, answered } of repos.mail.unansweredThreads()) {
    if (answered) continue;
    const deliveredMs = Date.parse(root.delivered_at ?? '');
    if (!Number.isFinite(deliveredMs) || now - deliveredMs < cfg.staleAfterMs) continue;

    const alreadyEscalated = repos.events
      .byKind('mail_escalated')
      .some((e) => JSON.parse(e.payload).threadId === root.thread_id);
    if (alreadyEscalated) continue;

    const warning = repos.mail.enqueue('orchestrator', {
      to: root.to_agent,
      type: 'WARNING',
      subject: `unanswered ${root.type.toLowerCase()}: ${root.subject}`,
      body: [
        `Mail #${root.id} (${root.type} from ${root.from_agent}) has been`,
        `awaiting your response past the escalation threshold.`,
        `Original body: "${root.body}"`,
      ].join(' '),
      priority: 2,
      threadId: root.thread_id,
    });
    void warning;
    repos.events.append({
      kind: 'mail_escalated',
      actor: 'orchestrator',
      payload: { threadId: root.thread_id, messageId: root.id, to: root.to_agent },
    });
    escalated.push(root);
  }
  return escalated;
}

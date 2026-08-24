import type { MailRow, Repos } from '@antfarm/db';

export interface EscalationConfig {
  /** QUESTION/HELP older than this (ms since delivery) escalate */
  staleAfterMs: number;
  now?: () => number;
}

export interface LivelockConfig {
  /** REVIEW rounds without a DECISION before a thread is contested */
  maxReviewRounds: number;
  /** broader dispute threads (REVIEW/TASK/WARNING) threshold; defaults to maxReviewRounds */
  maxDisputeRounds?: number;
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

export interface ContestedThread {
  threadId: string;
  rounds: number;
  resolver: string;
}

/**
 * Review-livelock guard (architecture §3.2): a REVIEW thread that exceeds
 * maxReviewRounds without a DECISION is auto-resolved as `contested` —
 * resolution authority rotates between agents by round parity. Fires at
 * most once per thread.
 */
export function escalateReviewLivelock(
  repos: Repos,
  cfg: LivelockConfig & { agents?: [string, string] }
): ContestedThread[] {
  const [first, second] = cfg.agents ?? ['agent-a', 'agent-b'];
  // Dispute threads: REVIEW rounds OR TASK/WARNING demands ping-ponging
  // without a DECISION (overnight-run lesson: evidence-gate standoffs used
  // TASK/WARNING types and never hit the REVIEW counter).
  const disputeTypes = new Set(['REVIEW', 'TASK', 'WARNING']);
  const threads = new Map<string, number>();
  for (const type of disputeTypes) {
    for (const m of repos.mail.byKind(type as never)) {
      threads.set(m.thread_id, (threads.get(m.thread_id) ?? 0) + 1);
    }
  }

  const contested: ContestedThread[] = [];
  const disputeThreshold = cfg.maxDisputeRounds ?? cfg.maxReviewRounds;
  for (const [threadId, rounds] of threads) {
    if (rounds < disputeThreshold) continue;
    const hasDecision = repos.mail
      .byThread(threadId)
      .some((m) => m.type === 'DECISION');
    const alreadyContested = repos.events
      .byKind('thread_contested')
      .some((e) => (JSON.parse(e.payload) as { threadId: string }).threadId === threadId);
    if (hasDecision || alreadyContested) continue;

    const resolver = rounds % 2 === 0 ? first : second;
    const root = repos.mail.byThread(threadId)[0];
    repos.events.append({
      kind: 'decision_logged',
      actor: resolver,
      payload: {
        from: resolver,
        subject: `[contested, auto-resolved by ${resolver}] ${root?.subject ?? threadId}`,
        body: `Review thread stalled after ${rounds} REVIEW rounds without a decision; rotated authority resolved it.`,
        threadId,
      },
    });
    repos.events.append({
      kind: 'thread_contested',
      actor: 'orchestrator',
      payload: { threadId, rounds, resolver },
    });
    contested.push({ threadId, rounds, resolver });
  }
  return contested;
}

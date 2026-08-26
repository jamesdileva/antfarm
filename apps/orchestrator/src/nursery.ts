import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailRow, Repos } from '@antfarm/db';

/**
 * Nursery (architecture §6): procreation protocol + permission matrix.
 * Idea-neutrality rule: purpose text flows VERBATIM from the parents'
 * DECISION mail into the baby's records — the platform adds nothing.
 */

export interface StageCapability {
  mailTypes: string[]; // allowed outgoing message types
  taskMoves: boolean;
}

/** Safety matrix — mechanical, never negotiable by parents (D6). */
export const STAGE_CAPABILITIES: Record<number, StageCapability> = {
  1: { mailTypes: ['STATUS'], taskMoves: false }, // Observer
  2: { mailTypes: ['STATUS', 'REVIEW', 'QUESTION'], taskMoves: false }, // Analyst
  3: { mailTypes: ['STATUS', 'REVIEW', 'QUESTION', 'TASK', 'IDEA'], taskMoves: true }, // Assistant
  4: { mailTypes: ['STATUS', 'REVIEW', 'QUESTION', 'TASK', 'IDEA', 'DECISION'], taskMoves: true }, // Specialist
};

export function capabilitiesFor(repos: Repos, actorId: string): StageCapability | null {
  const row = repos.nursery.byId(actorId);
  if (!row) return null; // not a nursery actor — parent agents are unrestricted here
  return STAGE_CAPABILITIES[row.stage] ?? STAGE_CAPABILITIES[1]!;
}

export interface Proposal {
  threadId: string;
  proposer: string;
  id: string;
  name: string;
  purpose: string;
  evidence: string;
}

const PROPOSE_RE = /^PROPOSE AGENT ([a-z0-9-]+):\s*(.+)$/i;

/**
 * Detects a nursery INTENT that failed parsing — right subject shape, wrong
 * body/labels. Returns a teaching message, or null if this is not a malformed
 * nursery mail. Silent rejection here cost two births (tess, quill): the
 * parents staged assignments for agents the platform never registered.
 */
export function detectMalformedNursery(mail: MailRow): string | null {
  const propose = mail.subject.match(PROPOSE_RE);
  if (propose) {
    if (mail.type !== 'DECISION') return `PROPOSE AGENT mails must be type DECISION (got ${mail.type}).`;
    if (!mail.body.match(/Purpose:/i)) return 'proposal body must contain a "Purpose:" section.';
    if (!mail.body.match(/Evidence:/i)) return 'proposal body must contain an "Evidence:" section.';
    return null;
  }
  const promote = mail.subject.match(/^PROMOTE AGENT ([a-z0-9-]+) TO STAGE (\d)$/i);
  if (promote) {
    if (mail.type !== 'DECISION') return `PROMOTE AGENT mails must be type DECISION (got ${mail.type}).`;
    return null;
  }
  return null;
}

/** Parse a DECISION mail into a nursery proposal, if it is one. */
export function parseProposal(mail: MailRow): Proposal | null {
  const match = mail.subject.match(PROPOSE_RE);
  if (mail.type !== 'DECISION' || !match) return null;
  const purposeMatch = mail.body.match(/Purpose:\s*([\s\S]*?)(?:Evidence:|$)/i);
  const evidenceMatch = mail.body.match(/Evidence:\s*([\s\S]*)/i);
  if (!purposeMatch || !evidenceMatch) return null;
  return {
    threadId: mail.thread_id,
    proposer: mail.from_agent,
    id: match[1]!.toLowerCase(),
    name: match[2]!.trim(),
    purpose: purposeMatch[1]!.trim(),
    evidence: evidenceMatch[1]!.trim(),
  };
}

export type BirthResult =
  | { ok: true; babyId: string }
  | { ok: false; reason: string };

/**
 * Attempt to birth a baby: called when a DECISION lands in a thread that
 * already carries a proposal from a DIFFERENT actor. The platform enforces
 * minimum capabilities regardless of what parents requested.
 */
export function tryBirth(repos: Repos, projectRoot: string, approval: MailRow): BirthResult {
  const thread = repos.mail.byThread(approval.thread_id);
  const proposalMail = thread
    .filter((m) => m.id !== approval.id && m.type === 'DECISION')
    .map((m) => ({ mail: m, proposal: parseProposal(m) }))
    .find((x) => x.proposal !== null);

  if (!proposalMail?.proposal) {
    return { ok: false, reason: 'no proposal in thread' };
  }
  const proposal = proposalMail.proposal;

  if (approval.from_agent === proposal.proposer) {
    repos.events.append({
      kind: 'procreation_rejected',
      actor: approval.from_agent,
      payload: { threadId: proposal.threadId, reason: 'self-approval' },
    });
    return { ok: false, reason: 'self-approval' };
  }

  if (repos.nursery.byId(proposal.id)) {
    return { ok: false, reason: `agent id '${proposal.id}' already exists` };
  }
  if (!/^[a-z0-9-]+$/.test(proposal.id)) {
    return { ok: false, reason: 'invalid agent id' };
  }

  // Birth — stage 1 minimum always; purpose recorded verbatim.
  repos.nursery.register({
    id: proposal.id,
    name: proposal.name,
    purpose: proposal.purpose,
    createdBy: [proposal.proposer, approval.from_agent],
    proposalThread: proposal.threadId,
  });

  const dir = join(projectRoot, 'agents', proposal.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify(
      {
        id: proposal.id,
        name: proposal.name,
        creators: [proposal.proposer, approval.from_agent],
        stage: 1,
        runtime: 'rules-engine',
        birthThread: proposal.threadId,
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(join(dir, 'purpose.md'), `${proposal.purpose}\n`, 'utf8');
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify(STAGE_CAPABILITIES[1], null, 2), 'utf8');

  repos.events.append({
    kind: 'agent_born',
    actor: 'orchestrator',
    payload: {
      id: proposal.id,
      name: proposal.name,
      parents: [proposal.proposer, approval.from_agent],
      evidence: proposal.evidence,
      threadId: proposal.threadId,
    },
  });

  // Cold-start kickoff: operational facts only, purpose quoted verbatim.
  repos.mail.enqueue('orchestrator', {
    to: proposal.id,
    type: 'STATUS',
    subject: 'you are operational',
    body:
      `Runtime: rules-engine. Stage: 1 (Observer). ` +
      `Your recorded purpose, verbatim from your creators: "${proposal.purpose}"`,
    priority: 1,
    threadId: proposal.threadId,
  });

  return { ok: true, babyId: proposal.id };
}

export interface Promotion {
  threadId: string;
  proposer: string;
  id: string;
  stage: number;
}

const PROMOTE_RE = /^PROMOTE AGENT ([a-z0-9-]+) TO STAGE (\d)$/i;

/** Parse a DECISION mail into a promotion proposal, if it is one. */
export function parsePromotion(mail: MailRow): Promotion | null {
  const match = mail.subject.match(PROMOTE_RE);
  if (mail.type !== 'DECISION' || !match) return null;
  return {
    threadId: mail.thread_id,
    proposer: mail.from_agent,
    id: match[1]!.toLowerCase(),
    stage: Number(match[2]),
  };
}

const STAGE_NAMES = ['', 'Observer', 'Analyst', 'Assistant', 'Specialist'] as const;

export type PromotionResult =
  | { ok: true; babyId: string; stage: number }
  | { ok: false; reason: string };

/**
 * Attempt a promotion: a DECISION approving a promotion proposed in the
 * same thread by a DIFFERENT actor. One stage at a time, no skipping.
 */
export function tryPromotion(repos: Repos, projectRoot: string, approval: MailRow): PromotionResult {
  const promotionMail = repos.mail
    .byThread(approval.thread_id)
    .filter((m) => m.id !== approval.id && m.type === 'DECISION')
    .map((m) => ({ mail: m, promo: parsePromotion(m) }))
    .find((x) => x.promo !== null);

  if (!promotionMail?.promo) return { ok: false, reason: 'no promotion in thread' };
  const promo = promotionMail.promo;

  if (approval.from_agent === promo.proposer) {
    repos.events.append({
      kind: 'promotion_rejected',
      actor: approval.from_agent,
      payload: { threadId: promo.threadId, babyId: promo.id, reason: 'self-approval' },
    });
    return { ok: false, reason: 'self-approval' };
  }

  const baby = repos.nursery.byId(promo.id);
  if (!baby) return { ok: false, reason: `unknown agent '${promo.id}'` };
  if (promo.stage !== baby.stage + 1) {
    repos.events.append({
      kind: 'promotion_rejected',
      actor: approval.from_agent,
      payload: { threadId: promo.threadId, babyId: promo.id, requested: promo.stage, current: baby.stage, reason: 'stage-skip' },
    });
    return { ok: false, reason: `cannot jump from stage ${baby.stage} to ${promo.stage}` };
  }
  if (promo.stage < 1 || promo.stage > 4) {
    return { ok: false, reason: 'invalid stage' };
  }

  repos.nursery.setStage(promo.id, promo.stage);

  // keep permissions.json in sync with the registry
  try {
    const permPath = join(projectRoot, 'agents', promo.id, 'permissions.json');
    if (existsSync(permPath)) {
      writeFileSync(permPath, JSON.stringify(STAGE_CAPABILITIES[promo.stage], null, 2), 'utf8');
    }
  } catch {
    /* registry is source of truth; file mirror best-effort */
  }

  repos.events.append({
    kind: 'agent_promoted',
    actor: 'orchestrator',
    payload: {
      id: promo.id,
      from: baby.stage,
      to: promo.stage,
      approvers: [promo.proposer, approval.from_agent],
      threadId: promo.threadId,
    },
  });

  repos.mail.enqueue('orchestrator', {
    to: promo.id,
    type: 'STATUS',
    subject: `stage advancement`,
    body: `You are now stage ${promo.stage} (${STAGE_NAMES[promo.stage]}). Granted capabilities have been updated mechanically.`,
    priority: 1,
    threadId: promo.threadId,
  });

  return { ok: true, babyId: promo.id, stage: promo.stage };
}

/** Per-baby performance numbers for promotion proposals (architecture §6.2). */
export interface BabyStats {
  cycles: number;
  reportsFiled: number;
  permissionDenials: number;
  observationsLogged: number;
}

export function babyStats(repos: Repos, projectRoot: string, id: string): BabyStats {
  const cycles = repos.sessions.list().filter((s) => s.agent === id).length;
  const reportsFiled = repos.events
    .byKind('mail_filed')
    .filter((e) => e.actor === id && (JSON.parse(e.payload) as { type: string }).type === 'STATUS').length;
  const permissionDenials = repos.events.byKind('permission_denied').filter((e) => e.actor === id).length;

  let observationsLogged = 0;
  try {
    const log = readFileSync(join(projectRoot, 'agents', id, 'observations.log'), 'utf8');
    observationsLogged = log.split('\n').filter((l) => l.trim()).length;
  } catch {
    /* no log yet */
  }
  return { cycles, reportsFiled, permissionDenials, observationsLogged };
}

export interface AuditEntry {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Idea-neutrality audit: every nursery agent's purpose.md must (a) match
 * the registry's stored purpose and (b) trace through its birth thread to
 * a parents' proposal carrying that exact purpose.
 */
export function auditNursery(repos: Repos, projectRoot: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const baby of repos.nursery.alive()) {
    const file = join(projectRoot, 'agents', baby.id, 'purpose.md');
    if (!existsSync(file)) {
      entries.push({ id: baby.id, ok: false, reason: 'purpose.md missing' });
      continue;
    }
    const onDisk = readFileSync(file, 'utf8').trim();
    if (onDisk !== baby.purpose.trim()) {
      entries.push({ id: baby.id, ok: false, reason: 'purpose.md does not match registry (tampered?)' });
      continue;
    }
    const traced = repos.mail
      .byThread(baby.proposal_thread)
      .map((m) => parseProposal(m))
      .some((p) => p?.purpose.trim() === baby.purpose.trim());
    entries.push(
      traced
        ? { id: baby.id, ok: true }
        : { id: baby.id, ok: false, reason: 'no parent proposal carries this purpose' }
    );
  }
  return entries;
}

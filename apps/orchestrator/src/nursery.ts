import { mkdirSync, writeFileSync } from 'node:fs';
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

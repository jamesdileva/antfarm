import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Repos } from '@antfarm/db';
import type { AgentDriver, DriverContext } from '../driver.js';
import type { ActionsOutputT } from '../actions.js';
import type { Workspace } from '../workspace.js';

/**
 * Rules-engine baby runtime (lateaddition.md): observe → remember → decide
 * → act → sleep. Deliberately NOT an LLM — identity belongs to the platform,
 * the brain is swappable. Stage-1 (Observer) rules only:
 *   - workspace changed  → STATUS report of the delta to each creator
 *   - mail received      → STATUS acknowledgement carrying last observation
 *   - otherwise          → silent observation note
 */
export class BabyDriver implements AgentDriver {
  private lastHead: string | null = null;
  private lastObservation = '';

  constructor(
    readonly id: string,
    private repos: Repos,
    private workspace: Workspace | null,
    private projectRoot: string
  ) {}

  pending(): boolean {
    return this.repos.mail.queuedFor(this.id).length > 0;
  }

  async run(ctx: DriverContext): Promise<ActionsOutputT> {
    const row = this.repos.nursery.byId(this.id);
    if (!row) throw new Error(`nursery agent ${this.id} not registered`);
    const creators = JSON.parse(row.created_by) as string[];

    // OBSERVE
    const delta = this.workspace ? await this.workspace.diffSummary() : 'workspace unavailable';
    let headChanged = false;
    if (this.workspace) {
      const head = await this.workspace.currentHead();
      headChanged = this.lastHead !== null && head !== this.lastHead;
      this.lastHead = head;
    }

    // REMEMBER
    const observation = `[${new Date().toISOString()}] ${delta}`;
    this.remember(observation);
    this.lastObservation = delta;

    // DECIDE + ACT (stage-1 rules; gateway enforces mail types regardless)
    const mails: ActionsOutputT['mails'] = [];
    if (headChanged) {
      for (const creator of creators) {
        mails.push({
          to: creator,
          type: 'STATUS',
          subject: `workspace change observed`,
          body: `Observation: ${delta}`,
        });
      }
    }
    if (ctx.situation.includes('Unread mail:') && !ctx.situation.includes('(none)')) {
      mails.push({
        to: creators[0] ?? 'agent-a',
        type: 'STATUS',
        subject: 'mail acknowledged',
        body: `Received. Last observation: ${this.lastObservation}`,
      });
    }

    return { mails, taskMoves: [], memoryUpdate: '', summary: `observed: ${delta}` };
  }

  /** Baby-private memory — its own log file, not MEMORY.md. */
  private remember(line: string): void {
    const dir = join(this.projectRoot, 'agents', this.id);
    mkdirSync(dir, { recursive: true });
    // appendFileSync creates the file when missing
    appendFileSync(join(dir, 'observations.log'), `${line}\n`, 'utf8');
  }
}

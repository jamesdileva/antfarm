/**
 * Idle backoff (architecture §3.1): agents that burn a cycle without
 * filing any action earn an exponentially growing re-wake delay, capped.
 * Productive cycles reset the curve. Pure bookkeeping — the loop consults
 * isReady() before waking.
 */
export class Backoff {
  private strikes = new Map<string, number>();

  constructor(
    private baseMs: number,
    private maxMs: number
  ) {}

  /** Record a cycle outcome; productive = at least one action filed. */
  record(agent: string, productive: boolean): void {
    if (productive) {
      this.strikes.delete(agent);
      return;
    }
    const next = Math.min((this.strikes.get(agent) ?? 0) + 1, 20);
    this.strikes.set(agent, next);
  }

  /** Delay grows base, 2×base, 4×base … capped at maxMs. */
  readyAt(agent: string, lastCycleAt: number): number {
    const n = this.strikes.get(agent);
    if (!n) return lastCycleAt;
    const delay = Math.min(this.baseMs * 2 ** (n - 1), this.maxMs);
    return lastCycleAt + delay;
  }

  isReady(agent: string, lastCycleAt: number, now = Date.now()): boolean {
    return now >= this.readyAt(agent, lastCycleAt);
  }

  pendingDelay(agent: string): number {
    return this.strikes.get(agent) ?? 0;
  }
}

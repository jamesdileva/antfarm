export interface BudgetConfig {
  maxTokensPerCycle: number;
  maxCyclesPerHour: number;
}

interface CycleStamp {
  at: number;
  tokens: number;
}

/** Mechanical budget enforcement — never prompted (architecture D6). */
export class Budgets {
  private stamps = new Map<string, CycleStamp[]>();
  /** agent -> ms timestamp when the token cap tripped */
  private exhaustedAt = new Map<string, number>();

  constructor(
    private cfg: BudgetConfig,
    private exhaustionCooldownMs = 600_000
  ) {}

  canRun(agent: string, now = Date.now()): { ok: boolean; reason?: string } {
    const exhaustedAt = this.exhaustedAt.get(agent);
    if (exhaustedAt !== undefined) {
      if (now - exhaustedAt < this.exhaustionCooldownMs) {
        return { ok: false, reason: 'budget_exhausted' };
      }
      // cooldown served — unpark automatically (S11: no manual restarts)
      this.exhaustedAt.delete(agent);
      this.stamps.set(agent, []);
    }
    const hourAgo = now - 3_600_000;
    const recent = (this.stamps.get(agent) ?? []).filter((s) => s.at > hourAgo);
    if (recent.length >= this.cfg.maxCyclesPerHour) {
      return { ok: false, reason: 'max_cycles_per_hour' };
    }
    return { ok: true };
  }

  recordCycle(agent: string, tokensIn: number, tokensOut: number, now = Date.now()): void {
    const tokens = tokensIn + tokensOut;
    if (tokens > this.cfg.maxTokensPerCycle && !this.exhaustedAt.has(agent)) {
      this.exhaustedAt.set(agent, now);
    }
    const stamps = (this.stamps.get(agent) ?? []).filter((s) => s.at > now - 3_600_000);
    stamps.push({ at: now, tokens });
    this.stamps.set(agent, stamps);
  }

  isExhausted(agent: string): boolean {
    return this.exhaustedAt.has(agent);
  }
}

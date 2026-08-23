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
  private exhaustedAgents = new Set<string>();

  constructor(private cfg: BudgetConfig) {}

  canRun(agent: string, now = Date.now()): { ok: boolean; reason?: string } {
    if (this.exhaustedAgents.has(agent)) {
      return { ok: false, reason: 'budget_exhausted' };
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
    if (tokens > this.cfg.maxTokensPerCycle) {
      this.exhaustedAgents.add(agent);
    }
    const stamps = (this.stamps.get(agent) ?? []).filter((s) => s.at > now - 3_600_000);
    stamps.push({ at: now, tokens });
    this.stamps.set(agent, stamps);
  }

  isExhausted(agent: string): boolean {
    return this.exhaustedAgents.has(agent);
  }
}

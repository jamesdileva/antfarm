import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LabConfig {
  projectRoot: string;
  budgets: { maxTokensPerCycle: number; maxCyclesPerHour: number };
  cycleTimeoutMs: number;
  escalationStaleAfterMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const DEFAULTS: LabConfig = {
  projectRoot: 'project',
  budgets: { maxTokensPerCycle: 20_000, maxCyclesPerHour: 30 },
  cycleTimeoutMs: 120_000,
  escalationStaleAfterMs: 3_600_000,
  backoffBaseMs: 500,
  backoffMaxMs: 60_000,
};

/** Shallow-merge a lab.config.json over the defaults; absent file is fine. */
export function loadConfig(projectDir = '.'): LabConfig {
  const path = join(projectDir, 'lab.config.json');
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return mergeConfig(DEFAULTS, raw);
}

export function mergeConfig(base: LabConfig, raw: unknown): LabConfig {
  const out = structuredClone(base);
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectRoot === 'string') out.projectRoot = r.projectRoot;
  if (typeof r.cycleTimeoutMs === 'number') out.cycleTimeoutMs = r.cycleTimeoutMs;
  if (typeof r.escalationStaleAfterMs === 'number') out.escalationStaleAfterMs = r.escalationStaleAfterMs;
  if (typeof r.backoffBaseMs === 'number') out.backoffBaseMs = r.backoffBaseMs;
  if (typeof r.backoffMaxMs === 'number') out.backoffMaxMs = r.backoffMaxMs;
  if (typeof r.budgets === 'object' && r.budgets !== null) {
    const b = r.budgets as Record<string, unknown>;
    if (typeof b.maxTokensPerCycle === 'number') out.budgets.maxTokensPerCycle = b.maxTokensPerCycle;
    if (typeof b.maxCyclesPerHour === 'number') out.budgets.maxCyclesPerHour = b.maxCyclesPerHour;
  }
  return out;
}

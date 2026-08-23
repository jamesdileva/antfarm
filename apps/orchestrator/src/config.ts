import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LabConfig {
  projectRoot: string;
  /** directed = human-authored goal; constrained = agents choose (Mode 2) */
  mode: 'directed' | 'constrained';
  budgets: { maxTokensPerCycle: number; maxCyclesPerHour: number };
  cycleTimeoutMs: number;
  escalationStaleAfterMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  harness: { buildCmd?: string; testCmd?: string; timeoutMs: number };
}

const DEFAULTS: LabConfig = {
  projectRoot: 'project',
  mode: 'directed',
  budgets: { maxTokensPerCycle: 20_000, maxCyclesPerHour: 30 },
  cycleTimeoutMs: 120_000,
  escalationStaleAfterMs: 3_600_000,
  backoffBaseMs: 500,
  backoffMaxMs: 60_000,
  harness: { timeoutMs: 120_000 },
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
  if (r.mode === 'directed' || r.mode === 'constrained') out.mode = r.mode;
  if (typeof r.cycleTimeoutMs === 'number') out.cycleTimeoutMs = r.cycleTimeoutMs;
  if (typeof r.escalationStaleAfterMs === 'number') out.escalationStaleAfterMs = r.escalationStaleAfterMs;
  if (typeof r.backoffBaseMs === 'number') out.backoffBaseMs = r.backoffBaseMs;
  if (typeof r.backoffMaxMs === 'number') out.backoffMaxMs = r.backoffMaxMs;
  if (typeof r.budgets === 'object' && r.budgets !== null) {
    const b = r.budgets as Record<string, unknown>;
    if (typeof b.maxTokensPerCycle === 'number') out.budgets.maxTokensPerCycle = b.maxTokensPerCycle;
    if (typeof b.maxCyclesPerHour === 'number') out.budgets.maxCyclesPerHour = b.maxCyclesPerHour;
  }
  if (typeof r.harness === 'object' && r.harness !== null) {
    const h = r.harness as Record<string, unknown>;
    if (typeof h.buildCmd === 'string') out.harness.buildCmd = h.buildCmd;
    if (typeof h.testCmd === 'string') out.harness.testCmd = h.testCmd;
    if (typeof h.timeoutMs === 'number') out.harness.timeoutMs = h.timeoutMs;
  }
  return out;
}

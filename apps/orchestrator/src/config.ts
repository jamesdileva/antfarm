import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LabConfig {
  projectRoot: string;
  /** directed = human-authored goal; constrained = agents choose (Mode 2) */
  mode: 'directed' | 'constrained';
  /** OpenCode model override, e.g. "anthropic/claude-sonnet-4" */
  model?: string;
  budgets: { maxTokensPerCycle: number; maxCyclesPerHour: number };
  cycleTimeoutMs: number;
  escalationStaleAfterMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  harness: { buildCmd?: string; testCmd?: string; timeoutMs: number };
  /** per-agent incentive overlays (see drives.PERSONALITIES), optional */
  personalities: Record<string, string>;
  /** daemon live mode: proactive idle cycle cadence + quiet-round sleep */
  idleTickMs: number;
  /** token-cap exhaustion auto-unpark window */
  exhaustionCooldownMs: number;
  /** delete opencode sessions after full capture in lab.db (S12) */
  sessionGc: boolean;
  /** external target repo for agents to work in; default = project/workspace */
  workspacePath?: string;
}

const DEFAULTS: LabConfig = {
  projectRoot: 'project',
  mode: 'directed',
  budgets: { maxTokensPerCycle: 20_000, maxCyclesPerHour: 30 },
  cycleTimeoutMs: 300_000,
  escalationStaleAfterMs: 3_600_000,
  backoffBaseMs: 500,
  backoffMaxMs: 60_000,
  harness: { timeoutMs: 120_000 },
  personalities: {},
  idleTickMs: 60_000,
  exhaustionCooldownMs: 600_000,
  sessionGc: false,
};

/** Shallow-merge a lab.config.json over the defaults; absent file is fine. */
export function loadConfig(projectDir = '.'): LabConfig {
  const path = join(projectDir, 'lab.config.json');
  return loadConfigFrom(path);
}

/** Load from an explicit file path (dashboard settings use this). */
export function loadConfigFrom(path: string): LabConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  // strip BOM — PowerShell-written configs carry one and JSON.parse rejects it
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  return mergeConfig(DEFAULTS, raw);
}

/** Persist a full config to an explicit file path. */
export function writeConfig(path: string, cfg: LabConfig): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

export function mergeConfig(base: LabConfig, raw: unknown): LabConfig {
  const out = structuredClone(base);
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectRoot === 'string') out.projectRoot = r.projectRoot;
  if (r.mode === 'directed' || r.mode === 'constrained') out.mode = r.mode;
  if (typeof r.model === 'string') out.model = r.model;
  if (typeof r.cycleTimeoutMs === 'number') out.cycleTimeoutMs = r.cycleTimeoutMs;
  if (typeof r.escalationStaleAfterMs === 'number') out.escalationStaleAfterMs = r.escalationStaleAfterMs;
  if (typeof r.backoffBaseMs === 'number') out.backoffBaseMs = r.backoffBaseMs;
  if (typeof r.backoffMaxMs === 'number') out.backoffMaxMs = r.backoffMaxMs;
  if (typeof r.idleTickMs === 'number') out.idleTickMs = r.idleTickMs;
  if (typeof r.exhaustionCooldownMs === 'number') out.exhaustionCooldownMs = r.exhaustionCooldownMs;
  if (typeof r.sessionGc === 'boolean') out.sessionGc = r.sessionGc;
  if (r.workspacePath === null) delete out.workspacePath;
  else if (typeof r.workspacePath === 'string' && r.workspacePath.trim()) out.workspacePath = r.workspacePath.trim();
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
  if (typeof r.personalities === 'object' && r.personalities !== null) {
    out.personalities = { ...r.personalities } as Record<string, string>;
  }
  return out;
}

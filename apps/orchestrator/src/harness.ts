import { exec } from 'node:child_process';
import type { Repos } from '@antfarm/db';

export interface HarnessConfig {
  workspaceDir: string;
  buildCmd?: string;
  testCmd?: string;
  timeoutMs: number;
}

export interface HarnessResult {
  kind: 'build' | 'test';
  ok: boolean;
  skipped?: boolean;
  durationMs: number;
  tail: string;
}

export type ExecFn = (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;

export const defaultExec: ExecFn = (cmd, cwd, timeoutMs) =>
  new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd,
        timeout: timeoutMs,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? (err.code ?? 1) : 0, output: `${stdout}\n${stderr}` })
    );
  });

const TAIL = 500;

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > TAIL ? `${flat.slice(-TAIL)}` : flat;
}

/** Scriptless/empty repos report SKIPPED instead of FAIL (S12). */
function isSkip(output: string): boolean {
  return /missing script|required.+but could not|no such file|cannot find/i.test(output);
}

/**
 * Build/test harness (architecture §2.7): runs inside /workspace only.
 * Results are events — prompts get summaries, never raw logs.
 */
export async function runHarness(repos: Repos, cfg: HarnessConfig, execFn: ExecFn = defaultExec): Promise<HarnessResult[]> {
  const results: HarnessResult[] = [];
  for (const [kind, cmd] of [
    ['build', cfg.buildCmd],
    ['test', cfg.testCmd],
  ] as const) {
    if (!cmd) continue;
    const start = Date.now();
    try {
      const { code, output } = await execFn(cmd, cfg.workspaceDir, cfg.timeoutMs);
      if (code !== 0 && isSkip(output)) {
        results.push({ kind, ok: true, skipped: true, durationMs: Date.now() - start, tail: truncate(output) });
      } else {
        results.push({ kind, ok: code === 0, durationMs: Date.now() - start, tail: truncate(output) });
      }
    } catch (err) {
      results.push({ kind, ok: false, durationMs: Date.now() - start, tail: truncate(String(err)) });
    }
    const r = results[results.length - 1]!;
    repos.events.append({
      kind: `${r.kind}_result`,
      actor: 'orchestrator',
      payload: { ok: r.ok, skipped: r.skipped ?? false, durationMs: r.durationMs, tail: r.tail },
    });
  }
  return results;
}

/** One-line summaries for the situation report. */
export function harnessSummary(repos: Repos): string[] {
  return (['build_result', 'test_result'] as const).map((kind) => {
    const last = repos.events.byKind(kind).at(-1);
    if (!last) return `${kind.replace('_result', '')}: not run yet`;
    const p = JSON.parse(last.payload) as { ok: boolean; skipped?: boolean; durationMs: number };
    if (p.skipped) return `${kind.replace('_result', '')}: SKIPPED`;
    return `${kind.replace('_result', '')}: ${p.ok ? 'PASS' : 'FAIL'} (${(p.durationMs / 1000).toFixed(1)}s)`;
  });
}

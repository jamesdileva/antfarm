import { createOpencode } from '@opencode-ai/sdk';
import { createServer } from 'node:net';
import { ActionsOutput, type ActionsOutputT } from '../actions.js';
import type { AgentDriver, DriverContext } from '../driver.js';
import {
  BUILDER,
  CRITIC,
  PERSONALITIES,
  renderDrivePrompt,
  resolvePersonality,
  type DriveSheet,
  type PersonalityName,
} from '../drives.js';

/**
 * Minimal client surface we depend on — lets tests inject a fake without
 * the SDK's full type tree.
 */
export interface OpencodeSessionClient {
  session: {
    create(args: { body: { title?: string }; query?: { directory?: string } }): Promise<{ data: { id: string } }>;
    prompt(args: {
      path: { id: string };
      query?: { directory?: string };
      body: {
        parts: Array<{ type: 'text'; text: string }>;
        /** drive sheet + personality — verified present on installed SDK */
        system?: string;
      };
    }): Promise<{
      data: {
        info: AssistantInfo;
        parts: Array<{ type: string; text?: string }>;
      };
    }>;
  } & {
    delete?(args: { path: { id: string } }): Promise<unknown>;
  };
}

export interface AssistantInfo {
  structured_output?: unknown;
  error?: { name?: string; message?: string; retries?: unknown };
  tokens?: Record<string, number>;
  cost?: number;
  modelID?: string;
  providerID?: string;
  [k: string]: unknown;
}

export interface UsageSample {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  model: string;
}

export interface HealthClient {
  global: {
    health(): Promise<{ data: { healthy: boolean; version?: string } }>;
  };
}

/** Grab a free ephemeral port so we never collide with stale servers. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    srv.on('error', reject);
  });
}

/**
 * Spawns a managed OpenCode server + client (createOpencode) instead of
 * assuming one is already listening. Uses a fresh free port per run —
 * a crashed earlier run can leave a server squatting on the default port.
 * Caller owns the returned close().
 */
export async function createManagedClient(opts?: {
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  /** OpenCode model override, e.g. "anthropic/claude-sonnet-4" */
  model?: string;
}): Promise<{ client: OpencodeSessionClient; serverUrl: string; close: () => void }> {
  const port = opts?.port ?? (await freePort());
  const opencode = await createOpencode({
    hostname: opts?.hostname ?? '127.0.0.1',
    port,
    timeout: opts?.timeoutMs ?? 15_000,
    ...(opts?.model ? { config: { model: opts.model } } : {}),
  });
  const client = opencode.client as unknown as OpencodeSessionClient;
  return { client, serverUrl: opencode.server.url, close: () => opencode.server.close() };
}

/**
 * Verifies the server answers before burning a cycle on it.
 * Uses raw HTTP — the SDK's health surface varies across versions
 * (v1 client has no global.health(); ground truth beats generated types).
 */
export async function assertServerHealthy(baseUrl: string): Promise<string> {
  const candidates = [`${baseUrl.replace(/\/$/, '')}/global/health`, `${baseUrl.replace(/\/$/, '')}/health`];
  let lastErr = 'unknown error';
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        lastErr = `${url} -> ${res.status}`;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { healthy?: boolean; version?: string };
      if (body.healthy === false) {
        lastErr = `${url} reported unhealthy`;
        continue;
      }
      return body.version ?? 'unknown version';
    } catch (err) {
      lastErr = `${url} -> ${(err as Error).message}`;
    }
  }
  throw new Error(
    `opencode server unreachable (${lastErr}). antfarm spawns its own via ` +
      `createOpencode() — if you disabled that, start one manually with ` +
      `\`opencode serve --port 4096\`.`
  );
}

export interface OpenCodeDriverOptions {
  baseUrl?: string;
  driveSheet: DriveSheet;
  /** incentive overlay name (see PERSONALITIES) */
  personality?: string;
  /**
   * directory the agents' file tools operate in (external targeting, S12).
   * Verified against installed SDK: session.create/prompt accept
   * query.directory.
   */
  directory?: string;
  /** extra static context injected every cycle (e.g. PROJECT_GOAL.md) */
  context?: () => string;
}

const SHEETS: Record<string, DriveSheet> = {
  'agent-a': BUILDER,
  'agent-b': CRITIC,
};

export class OpenCodeDriver implements AgentDriver {
  private client: OpencodeSessionClient;
  private opts: OpenCodeDriverOptions;
  readonly sheet: DriveSheet;
  /** most recent usage sample per agent — read by the orchestrator */
  private usageSamples = new Map<string, UsageSample>();
  private sessionIds = new Map<string, string>();

  constructor(opts: OpenCodeDriverOptions & { client?: OpencodeSessionClient }) {
    this.opts = opts;
    if (!opts.client) {
      throw new Error('OpenCodeDriver requires a client — use createManagedClient() in live mode');
    }
    this.client = opts.client;
    this.sheet = opts.driveSheet ?? BUILDER;
  }

  lastUsage(agent: string): UsageSample | undefined {
    return this.usageSamples.get(agent);
  }

  /** Session id from the most recent run — used by session GC. */
  lastSessionId(agent: string): string | undefined {
    return this.sessionIds.get(agent);
  }

  /** Delete the stored opencode session (session GC, S12). */
  async disposeSession(agent: string): Promise<void> {
    const id = this.sessionIds.get(agent);
    if (!id) return;
    this.sessionIds.delete(agent);
    await this.client.session.delete?.({ path: { id } });
  }

  static sheetFor(agent: string): DriveSheet {
    return SHEETS[agent] ?? BUILDER;
  }

  /**
   * Real agents are always wakeable — the scheduler gates them via
   * signals (mail, workspace changes) and budgets, never here.
   */
  pending(): boolean {
    return false;
  }

  async run(ctx: DriverContext): Promise<ActionsOutputT> {
    const directory = this.opts.directory ? { directory: this.opts.directory } : undefined;
    const created = await this.client.session.create({
      body: { title: `${ctx.agent} · cycle ${ctx.cycle}` },
      ...(directory ? { query: directory } : {}),
    });
    const sessionId = created.data.id;
    this.sessionIds.set(ctx.agent, sessionId);

    // The installed SDK has no json_schema structured output on prompt;
    // we instruct-for-JSON and validate with zod (teaching loop handles
    // malformed responses — guide §4.2).
    const systemText = [
      renderDrivePrompt(this.sheet, resolvePersonality(this.opts.personality)),
      '',
      'RESPONSE FORMAT (mandatory): your final message must be ONLY a JSON',
      'object, no prose before or after, matching exactly:',
      '{"mails":[{"to":"agent-a|agent-b","type":"QUESTION|IDEA|TASK|REVIEW|WARNING|DECISION|STATUS|HELP","subject":"≤120 chars","body":"...","priority":1-9}],"taskMoves":[{"taskId":number,"state":"proposed|active|blocked|done|dropped","owner":"agent id or null"}],"memoryUpdate":"compact working memory or empty string","summary":"one line"}',
      'Omit fields you do not need. No markdown fences.',
      '',
      this.opts.context ? this.opts.context() : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.session.prompt({
      path: { id: sessionId },
      ...(directory ? { query: directory } : {}),
      body: {
        parts: [{ type: 'text', text: ctx.situation }],
        system: systemText,
      },
    });

    const info = result.data.info;
    this.usageSamples.set(ctx.agent, extractUsage(info));
    if (info.error) {
      throw new Error(`assistant error: ${info.error.name ?? 'unknown'}: ${info.error.message ?? ''}`);
    }

    const text = result.data.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
    return ActionsOutput.parse(extractJson(text));
  }
}

/** Pull a JSON object out of model text: fenced block first, then brace scan. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in response: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new Error(`response was not valid JSON: ${(err as Error).message}`);
  }
}

/** Defensive token/cost/model extraction across SDK shape variations. */
export function extractUsage(info: AssistantInfo): UsageSample {
  const t = info.tokens ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    tokensIn: num(t.input) || num(t.inputTokens) || num(t.prompt),
    tokensOut: num(t.output) || num(t.outputTokens) || num(t.completion),
    cost: num(info.cost),
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : '',
  };
}

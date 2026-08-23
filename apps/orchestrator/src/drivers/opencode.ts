import { createOpencodeClient } from '@opencode-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
    create(args: { body: { title?: string } }): Promise<{ data: { id: string } }>;
    prompt(args: {
      path: { id: string };
      body: {
        parts: Array<{ type: 'text'; text: string }>;
        format?: { type: 'json_schema'; schema: object; retryCount?: number };
      };
    }): Promise<{ data: { info: AssistantInfo } }>;
  };
}

export interface AssistantInfo {
  structured_output?: unknown;
  error?: { name?: string; message?: string; retries?: unknown };
  tokens?: Record<string, number>;
  cost?: number;
  [k: string]: unknown;
}

export interface OpenCodeDriverOptions {
  baseUrl?: string;
  driveSheet: DriveSheet;
  /** incentive overlay name (see PERSONALITIES) */
  personality?: string;
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

  constructor(opts: OpenCodeDriverOptions & { client?: OpencodeSessionClient }) {
    this.opts = opts;
    this.client =
      opts.client ??
      (createOpencodeClient({ baseUrl: opts.baseUrl ?? 'http://127.0.0.1:4096' }) as unknown as OpencodeSessionClient);
    this.sheet = opts.driveSheet ?? SHEETS.agent;
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
    const created = await this.client.session.create({
      body: { title: `${ctx.agent} · cycle ${ctx.cycle}` },
    });
    const sessionId = created.data.id;

    const promptText = [
      renderDrivePrompt(this.sheet, resolvePersonality(this.opts.personality)),
      '',
      this.opts.context ? this.opts.context() : '',
      '',
      ctx.situation,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: promptText }],
        format: {
          type: 'json_schema',
          schema: zodToJsonSchema(ActionsOutput, { target: 'openAi' }) as object,
          retryCount: 2,
        },
      },
    });

    const info = result.data.info;
    if (info.error?.name === 'StructuredOutputError') {
      throw new Error(`structured output failed after retries: ${info.error.message ?? 'unknown'}`);
    }

    return ActionsOutput.parse(info.structured_output);
  }
}

/** Defensive token/cost extraction across SDK shape variations. */
export function extractUsage(info: AssistantInfo): { tokensIn: number; tokensOut: number; cost: number } {
  const t = info.tokens ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    tokensIn: num(t.input) || num(t.inputTokens) || num(t.prompt),
    tokensOut: num(t.output) || num(t.outputTokens) || num(t.completion),
    cost: num(info.cost),
  };
}

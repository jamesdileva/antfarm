import { randomUUID } from 'node:crypto';
import type { Db } from './migrate.js';

export const MessageTypes = [
  'QUESTION', 'IDEA', 'TASK', 'REVIEW', 'WARNING', 'DECISION', 'STATUS', 'HELP',
] as const;
export type MessageType = (typeof MessageTypes)[number];

export const TaskStates = ['proposed', 'active', 'blocked', 'done', 'dropped'] as const;
export type TaskState = (typeof TaskStates)[number];

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  proposed: ['active', 'dropped'],
  active: ['blocked', 'done', 'dropped'],
  blocked: ['active', 'done', 'dropped'],
  done: [],
  dropped: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface MailInput {
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  priority?: number;
  refs?: unknown[];
}

export interface MailRow {
  id: number;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  priority: number;
  subject: string;
  body: string;
  refs: string | null;
  status: string;
  created_at: string;
  delivered_at: string | null;
}

export class MailRepo {
  constructor(private db: Db) {}

  enqueue(from: string, input: MailInput): MailRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO messages (thread_id, from_agent, to_agent, type, priority,
         subject, body, refs, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(
        randomUUID(),
        from,
        input.to,
        input.type,
        input.priority ?? 5,
        input.subject,
        input.body,
        JSON.stringify(input.refs ?? []),
        now
      );
    return this.byId(Number(info.lastInsertRowid));
  }

  byId(id: number): MailRow {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MailRow | undefined;
    if (!row) throw new Error(`message ${id} not found`);
    return row;
  }

  queuedFor(agent: string): MailRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE to_agent = ? AND status = 'queued'
         ORDER BY priority ASC, created_at ASC`
      )
      .all(agent) as MailRow[];
  }

  markDelivered(ids: number[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?`
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(now, id);
    });
    tx(ids);
  }
}

export interface TaskInput {
  title: string;
  description?: string;
  owner?: string | null;
  artifactRefs?: unknown[];
}

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  state: TaskState;
  owner: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  artifact_refs: string | null;
}

export class TaskRepo {
  constructor(private db: Db) {}

  create(createdBy: string, input: TaskInput): TaskRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO tasks (title, description, state, owner, created_by,
         created_at, updated_at, artifact_refs)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`
      )
      .run(input.title, input.description ?? '', input.owner ?? null, createdBy, now, now,
           JSON.stringify(input.artifactRefs ?? []));
    return this.byId(Number(info.lastInsertRowid));
  }

  byId(id: number): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) throw new Error(`task ${id} not found`);
    return row;
  }

  list(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[];
  }

  move(actor: string, id: number, toState: TaskState, owner?: string | null): TaskRow {
    const task = this.byId(id);
    if (!canTransition(task.state, toState)) {
      throw new Error(`illegal task transition ${task.state} -> ${toState}`);
    }
    this.db
      .prepare('UPDATE tasks SET state = ?, owner = COALESCE(?, owner), updated_at = ? WHERE id = ?')
      .run(toState, owner ?? null, new Date().toISOString(), id);
    return this.byId(id);
  }
}

export interface SessionInput {
  agent: string;
  opencodeSessionId?: string;
  cycle: number;
  goal: string;
}

export interface SessionRow {
  id: number;
  agent: string;
  opencode_session_id: string;
  cycle: number;
  goal: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export class SessionRepo {
  constructor(private db: Db) {}

  start(input: SessionInput): SessionRow {
    const info = this.db
      .prepare(
        `INSERT INTO sessions (agent, opencode_session_id, cycle, goal, started_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.agent, input.opencodeSessionId ?? '', input.cycle, input.goal,
           new Date().toISOString());
    return this.byId(Number(info.lastInsertRowid));
  }

  byId(id: number): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) throw new Error(`session ${id} not found`);
    return row;
  }

  finish(id: number, status: 'done' | 'timed_out' | 'failed',
         usage: { tokensIn?: number; tokensOut?: number; cost?: number },
         summary?: string): SessionRow {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, tokens_in = ?, tokens_out = ?,
         cost = ?, summary = ? WHERE id = ?`
      )
      .run(status, new Date().toISOString(), usage.tokensIn ?? 0, usage.tokensOut ?? 0,
           usage.cost ?? 0, summary ?? null, id);
    return this.byId(id);
  }
}

export interface EventInput {
  kind: string;
  actor: string;
  payload: unknown;
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  actor: string;
  payload: string;
}

export class EventRepo {
  constructor(private db: Db) {}

  append(input: EventInput): EventRow {
    const info = this.db
      .prepare('INSERT INTO events (ts, kind, actor, payload) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), input.kind, input.actor, JSON.stringify(input.payload));
    return this.byId(Number(info.lastInsertRowid));
  }

  byId(id: number): EventRow {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    if (!row) throw new Error(`event ${id} not found`);
    return row;
  }

  all(): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id').all() as EventRow[];
  }

  byKind(kind: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind) as EventRow[];
  }
}

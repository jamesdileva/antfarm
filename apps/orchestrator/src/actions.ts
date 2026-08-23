import { z } from 'zod';
import { MessageTypes, TaskStates } from '@antfarm/db';

export const RefSchema = z.object({
  kind: z.enum(['task', 'file', 'session']),
  id: z.string(),
});

export const MailAction = z.object({
  to: z.string().min(1),
  type: z.enum(MessageTypes),
  subject: z.string().min(1).max(120),
  body: z.string().min(1),
  priority: z.number().int().min(1).max(9).optional(),
  refs: z.array(RefSchema).optional(),
});

export const TaskMoveAction = z.object({
  taskId: z.number().int().positive(),
  state: z.enum(TaskStates),
  owner: z.string().nullable().optional(),
});

export const ActionsOutput = z.object({
  mails: z.array(MailAction).default([]),
  taskMoves: z.array(TaskMoveAction).default([]),
  summary: z.string().default(''),
});

export type MailActionT = z.infer<typeof MailAction>;
export type TaskMoveActionT = z.infer<typeof TaskMoveAction>;
export type ActionsOutputT = z.infer<typeof ActionsOutput>;

export function parseActions(raw: unknown): ActionsOutputT {
  return ActionsOutput.parse(raw);
}

import { describe, expect, it } from 'vitest';
import { parseActions } from '../src/actions.js';

describe('mail type ANSWER alias', () => {
  it('accepts ANSWER and maps it to STATUS', () => {
    const out = parseActions({
      mails: [{ to: 'agent-b', type: 'ANSWER', subject: 're: verdict', body: 'here is the answer' }],
      taskMoves: [],
    });
    expect(out.mails).toHaveLength(1);
    expect(out.mails[0]!.type).toBe('STATUS');
  });

  it('still rejects genuinely unknown types', () => {
    expect(() =>
      parseActions({
        mails: [{ to: 'agent-b', type: 'SHOUTING', subject: 'x', body: 'y' }],
      })
    ).toThrow();
  });

  it('rejects prompt-bloating bodies, summaries, and owners', () => {
    expect(() =>
      parseActions({ mails: [{ to: 'a', type: 'STATUS', subject: 's', body: 'b'.repeat(8001) }] })
    ).toThrow();
    expect(() => parseActions({ summary: 's'.repeat(501) })).toThrow();
    expect(() => parseActions({ taskMoves: [{ taskId: 1, state: 'done', owner: 'x'.repeat(65) }] })).toThrow();
    // boundary values still pass
    const out = parseActions({
      mails: [{ to: 'a', type: 'STATUS', subject: 's', body: 'b'.repeat(8000) }],
      summary: 's'.repeat(500),
    });
    expect(out.mails).toHaveLength(1);
  });
});

describe('lenient taskMoves coercion', () => {
  it('accepts string taskIds ("5") without failing the cycle', () => {
    const out = parseActions({
      taskMoves: [{ taskId: '5', state: 'done' }],
    });
    expect(out.taskMoves[0]!.taskId).toBe(5);
    expect(out.taskMoves[0]!.state).toBe('done');
  });

  it('accepts mixed-case states and rejects garbage ids', () => {
    const out = parseActions({
      taskMoves: [{ taskId: ' 7 ', state: ' Active ' }],
    });
    expect(out.taskMoves[0]).toEqual({ taskId: 7, state: 'active' });
    expect(() => parseActions({ taskMoves: [{ taskId: 'abc', state: 'done' }] })).toThrow();
  });
});

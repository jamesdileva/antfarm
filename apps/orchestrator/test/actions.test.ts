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
});

/** The fork modal's "messages up to here": the stored rows a fork at that row copies. */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';

import { messagesUpTo } from '../src/read-models/fork-count';

function rows(...ids: string[]): UIMessage[] {
  return ids.map((id, index) => ({ id, role: index % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: id }] }));
}

describe('the rows a fork copies', () => {
  test('behind the loaded rows, the rows still unloaded count too', () => {
    // 100 stored, the newest 60 loaded: a fork at the 10th loaded row copies 50.
    const shown = rows(...Array.from({ length: 60 }, (_, index) => `m${String(index + 41)}`));

    expect(messagesUpTo(shown, 'm50', 100, { exhausted: false, inFlight: 0 })).toBe(50);
  });

  test('mid-turn, the sent row and the streaming answer are not stored and shift nothing', () => {
    // 100 stored, the newest 60 loaded, then the turn's two rows the store does not hold yet.
    const shown = rows(...Array.from({ length: 60 }, (_, index) => `m${String(index + 41)}`), 'sent', 'answer');

    expect(messagesUpTo(shown, 'm50', 100, { exhausted: false, inFlight: 2 })).toBe(50);
  });

  test('once the walk has reached the start, the count is the loaded rows alone, whatever the stored count says', () => {
    expect(messagesUpTo(rows('m1', 'm2', 'm3', 'sent', 'answer'), 'm2', 6, { exhausted: true, inFlight: 2 })).toBe(2);
  });
});

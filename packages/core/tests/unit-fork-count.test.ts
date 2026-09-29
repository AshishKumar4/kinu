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

    expect(messagesUpTo(shown, 'm50', 100, { positions: new Map(), inFlight: 0 })).toBe(50);
  });

  test('mid-turn, the sent row and the streaming answer are not stored and shift nothing', () => {
    // 100 stored, the newest 60 loaded, then the turn's two rows the store does not hold yet.
    const shown = rows(...Array.from({ length: 60 }, (_, index) => `m${String(index + 41)}`), 'sent', 'answer');

    expect(messagesUpTo(shown, 'm50', 100, { positions: new Map(), inFlight: 2 })).toBe(50);
  });

  test('a page at the beginning does not make the displayed sparse rows complete', () => {
    const shown = rows(...Array.from({ length: 200 }, (_, index) => 'm' + String(index)),
      ...Array.from({ length: 200 }, (_, index) => 'm' + String(index + 4800)));

    const positions = new Map([['m0', 0], ['m4900', 4900]]);

    expect(messagesUpTo(shown, 'm4900', 5000, { positions, inFlight: 0 })).toBe(4901);
  });

  test('an unpaged live row counts back from the stored tail despite an earlier gap', () => {
    const shown = rows('old', 'newer', 'target', 'last', 'sent', 'answer');
    const positions = new Map([['old', 0], ['newer', 4997]]);

    expect(messagesUpTo(shown, 'target', 5000, { positions, inFlight: 2 })).toBe(4999);
  });
});

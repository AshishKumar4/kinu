import { describe, expect, test } from 'bun:test';
import { labelSample } from './omp-labels';
import type { OwnerTurn } from './omp';

/** A trained turn: `asked`, answered `answer`, and the next message `said` a minute later. */
function turn(at: number, asked: string, answer: string, said: string | null): OwnerTurn {
  const time = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

  return {
    at: time(at),
    followup: said === null ? null : { text: said, at: time(at + 1) },
    turn: { userMessage: asked, assistantResponse: answer, toolCalls: [], steps: 1, durationMs: 1, feedback: null, hadError: false, turnId: `t${String(at)}`, origin: 'user' },
  };
}

/** Forty exchanges: every fourth reply corrects the answer, and the next turn answers that correction. */
const train = Array.from({ length: 40 }, (_, at) => {
  const said = at % 4 === 0 ? `no, do it differently ${String(at)}` : `thanks ${String(at)}`;
  const asked = at % 4 === 1 ? `no, do it differently ${String(at - 1)}` : `task ${String(at)}`;

  return turn(at, asked, `answer ${String(at)}`, said);
});

describe('the hand-labelled sample', () => {
  test('messages come first, half holding a correction word; then answers held to a correction, half drew it and half came after', () => {
    const items = labelSample(train, { messages: 10, again: 6, seed: 1 });
    const messages = items.filter((item) => item.kind === 'message');
    const again = items.filter((item) => item.kind === 'again');

    expect(items.map((item) => item.kind)).toEqual([...messages.map((item) => item.kind), ...again.map((item) => item.kind)]);
    expect(new Set(messages.map((item) => item.kind))).toEqual(new Set(['message']));
    expect(messages).toHaveLength(10);
    expect(messages.filter((item) => item.said.startsWith('no,'))).toHaveLength(5);
    expect(again).toHaveLength(6);
    expect(again.every((item) => item.said.startsWith('no,'))).toBe(true);
    expect(again.filter((item) => item.id.startsWith('again:after:'))).toHaveLength(3);

    // An answer given after a correction is the next turn's, not the one that drew it.
    for (const item of again.filter((held) => held.id.startsWith('again:after:'))) expect(item.answer).not.toBe(`answer ${item.id.split(':t')[1] ?? ''}`);
  });
});

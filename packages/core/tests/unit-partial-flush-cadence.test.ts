/** The one flush cadence the stream buffer and the wire replay store use to make a partial answer durable. */
import { expect, test } from 'bun:test';
import type { TextStreamPart, ToolSet, UIMessageChunk } from 'ai';
import { flushSignal, partialFlushCadence, type PartialFlushSignal } from '@kinu.run/core';

function decisions(signals: readonly PartialFlushSignal[], cadence = partialFlushCadence()): boolean[] {
  return signals.map((signal) => cadence.flushes(signal));
}

/** The cadence's period, measured rather than restated, so the number lives in one place. */
const PERIOD = decisions(Array<PartialFlushSignal>(100).fill('content')).indexOf(true, 1);

test('the first content chunk flushes, then every period of content chunks', () => {
  expect(PERIOD).toBeGreaterThan(1);
  const content = Array<PartialFlushSignal>(PERIOD * 2 + 1).fill('content');
  const flushed = decisions(content).flatMap((flushes, index) => flushes ? [index] : []);

  expect(flushed).toEqual([0, PERIOD, PERIOD * 2]);
});

test('a settled tool result flushes at once and starts the count over', () => {
  const cadence = partialFlushCadence();

  expect(decisions(['content', 'content', 'settled'], cadence)).toEqual([true, false, true]);
  // The count restarts at the settle: the next flush is a full cadence away.
  const after = decisions(Array<PartialFlushSignal>(PERIOD).fill('content'), cadence);
  expect(after.slice(0, -1).some(Boolean)).toBe(false);
  expect(after.at(-1)).toBe(true);
});

test('a chunk the cadence does not count neither flushes nor advances it', () => {
  const cadence = partialFlushCadence();
  expect(cadence.flushes('none')).toBe(false);
  expect(decisions(['content', 'none', 'none', 'none'], cadence)).toEqual([true, false, false, false]);
  // Three uncounted chunks brought the next flush no closer.
  const rest = decisions(Array<PartialFlushSignal>(PERIOD).fill('content'), cadence);
  expect(rest.indexOf(true)).toBe(PERIOD - 1);
});

test('a step boundary makes the next content chunk flush again', () => {
  const cadence = partialFlushCadence();

  expect(decisions(['content', 'content'], cadence)).toEqual([true, false]);
  cadence.reset();
  expect(cadence.flushes('content')).toBe(true);
});

test('a settle with nothing before it still flushes', () => {
  expect(decisions(['settled'])).toEqual([true]);
});

// 2026-09-28 (turn-sql, one buffer): the stream buffer weighs model parts, a tab's replay store weighs the UI chunks
// the SDK made of them. Weighed alike, the two flush at the same stream positions.
test('every model stream part weighs what the UI chunk made of it weighs', () => {
  const pairs: readonly (readonly [TextStreamPart<ToolSet>, UIMessageChunk, PartialFlushSignal])[] = [
    [{ type: 'text-delta', id: 't', text: 'a' }, { type: 'text-delta', id: 't', delta: 'a' }, 'content'],
    [{ type: 'reasoning-delta', id: 'r', text: 'a' }, { type: 'reasoning-delta', id: 'r', delta: 'a' }, 'content'],
    [{ type: 'tool-call', toolCallId: 'c', toolName: 'file', input: {} }, { type: 'tool-input-available', toolCallId: 'c', toolName: 'file', input: {} }, 'content'],
    [{ type: 'tool-result', toolCallId: 'c', toolName: 'file', input: {}, output: 'ok' }, { type: 'tool-output-available', toolCallId: 'c', output: 'ok' }, 'settled'],
    [{ type: 'tool-error', toolCallId: 'c', toolName: 'file', input: {}, error: 'no' }, { type: 'tool-output-error', toolCallId: 'c', errorText: 'no' }, 'settled'],
    [{ type: 'tool-output-denied', toolCallId: 'c', toolName: 'file' }, { type: 'tool-output-denied', toolCallId: 'c' }, 'settled'],
    [{ type: 'text-start', id: 't' }, { type: 'text-start', id: 't' }, 'none'],
    [{ type: 'text-end', id: 't' }, { type: 'text-end', id: 't' }, 'none'],
    [{ type: 'start-step', request: {}, warnings: [] }, { type: 'start-step' }, 'none'],
  ];

  for (const [part, chunk, weight] of pairs) expect([part.type, flushSignal(part), flushSignal(chunk)]).toEqual([part.type, weight, weight]);
});

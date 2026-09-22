/** The one flush cadence the step ledger and the wire replay store use to make a partial answer durable. */
import { expect, test } from 'bun:test';
import { partialFlushCadence, type PartialFlushSignal } from '@kinu.run/core';

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

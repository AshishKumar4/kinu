// The subject is handed a clock and a timer setting; the test advances it.
import { expect, test } from 'bun:test';

interface Subject { readonly stale: (at: number) => boolean }

declare function build(options: { readonly now: () => number; readonly timeoutMs: number }): Subject;

test('a value ages on the clock it was handed', () => {
  let at = Date.now();
  const subject = build({ now: () => at, timeoutMs: 40 });
  at += 41;
  expect(subject.stale(at)).toBe(true);
});

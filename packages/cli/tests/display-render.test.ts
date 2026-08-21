// The classic loop's render seam, as a person reads it.
//
// The regression these tests pin: a tool refusal reached the terminal as the
// raw `{reason,error}` JSON the model reads, and a cut line lost its tail
// silently. Both are renderer contracts — asserted through printToolResult,
// the one function every classic-surface tool result funnels through.
import { printToolResult, createTurnStatus } from '../src/display';
import { describe, expect, test, vi, afterEach } from 'bun:test';

afterEach(() => {
  vi.useRealTimers();
});

/** Console output while `run` executes, in call order. */
function captureConsole(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

const REFUSAL = JSON.stringify({ reason: 'unavailable', error: 'No device connected.' });

describe('printToolResult', () => {
  test('a refusal renders as prose under a ✗, never as raw JSON', () => {
    const lines = captureConsole(() => printToolResult(REFUSAL));
    const text = lines.join('\n');
    expect(text).toContain('✗');
    expect(text).toContain('No device connected.');
    expect(text).toContain('(unavailable)');
    expect(text).not.toContain('{"reason"');
  });

  test('a multi-line refusal keeps its continuation lines', () => {
    const lines = captureConsole(() =>
      printToolResult(JSON.stringify({ reason: 'io', error: 'first\nsecond' })));
    const text = lines.join('\n');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  test('a long result line is cut with an ellipsis that says so', () => {
    const lines = captureConsole(() => printToolResult('x'.repeat(200)));
    const text = lines.join('\n');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(200);
  });

  test('a result longer than five lines reports the withheld count', () => {
    const lines = captureConsole(() => printToolResult(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')));
    const text = lines.join('\n');
    expect(text).toContain('(2 more lines)');
    expect(text).toContain('…');
  });
});


describe('createTurnStatus', () => {
  /** Terminal writes while `run` executes, in call order. */
  function captureWrites(run: () => void): string[] {
    const writes: string[] = [];
    const original = process.stdout.write;
    /* SAFETY: Bun's stdout `write` overloads are all
       `(chunk: string | Uint8Array, encoding?, cb?) => boolean` with the last
       two parameters optional, so a function fixing only `chunk` satisfies the
       overload the runtime resolves; this module's draws call it with exactly
       one argument. `finally` restores the original before the test returns. */
    process.stdout.write = function typedWrite(chunk: Uint8Array | string): boolean {
      writes.push(String(chunk));
      return true;
    } as typeof process.stdout.write;
    try {
      run();
    } finally {
      process.stdout.write = original;
    }
    return writes;
  }

  test('a shown label draws on the row and clear releases it', () => {
    vi.useFakeTimers();
    const status = createTurnStatus({ tty: true });
    const drawn = captureWrites(() => {
      status.show('calling run');
      vi.advanceTimersByTime(240);
    });
    const released = captureWrites(() => status.clear());
    expect(drawn.join('')).toContain('calling run');
    expect(released.join('')).toContain('\r');
  });

  test('hold surrenders the row — no redraws while input or a question owns it', () => {
    vi.useFakeTimers();
    let held = true;
    const status = createTurnStatus({ tty: true, hold: () => held });
    captureWrites(() => {
      status.show('thinking');
      vi.advanceTimersByTime(240);
    });
    const whileHeld = captureWrites(() => vi.advanceTimersByTime(240));
    held = false;
    const afterRelease = captureWrites(() => vi.advanceTimersByTime(240));
    captureWrites(() => status.clear());
    expect(whileHeld.join('')).toBe('');
    expect(afterRelease.join('')).toContain('thinking');
  });

  test('resume redraws the last label after a consent question gave the row back', () => {
    vi.useFakeTimers();
    const status = createTurnStatus({ tty: true });
    const shown = captureWrites(() => status.show('thinking'));
    const released = captureWrites(() => status.clear());
    const resumed = captureWrites(() => status.resume());
    expect(shown.join('')).toContain('thinking');
    expect(released.join('')).toContain('\r');
    expect(resumed.join('')).toContain('thinking');
    captureWrites(() => status.clear());
  });
});
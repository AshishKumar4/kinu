// Tool results through printToolResult: a refusal renders as prose, and a cut line says so.
import { printToolResult, createTurnStatus } from '../src/display';
import { describe, expect, test, vi, afterEach } from 'bun:test';

afterEach(() => {
  vi.useRealTimers();
});

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


describe('printToolResult', () => {
  test('a recorded failure renders its message and class', () => {
    const lines = captureConsole(() => printToolResult('No device connected.', { success: false, reason: 'unavailable' }));
    const text = lines.join('\n');
    expect(text).toContain('failed');
    expect(text).toContain('No device connected.');
    expect(text).toContain('(unavailable)');
    expect(text).not.toContain('{"reason"');
  });

  test('a multi-line refusal keeps its continuation lines', () => {
    const lines = captureConsole(() =>
      printToolResult('first\nsecond', { success: false, reason: 'io' }));

    const text = lines.join('\n');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  test('a long result line is cut with an ellipsis that says so', () => {
    const lines = captureConsole(() => printToolResult('x'.repeat(200), { success: true }));
    const text = lines.join('\n');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(200);
  });

  test('a result longer than five lines reports the withheld count', () => {
    const lines = captureConsole(() => printToolResult(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'), { success: true }));
    const text = lines.join('\n');
    expect(text).toContain('(2 more lines)');
    expect(text).toContain('…');
  });
  test('successful refusal-shaped output is rendered as data', () => {
    const content = '{"reason":"denied","error":"historical incident"}';
    const text = captureConsole(() => printToolResult(content, { success: true })).join('\n');
    expect(text).toContain(content);
    expect(text).not.toContain('failed');
  });
});


describe('createTurnStatus', () => {
  function captureWrites(run: () => void): string[] {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    /* SAFETY: every Bun stdout `write` overload accepts a lone `chunk`; `finally` restores the original. */
    process.stdout.write = function typedWrite(chunk: Uint8Array | string): boolean {
      writes.push(String(chunk));

      return true;
    };

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
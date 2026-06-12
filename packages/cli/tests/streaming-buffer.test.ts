import { describe, expect, test } from 'bun:test';
import { createStreamingBufferController } from '../src/tui/streaming-buffer.js';

describe('TUI streaming buffer', () => {
  test('coalesces token deltas before flushing to React state', () => {
    const updates: Array<string | null> = [];
    let scheduled: (() => void) | null = null;
    const buffer = createStreamingBufferController(
      (value) => updates.push(value),
      50,
      {
        setTimeout(callback) {
          scheduled = callback as () => void;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout() {
          scheduled = null;
        },
      },
    );

    buffer.start();
    buffer.append('hel');
    buffer.append('lo');

    expect(updates).toEqual([null]);
    expect(scheduled).not.toBeNull();
    scheduled?.();
    expect(updates).toEqual([null, 'hello']);

    buffer.append(' world');
    buffer.finish('hello world');
    expect(updates).toEqual([null, 'hello', 'hello world']);

    buffer.clear();
    expect(updates).toEqual([null, 'hello', 'hello world', null]);
  });
});

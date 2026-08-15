import { describe, expect, test } from 'bun:test';
import { createStreamingBufferController } from '../src/tui/streaming-buffer.js';

describe('TUI streaming buffer', () => {
  test('coalesces token deltas before flushing to React state', () => {
    const updates: Array<string | null> = [];
    const scheduled: Array<() => void> = [];
    const timerHandle = setTimeout(() => {}, 0);
    clearTimeout(timerHandle);
    const buffer = createStreamingBufferController(
      (value) => updates.push(value),
      50,
      {
        setTimeout(callback) {
          scheduled.push(callback);
          return timerHandle;
        },
        clearTimeout() {
          scheduled.length = 0;
        },
      },
    );

    buffer.start();
    buffer.append('hel');
    buffer.append('lo');

    expect(updates).toEqual([null]);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(updates).toEqual([null, 'hello']);

    buffer.append(' world');
    buffer.finish('hello world');
    expect(updates).toEqual([null, 'hello', 'hello world']);

    buffer.clear();
    expect(updates).toEqual([null, 'hello', 'hello world', null]);
  });
});

/**
 * Reverting a turn says what happens to device files, and a device store that cannot answer is never
 * reported as a turn that changed nothing (m268: "No file checkpoint for this turn. It changed no device
 * files" was said of a turn whose history was simply unreadable).
 */
import { describe, expect, test } from 'bun:test';
import {
  CHECKPOINTS_NO_DEVICE, CHECKPOINTS_UNAVAILABLE_NO_GIT, deviceHistoryNote, type FileCheckpointEntry,
} from '@kinu.run/core';

const CHECKPOINT: FileCheckpointEntry = {
  id: 'c0ffee1', dir: '/home/ashish/shop', at: 0, turnId: 'turn-1', sessionId: 's', reason: 'writeFile',
};

describe('the revert dialog names the device-file result it got', () => {
  test('an unanswerable store and an unchanged turn read as two different results', () => {
    const unavailable = deviceHistoryNote({ availability: { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT }, entries: [] });
    const unchanged = deviceHistoryNote({ availability: { available: true }, entries: [] });

    expect(unavailable).toContain('keeps no file history for this turn');
    expect(unavailable).toContain(CHECKPOINTS_UNAVAILABLE_NO_GIT);
    expect(unavailable).not.toContain('changed no files');
    expect(unchanged).toContain('changed no files on your devices');
    expect(unchanged).not.toContain('file history');
  });

  test('no device at all adds no line, and a turn with a checkpoint leaves the choice to its action', () => {
    expect(deviceHistoryNote({ availability: { available: false, reason: CHECKPOINTS_NO_DEVICE }, entries: [] })).toBeNull();
    expect(deviceHistoryNote({ availability: { available: true }, entries: [CHECKPOINT] })).toBeNull();
  });
});

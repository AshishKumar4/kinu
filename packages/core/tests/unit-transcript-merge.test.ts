/** Merging the live agents-SDK list with the cursored storage walk: no duplicates, and the live copy wins. */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { mergeTranscript, type ChatHistoryEntry } from '../src/index';

const stored = (id: string, content = id): ChatHistoryEntry =>
  ({ id, role: 'assistant', content, createdAt: '2026-01-01 00:00:00' });

/** Carries `metadata`, which the flattened stored copy lacks; its survival shows which copy won. */
function liveMessage(id: string): UIMessage {
  return {
    id, role: 'assistant',
    parts: [{ type: 'text', text: id }],
    metadata: { kinuSignal: `${id}-signal` },
  };
}

describe('transcript merge', () => {
  test('older pages sit above the live list, oldest first', () => {
    const merged = mergeTranscript([stored('m1'), stored('m2')], [liveMessage('m3')]);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('a message that arrived BOTH ways renders once, as the live copy', () => {
    // A reconnect can re-seed a wider window, so one id legitimately appears in both halves.
    const merged = mergeTranscript([stored('m1'), stored('m2')], [liveMessage('m2'), liveMessage('m3')]);

    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged.find((m) => m.id === 'm2')?.metadata).toEqual({ kinuSignal: 'm2-signal' });
  });

  test('a page that re-delivered a row does not render it twice', () => {
    // React drops a duplicate key silently, hiding the bug as a missing message.
    const merged = mergeTranscript([stored('m1'), stored('m1'), stored('m2')], []);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('no older pages yet leaves the live list exactly as it is', () => {
    const live = [liveMessage('m1'), liveMessage('m2')];
    expect(mergeTranscript([], live)).toEqual(live);
  });

  test('a stored message becomes a text part the renderer can read', () => {
    const [restored] = mergeTranscript([stored('m1', 'hello there')], []);
    expect(restored).toEqual({
      id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello there' }],
    });
  });

  test('a walked-back programmatic row keeps the markers its card is drawn from', () => {
    const [restored] = mergeTranscript([{
      id: 'f8798675', role: 'system', content: '9 head(s) across 1 fork run(s)…',
      createdAt: '2026-01-01 00:00:00',
      metadata: { kinuEvent: 'fork_interrupted', heads: 9 },
    }], []);

    expect(restored?.role).toBe('system');
    expect(restored?.metadata).toEqual({ kinuEvent: 'fork_interrupted', heads: 9 });
  });

  test('a row that carried no metadata restores without inventing any', () => {
    const [restored] = mergeTranscript([stored('m1')], []);
    expect(restored).not.toHaveProperty('metadata');
  });
});

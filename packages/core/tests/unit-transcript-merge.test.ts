/**
 * The seam between the two ways a chat message reaches the pane: the agents
 * SDK's live list (its `get-messages` seed plus the socket) and the cursored
 * walk back through storage.
 *
 * These are the cases that decide whether a paginated seed can coexist with a
 * live socket. Getting any of them wrong shows up as a message rendered twice,
 * or as a message that arrived live being replaced by its flattened stored
 * copy — losing its tool calls and attachments.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { mergeTranscript, type ChatHistoryEntry } from '../src/index';

const stored = (id: string, content = id): ChatHistoryEntry =>
  ({ id, role: 'assistant', content, createdAt: '2026-01-01 00:00:00' });

/** A live message carrying what the flattened stored copy cannot: `metadata`,
 *  which is what MessageView reads to classify a programmatic turn. Its
 *  survival is how these tests know which copy won. */
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
    // The overlap the ticket is about: the walk's anchor is minted from a list
    // the socket keeps extending, and a reconnect can re-seed a wider window,
    // so the same id legitimately shows up in both halves.
    const merged = mergeTranscript([stored('m1'), stored('m2')], [liveMessage('m2'), liveMessage('m3')]);

    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // The live copy won: the restored copy carries no metadata at all, so a
    // programmatic turn would have lost its card and rendered as a user bubble.
    expect(merged.find((m) => m.id === 'm2')?.metadata).toEqual({ kinuSignal: 'm2-signal' });
  });

  test('a page that re-delivered a row does not render it twice', () => {
    // React would resolve a duplicate key by dropping one silently, so a
    // pagination bug upstream would look like a message going missing rather
    // than like a duplicate.
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
    // The production shape: `fork_interrupted` rows in sunlit-stone-4a20 and
    // stone-ash-71f2. Live they arrive over the socket with their metadata and
    // draw an event card. Walked back they arrived stripped, so the same row
    // the operator had just been reading as a card turned into a bare bubble
    // the moment it scrolled out of the hydration window.
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

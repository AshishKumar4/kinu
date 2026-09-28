/** A stored row restored for the renderer: its text as a part, its metadata kept and never invented. */
import { describe, expect, test } from 'bun:test';
import { restoredRows, type ChatHistoryEntry } from '../src/index';

const stored = (id: string, content = id): ChatHistoryEntry =>
  ({ id, position: 0, role: 'assistant', content, createdAt: '2026-01-01 00:00:00' });

describe('restored rows', () => {
  test('a stored message becomes a text part the renderer can read', () => {
    const [restored] = restoredRows([stored('m1', 'hello there')]);
    expect(restored).toEqual({
      id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello there' }],
    });
  });

  test('a walked-back programmatic row keeps the markers its card is drawn from', () => {
    const [restored] = restoredRows([{
      id: 'f8798675', position: 0, role: 'system', content: '9 head(s) across 1 fork run(s)…',
      createdAt: '2026-01-01 00:00:00',
      metadata: { kinuEvent: 'fork_interrupted', heads: 9 },
    }]);

    expect(restored?.role).toBe('system');
    expect(restored?.metadata).toEqual({ kinuEvent: 'fork_interrupted', heads: 9 });
  });

  test('a row that carried no metadata restores without inventing any', () => {
    const [restored] = restoredRows([stored('m1')]);
    expect(restored).not.toHaveProperty('metadata');
  });
});

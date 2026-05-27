/**
 * Unit tests for context compaction.
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldCompact,
  estimateTokens,
  compactMessages,
  DEFAULT_COMPACTION_CONFIG,
  type CompactableMessage,
} from '../src/index.js';

const mk = (role: CompactableMessage['role'], content: string): CompactableMessage => ({ role, content });

describe('shouldCompact', () => {
  test('false when disabled', () => {
    expect(shouldCompact(1_000_000, 8_000, { enabled: false })).toBe(false);
  });
  test('false for unknown context window', () => {
    expect(shouldCompact(100_000, 0)).toBe(false);
  });
  test('true when tokens exceed window - reserveTokens', () => {
    // window=100k, reserve=20k → threshold=80k. 81k triggers.
    expect(shouldCompact(81_000, 100_000)).toBe(true);
  });
  test('false when tokens are below threshold', () => {
    expect(shouldCompact(50_000, 100_000)).toBe(false);
  });
  test('respects custom reserveTokens — larger reserve triggers compaction sooner', () => {
    // Threshold = contextWindow - reserveTokens.
    // reserveTokens=10000 → threshold=90k → 95k > 90k → trigger
    // reserveTokens=4000  → threshold=96k → 95k < 96k → no trigger
    expect(shouldCompact(95_000, 100_000, { reserveTokens: 10_000 })).toBe(true);
    expect(shouldCompact(95_000, 100_000, { reserveTokens: 4_000 })).toBe(false);
  });
});

describe('estimateTokens', () => {
  test('returns 0 for empty', () => {
    expect(estimateTokens([])).toBe(0);
  });
  test('approximates chars/4 by default', () => {
    const msgs = [mk('user', 'a'.repeat(40))];
    expect(estimateTokens(msgs)).toBe(10);
  });
  test('honors charsPerToken override', () => {
    const msgs = [mk('user', 'a'.repeat(40))];
    expect(estimateTokens(msgs, { charsPerToken: 8 })).toBe(5);
  });
});

describe('compactMessages', () => {
  test('returns input unchanged when nothing to summarize (head+tail covers all)', async () => {
    const messages = [
      mk('system', 'sys'),
      mk('user', 'hello'),
      mk('assistant', 'hi'),
    ];
    const r = await compactMessages(messages, async () => 'never called', { keepFirstMessages: 3, keepRecentTokens: 8_000 });
    expect(r.droppedCount).toBe(0);
    expect(r.summary).toBe('');
    expect(r.messages.length).toBe(3);
  });

  test('summarizes the middle when there is one', async () => {
    // Make middle messages large enough that they wouldn't fit in keepRecentTokens.
    // 200-char message = 50 tokens (chars/4). Keep recent budget = 20 tokens → tail
    // gets just one or two messages.
    const messages: CompactableMessage[] = [
      mk('system', 'system prompt here'),               // head 0
      mk('user', 'initial question'),                    // head 1
      mk('assistant', 'first answer'),                   // head 2 — keepFirstMessages=3
      mk('user', 'a'.repeat(200)),                       // MIDDLE
      mk('assistant', 'b'.repeat(200)),                  // MIDDLE
      mk('user', 'c'.repeat(200)),                       // MIDDLE
      mk('assistant', 'd'.repeat(200)),                  // MIDDLE
      mk('user', 'recent q'),                            // tail (8 chars = 2 tokens, fits)
      mk('assistant', 'recent a'),                       // tail (8 chars = 2 tokens, fits)
    ];

    let summarizedSeen: CompactableMessage[] = [];
    const r = await compactMessages(messages, async (msgs) => {
      summarizedSeen = [...msgs];
      return 'summary of middle';
    }, { keepFirstMessages: 3, keepRecentTokens: 20 });

    expect(r.droppedCount).toBe(4);
    expect(r.summary).toBe('summary of middle');
    expect(r.messages.length).toBe(3 + 1 + 2); // head + summary + tail
    expect(r.messages[0].content).toBe('system prompt here');
    expect(r.messages[3].content).toContain('summary of middle');
    expect(r.messages[3].role).toBe('assistant');
    expect(r.messages[4].content).toBe('recent q');
    expect(r.messages[5].content).toBe('recent a');
    expect(summarizedSeen.length).toBe(4);
  });

  test('handles empty messages array', async () => {
    const r = await compactMessages([], async () => 'nope');
    expect(r.messages.length).toBe(0);
    expect(r.summary).toBe('');
    expect(r.droppedCount).toBe(0);
  });

  test('summary message has role assistant + summary marker', async () => {
    // 20 messages × ~110 chars = ~27.5 tokens each. With keepRecentTokens=100,
    // tail = 3-4 messages. Middle = ~15 messages → triggers compaction.
    const messages: CompactableMessage[] = Array.from({ length: 20 }, (_, i) =>
      mk(i % 2 === 0 ? 'user' : 'assistant', `message ${i} ${'a'.repeat(100)}`),
    );
    const r = await compactMessages(messages, async () => 'OK', { keepFirstMessages: 2, keepRecentTokens: 100 });
    const summaryMsg = r.messages.find((m) => m.content.includes('[compaction summary'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe('assistant');
    expect(r.droppedCount).toBeGreaterThan(0);
  });

  test('config defaults merge correctly', async () => {
    const messages: CompactableMessage[] = Array.from({ length: 30 }, (_, i) =>
      mk('user', `m${i}`),
    );
    const r = await compactMessages(messages, async () => 'sum');
    expect(r.messages[0].content).toBe('m0');
    expect(r.messages[1].content).toBe('m1');
    expect(r.messages[2].content).toBe('m2');
    // keepRecentTokens=8000 default = lots → tail will be most of the messages
    expect(r.messages.length).toBeLessThanOrEqual(messages.length);
  });
});

describe('default config', () => {
  test('matches Hermes/Flue defaults', () => {
    expect(DEFAULT_COMPACTION_CONFIG.enabled).toBe(true);
    expect(DEFAULT_COMPACTION_CONFIG.reserveTokens).toBe(20_000);
    expect(DEFAULT_COMPACTION_CONFIG.keepRecentTokens).toBe(8_000);
  });
});

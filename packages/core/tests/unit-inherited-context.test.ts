/**
 * Unit tests: whole-message branch context inheritance (THINKING-AUDIT §4 #10).
 *
 * The fix replaces the char-slice (`.slice(-2000)` / `.slice(-800)`) that severed
 * the oldest surviving message mid-word with a last-N WHOLE-message builder.
 */

import { describe, test, expect } from 'bun:test';
import {
  formatInheritedContext,
  DEFAULT_INHERITED_MESSAGES,
} from '../src/mcts/inherited-context';

describe('formatInheritedContext', () => {
  test('empty history yields an empty block', () => {
    expect(formatInheritedContext([])).toBe('');
  });

  test('every inherited message is whole — no mid-word truncation', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i}-${'word '.repeat(40).trim()}`,
    }));
    const out = formatInheritedContext(history);
    // Each original message content appears verbatim — none was cut.
    for (const m of history) {
      expect(out).toContain(m.content);
    }
  });

  test('bounds to the last-N whole messages, dropping the oldest entirely', () => {
    const history = Array.from({ length: DEFAULT_INHERITED_MESSAGES + 4 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const out = formatInheritedContext(history);
    const lines = out.split('\n');
    expect(lines.length).toBe(DEFAULT_INHERITED_MESSAGES);
    // The oldest 4 are dropped as whole units, not clipped to fragments.
    expect(out).not.toContain('user: m0');
    expect(out).not.toContain('user: m3');
    expect(out).toContain('user: m4');
    expect(out).toContain(`user: m${DEFAULT_INHERITED_MESSAGES + 3}`);
  });

  test('a kept message survives intact even if it is very long', () => {
    const long = 'X'.repeat(10_000);
    const out = formatInheritedContext([{ role: 'user', content: long }]);
    // The old char-slice would have dropped the leading characters; the
    // message-level builder keeps the whole thing.
    expect(out).toBe(`user: ${long}`);
  });

  test('respects an explicit lastN bound', () => {
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    expect(formatInheritedContext(history, 2)).toBe('assistant: b\nuser: c');
  });
});

describe('formatInheritedContext total character budget', () => {
  test('a long window is bounded and names what it dropped', () => {
    const history = Array.from({ length: DEFAULT_INHERITED_MESSAGES }, (_, i) => ({
      role: 'user',
      content: `message-${i}-` + 'word '.repeat(2000).trim(),
    }));
    const unbounded = history.map((m) => `user: ${m.content}`).join('\n').length;
    const out = formatInheritedContext(history);
    expect(out.length).toBeLessThan(unbounded);
    expect(out).toContain('omitted');
  });

  test('an explicit character budget is honored', () => {
    const history = [
      { role: 'user', content: 'a'.repeat(500) },
      { role: 'assistant', content: 'b'.repeat(500) },
    ];
    const out = formatInheritedContext(history, 12, 100);
    expect(out.length).toBeLessThan(1100);
    expect(out).toContain('omitted');
  });
});

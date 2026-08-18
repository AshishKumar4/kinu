// Walk-back fork-point resolution: candidates from a rendered message list and
// pivot lookup in a canonical store, robust to duplicate texts and extra rows
// (programmatic turns) that surfaces don't render as user messages.
import { describe, expect, test } from 'bun:test';
import { findForkPivot, forkCandidates } from '../src/agent-client';

describe('forkCandidates', () => {
  test('lists user messages newest first with per-text occurrence indices', () => {
    const candidates = forkCandidates([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'done part one' },
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'fixed' },
      { role: 'user', content: 'continue' },
    ]);
    expect(candidates).toEqual([
      { text: 'continue', occurrenceFromEnd: 1 },
      { text: 'fix the tests', occurrenceFromEnd: 1 },
      { text: 'continue', occurrenceFromEnd: 2 },
    ]);
  });

  test('skips non-user and blank messages and honors the limit', () => {
    const candidates = forkCandidates([
      { role: 'system', content: 'welcome' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'real input' },
      { role: 'tool_call', content: 'run' },
    ], 1);
    expect(candidates).toEqual([{ text: 'real input', occurrenceFromEnd: 1 }]);
  });
});

describe('findForkPivot', () => {
  const rows = [
    { role: 'user', content: 'continue' },        // 0
    { role: 'assistant', content: 'a' },           // 1
    { role: 'user', content: 'reactor wake' },     // 2 (programmatic row the TUI never rendered)
    { role: 'assistant', content: 'b' },           // 3
    { role: 'user', content: 'continue' },         // 4
    { role: 'assistant', content: 'c' },           // 5
  ];

  test('resolves duplicates by occurrence from the end, ignoring unrendered rows', () => {
    expect(findForkPivot(rows, { text: 'continue', occurrenceFromEnd: 1 })).toBe(4);
    expect(findForkPivot(rows, { text: 'continue', occurrenceFromEnd: 2 })).toBe(0);
    expect(findForkPivot(rows, { text: '  continue  ', occurrenceFromEnd: 1 })).toBe(4);
  });

  test('returns -1 when the point cannot be located', () => {
    expect(findForkPivot(rows, { text: 'continue', occurrenceFromEnd: 3 })).toBe(-1);
    expect(findForkPivot(rows, { text: 'never said', occurrenceFromEnd: 1 })).toBe(-1);
    expect(findForkPivot([], { text: 'continue', occurrenceFromEnd: 1 })).toBe(-1);
  });
});

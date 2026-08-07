/** The archive manifest: how a compaction's archived range is derived into a
 *  non-overlapping index entry, how that index renders, and where the rendered
 *  section attaches in the ladder's transformed stream. */

import { describe, expect, test } from 'bun:test';
import { rangeHash, type Turn } from '@better-compact/core';
import {
  deriveArchiveRange,
  renderArchiveManifest,
  withArchiveManifest,
  type ArchiveRange,
} from '../src/index.js';

function turn(key: string, role: 'user' | 'assistant', text: string): Turn {
  return {
    key,
    stamp: 0,
    role,
    items: [{ kind: 'text', key: `${key}#0`, text, handle: {} }],
    handle: [{ role, content: text }],
  };
}

/** Six turns alternating user/assistant — the shape a prefix compacts from. */
function prefix(count: number): Turn[] {
  return Array.from({ length: count }, (_, i) =>
    turn(`t${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`));
}

function range(overrides: Partial<ArchiveRange> = {}): ArchiveRange {
  return {
    rangeHash: 'h0',
    path: '/local/.proteus/compaction/S/h0.md',
    startTurn: 1,
    endTurn: 4,
    userTurns: 2,
    assistantTurns: 2,
    firstUserAsk: 'message 0',
    ...overrides,
  };
}

describe('deriveArchiveRange', () => {
  test('the first archive indexes the whole prefix from turn 1', () => {
    const derived = deriveArchiveRange(prefix(6), 'h1', '/archive/h1.md', []);
    expect(derived).toEqual({
      reset: false,
      range: {
        rangeHash: 'h1',
        path: '/archive/h1.md',
        startTurn: 1,
        endTurn: 6,
        userTurns: 3,
        assistantTurns: 3,
        firstUserAsk: 'message 0',
      },
    });
  });

  test('a grown prefix indexes only what it added, continuing the ordinals', () => {
    const first = deriveArchiveRange(prefix(4), rangeHash(prefix(4)), '/archive/h1.md', [])!.range;
    const second = deriveArchiveRange(prefix(9), 'h2', '/archive/h2.md', [first])!;
    expect(second.reset).toBe(false);
    expect(second.range).toMatchObject({
      startTurn: 5,
      endTurn: 9,
      userTurns: 3,
      assistantTurns: 2,
      // The delta's own first user ask, not the conversation's.
      firstUserAsk: 'message 4',
      path: '/archive/h2.md',
    });
  });

  test('re-planning the same prefix adds nothing', () => {
    const hash = rangeHash(prefix(6));
    const first = deriveArchiveRange(prefix(6), hash, '/archive/h1.md', [])!.range;
    expect(deriveArchiveRange(prefix(6), hash, '/archive/h1.md', [first])).toBeNull();
  });

  test('a prefix that does not re-hash to the indexed one is a rewritten history', () => {
    const stale = range({ rangeHash: 'not-this-prefix' });
    const derived = deriveArchiveRange(prefix(6), 'h9', '/archive/h9.md', [stale])!;
    expect(derived.reset).toBe(true);
    expect(derived.range).toMatchObject({ startTurn: 1, endTurn: 6 });
  });

  test('an equally long but edited prefix resets rather than silently continuing', () => {
    const edited = prefix(6);
    edited[0] = turn('rewritten', 'user', 'a different first ask');
    const indexed = range({ rangeHash: rangeHash(prefix(4).slice(0, 4)), endTurn: 4 });
    const derived = deriveArchiveRange(edited, 'h9', '/archive/h9.md', [indexed])!;
    expect(derived.reset).toBe(true);
    expect(derived.range).toMatchObject({ startTurn: 1, endTurn: 6, firstUserAsk: 'a different first ask' });
  });

  test('an empty prefix indexes nothing', () => {
    expect(deriveArchiveRange([], 'h1', '/archive/h1.md', [])).toBeNull();
  });

  test('a long user ask is bounded to one line', () => {
    const long = turn('t0', 'user', `first\nline ${'detail '.repeat(60)}`);
    const derived = deriveArchiveRange([long], 'h1', '/archive/h1.md', [])!;
    expect(derived.range.firstUserAsk).toHaveLength(120);
    expect(derived.range.firstUserAsk).toEndWith('…');
    expect(derived.range.firstUserAsk).not.toInclude('\n');
  });
});

describe('renderArchiveManifest', () => {
  test('an empty index renders nothing', () => {
    expect(renderArchiveManifest([])).toBe('');
  });

  test('every range renders as one line with span, role mix, ask and path', () => {
    const rendered = renderArchiveManifest([
      range(),
      range({ rangeHash: 'h1', path: '/a/h1.md', startTurn: 5, endTurn: 5, userTurns: 1, assistantTurns: 0, firstUserAsk: '' }),
    ]);
    expect(rendered).toStartWith('## Compaction Archive\n');
    expect(rendered).toInclude('- turns 1-4 (2 user / 2 assistant) — "message 0" — /local/.proteus/compaction/S/h0.md');
    expect(rendered).toInclude('- turn 5 (1 user / 0 assistant) — (no user ask) — /a/h1.md');
  });

  test('a long index keeps the newest ranges and says how many it elided', () => {
    const ranges = Array.from({ length: 30 }, (_, i) =>
      range({ rangeHash: `h${i}`, path: `/a/h${i}.md`, startTurn: i + 1, endTurn: i + 1 }));
    const rendered = renderArchiveManifest(ranges);
    expect(rendered).toInclude('(6 earlier ranges elided');
    expect(rendered).not.toInclude('/a/h5.md');
    expect(rendered).toInclude('/a/h6.md');
    expect(rendered).toInclude('/a/h29.md');
  });
});

describe('withArchiveManifest', () => {
  const compacted: Turn[] = [
    { key: 'better_compact_summary_h1', stamp: 0, role: 'user', items: [{ kind: 'synthetic', key: 's', text: '[Context Summary]' }] },
    turn('t9', 'user', 'raw tail'),
  ];

  test('the manifest joins the ladder-synthesized turn, never a native one', () => {
    const [summary, tail] = withArchiveManifest(compacted, '## Compaction Archive\n- turn 1');
    expect(summary.items.map((item) => item.kind === 'synthetic' && item.text)).toEqual([
      '[Context Summary]',
      '## Compaction Archive\n- turn 1',
    ]);
    expect(tail).toBe(compacted[1]);
  });

  test('an empty manifest and an uncompacted stream both leave the turns alone', () => {
    expect(withArchiveManifest(compacted, '')).toEqual(compacted);
    const raw = [turn('t0', 'user', 'hi')];
    expect(withArchiveManifest(raw, '## Compaction Archive\n- turn 1')).toEqual(raw);
  });
});

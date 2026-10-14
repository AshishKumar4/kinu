/**
 * The sweep catalogue against the live tree.
 *
 * The sweep runs on request and refuses a snippet that no longer sits exactly once
 * in its file, but only when somebody runs it. So a refactor could delete the line an
 * entry mutates and nothing would say so until the next sweep: `effort-judge-rung`
 * pointed at the stage table 9e09c80a9 removed. These checks read the tree and nothing
 * else, so they run on every push.
 */

import { describe, expect, test } from 'bun:test';

import { locate } from './mutation-sweep';
import { CATALOGUE } from './mutation-sweep.catalogue';
import { isProductSource, readMatching } from './sources';

describe('every catalogue entry still lands', () => {
  test('every snippet sits in its file exactly once', () => {
    // Counted the way the sweep counts before it mutates, keyed by entry so a miss names the entry and its count.
    const counts = Object.fromEntries(CATALOGUE.map((mutation) => [mutation.id, locate(mutation).occurrences]));

    expect(counts).toEqual(Object.fromEntries(CATALOGUE.map((mutation) => [mutation.id, 1])));
  });

  test('a snippet that is absent, or present twice, is not counted once', () => {
    // The check above is only worth its green if it can fail.
    const anchor = CATALOGUE[0];
    expect(anchor).toBeDefined();

    if (anchor === undefined) return;
    expect(locate({ ...anchor, find: 'a line no source file contains' }).occurrences).toBe(0);
    expect(locate({ ...anchor, find: 'const ' }).occurrences).toBeGreaterThan(1);
  });

  test('every symbol names something in the product sources', () => {
    // `reach` counts the files that read `symbol`. A name the tree no longer holds has no readers, which the
    // report reads as dead wiring when the entry is only stale.
    const sources = [...readMatching((file) => isProductSource(file) && file.endsWith('.ts')).values()];

    const unnamed = CATALOGUE
      .filter((mutation) => !sources.some((text) => new RegExp(`\\b${mutation.symbol}\\b`, 'u').test(text)))
      .map((mutation) => `${mutation.id}: ${mutation.symbol}`);

    expect(unnamed).toEqual([]);
  });
});

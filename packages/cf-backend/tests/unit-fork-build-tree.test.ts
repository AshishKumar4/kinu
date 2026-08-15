/**
 * buildTree roots the rendered MCTS tree at the NEWEST search.
 *
 * The regression this pins: rows for several searches arrive together (the
 * server used to send the whole search_nodes table) and the old fold kept the
 * FIRST parentless row — the oldest root — so the workspace's first failed
 * search shadowed every later one. One stale node, no depth, forever.
 */

import { describe, test, expect } from 'bun:test';
import { buildTree, type MctsRow } from '../src/lib/fork-tree-rows.ts';

function row(partial: Partial<MctsRow> & { id: string; created_at: number }): MctsRow {
  return {
    parent_id: null, depth: 0, visits: 1, value: 0.5, status: 'open', action: 'act',
    ...partial,
  };
}

describe('buildTree', () => {
  test('one search builds its full tree', () => {
    const tree = buildTree([
      row({ id: 'r', created_at: 100 }),
      row({ id: 'a', parent_id: 'r', depth: 1, created_at: 110 }),
      row({ id: 'b', parent_id: 'r', depth: 1, created_at: 120 }),
    ]);
    expect(tree.id).toBe('r');
    expect(tree.children.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  test('with several searches in one payload, the newest root wins', () => {
    const tree = buildTree([
      // The workspace's first search: failed at its root — the row the old
      // fold pinned to.
      row({ id: 'old-root', status: 'failed', created_at: 100 }),
      // A later, richer search.
      row({ id: 'new-root', created_at: 200 }),
      row({ id: 'new-a', parent_id: 'new-root', depth: 1, created_at: 210 }),
      row({ id: 'new-a1', parent_id: 'new-a', depth: 2, created_at: 220 }),
    ]);
    expect(tree.id).toBe('new-root');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.children[0]!.id).toBe('new-a1');
  });

  test('a stray orphan never outranks a true root, whatever its age', () => {
    const tree = buildTree([
      row({ id: 'root', created_at: 100 }),
      // Parent missing from the payload — depth says it is not a root.
      row({ id: 'orphan', parent_id: 'gone', depth: 3, created_at: 999 }),
    ]);
    expect(tree.id).toBe('root');
  });

  test('an empty payload yields the placeholder root', () => {
    expect(buildTree([]).id).toBe('root');
  });
});

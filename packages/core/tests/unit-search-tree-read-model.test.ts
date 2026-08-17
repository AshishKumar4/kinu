/**
 * The MCTS view projection must show the LATEST search's tree.
 *
 * Settled searches stay in `search_nodes` forever, so after a failed first
 * attempt the table holds that dead tree beside every later one. The unscoped
 * read served the whole pile and the client rendered the OLDEST root — the
 * owner watched a fresh search run while the page showed one stale node.
 * These tests pin the projection to the most recently written search.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { readLatestSearchTree } from '../src/read-models/search-tree.js';

function freshDb() {
  const db = new Database(':memory:');
  initSearchTables(makeExecRaw(db), makeSql(db));
  return { db, sql: makeSql(db) };
}

function insertNode(
  db: Database,
  node: {
    id: string; parentId?: string | null; rootId?: string | null;
    depth?: number; status?: string; createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO search_nodes (id, parent_id, root_id, task, action, observation, depth, status, created_at)
     VALUES (?, ?, ?, 'task', 'act', 'obs', ?, ?, ?)`,
  ).run(node.id, node.parentId ?? null, node.rootId ?? null, node.depth ?? 0, node.status ?? 'open', node.createdAt);
}

/** A failed first search (root only) and a later, richer one. */
function seedTwoSearches(db: Database): void {
  insertNode(db, { id: 'old-root', rootId: 'old-root', status: 'failed', createdAt: 1000 });
  insertNode(db, { id: 'new-root', rootId: 'new-root', createdAt: 2000 });
  insertNode(db, { id: 'new-a', parentId: 'new-root', rootId: 'new-root', depth: 1, createdAt: 2100 });
  insertNode(db, { id: 'new-b', parentId: 'new-root', rootId: 'new-root', depth: 1, createdAt: 2200 });
  insertNode(db, { id: 'new-a1', parentId: 'new-a', rootId: 'new-root', depth: 2, createdAt: 2300 });
}

describe('readLatestSearchTree', () => {
  test('serves only the newest search, not the settled one beside it', () => {
    const { db, sql } = freshDb();
    seedTwoSearches(db);
    const rows = readLatestSearchTree(sql);
    expect(rows.map((r) => r.id)).toEqual(['new-root', 'new-a', 'new-b', 'new-a1']);
    expect(rows.every((r) => r.root_id === 'new-root')).toBe(true);
  });

  test('a resumed search still growing outranks a newer one that died at its root', () => {
    const { db, sql } = freshDb();
    seedTwoSearches(db);
    // A later attempt started (3000) and stopped at its root; the resumed
    // new-root search then wrote another node (3500) — that tree is live.
    insertNode(db, { id: 'stub-root', rootId: 'stub-root', status: 'failed', createdAt: 3000 });
    insertNode(db, { id: 'new-c', parentId: 'new-b', rootId: 'new-root', depth: 2, createdAt: 3500 });
    expect(readLatestSearchTree(sql).map((r) => r.id))
      .toEqual(['new-root', 'new-a', 'new-b', 'new-a1', 'new-c']);
  });

  test('rows come back depth-first then oldest-first, the order the tree builder expects', () => {
    const { db, sql } = freshDb();
    seedTwoSearches(db);
    const rows = readLatestSearchTree(sql);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
  });

  test('no searches yet is an empty projection, and legacy NULL-root rows stay invisible', () => {
    const { db, sql } = freshDb();
    expect(readLatestSearchTree(sql)).toEqual([]);
    // Pre-root_id rows are excluded from every scoped query by design.
    insertNode(db, { id: 'legacy-root', createdAt: 500 });
    insertNode(db, { id: 'legacy-child', parentId: 'legacy-root', depth: 1, createdAt: 600 });
    expect(readLatestSearchTree(sql)).toEqual([]);
  });
});

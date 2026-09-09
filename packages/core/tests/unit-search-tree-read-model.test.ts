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
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import { initSearchTables } from '../src/mcts/schemas';
import { readLatestSearchTree, readSearchNodeDetail } from '../src/read-models/search-tree';
import type { ActorHandle } from '../src/state/actor-handle';

/** The ledger and the actor it belongs to. `search_nodes` is keyed
 *  `(actor_id, id)`, so a seed and a read under different handles would come
 *  back empty — which here reads as "no searches yet" and would let a
 *  projection serving the WRONG tree pass every case below. */
function freshDb() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  return { db, sql, actor: createTestActors(sql, execRaw).main };
}

function insertNode(
  db: Database,
  actor: ActorHandle,
  node: {
    id: string; parentId?: string | null; rootId: string;
    depth?: number; status?: string; createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, depth, status, created_at)
     VALUES (?, ?, ?, ?, 'task', 'act', 'obs', ?, ?, ?)`,
  ).run(
    actor.actorId, node.id, node.parentId ?? null, node.rootId,
    node.depth ?? 0, node.status ?? 'open', node.createdAt,
  );
}

/** A failed first search (root only) and a later, richer one. */
function seedTwoSearches(db: Database, actor: ActorHandle): void {
  insertNode(db, actor, { id: 'old-root', rootId: 'old-root', status: 'failed', createdAt: 1000 });
  insertNode(db, actor, { id: 'new-root', rootId: 'new-root', createdAt: 2000 });
  insertNode(db, actor, { id: 'new-a', parentId: 'new-root', rootId: 'new-root', depth: 1, createdAt: 2100 });
  insertNode(db, actor, { id: 'new-b', parentId: 'new-root', rootId: 'new-root', depth: 1, createdAt: 2200 });
  insertNode(db, actor, { id: 'new-a1', parentId: 'new-a', rootId: 'new-root', depth: 2, createdAt: 2300 });
}

describe('readLatestSearchTree', () => {
  test('serves only the newest search, not the settled one beside it', () => {
    const { db, sql, actor } = freshDb();
    seedTwoSearches(db, actor);
    const rows = readLatestSearchTree(sql, actor);
    expect(rows.map((r) => r.id)).toEqual(['new-root', 'new-a', 'new-b', 'new-a1']);
    expect(rows.every((r) => r.root_id === 'new-root')).toBe(true);
  });

  test('a resumed search still growing outranks a newer one that died at its root', () => {
    const { db, sql, actor } = freshDb();
    seedTwoSearches(db, actor);
    // A later attempt started (3000) and stopped at its root; the resumed
    // new-root search then wrote another node (3500) — that tree is live.
    insertNode(db, actor, { id: 'stub-root', rootId: 'stub-root', status: 'failed', createdAt: 3000 });
    insertNode(db, actor, { id: 'new-c', parentId: 'new-b', rootId: 'new-root', depth: 2, createdAt: 3500 });
    expect(readLatestSearchTree(sql, actor).map((r) => r.id))
      .toEqual(['new-root', 'new-a', 'new-b', 'new-a1', 'new-c']);
  });

  test('rows come back depth-first then oldest-first, the order the tree builder expects', () => {
    const { db, sql, actor } = freshDb();
    seedTwoSearches(db, actor);
    const rows = readLatestSearchTree(sql, actor);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
  });

  test('no searches yet is an empty projection', () => {
    const { sql, actor } = freshDb();
    expect(readLatestSearchTree(sql, actor)).toEqual([]);
  });
});

// One node in full — the projection `kinu inspect mcts <id>` renders, which
// existed once per backend under two names until it moved here. These pin the
// three things the two copies each restated: the ancestry order, the child
// ordering, and that a cyclic parent chain terminates instead of hanging.
describe('readSearchNodeDetail', () => {
  function scored(
    db: Database,
    actor: ActorHandle,
    node: { id: string; parentId: string | null; value: number; visits: number; createdAt: number },
  ): void {
    db.prepare(
      `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, depth, status,
                                 value, visits, created_at)
       VALUES (?, ?, ?, 'r', 'task', ?, 'obs', 1, 'open', ?, ?, ?)`,
    ).run(actor.actorId, node.id, node.parentId, `act-${node.id}`, node.value, node.visits, node.createdAt);
  }

  test('a node nobody wrote is null, not an empty node', () => {
    const { sql, actor } = freshDb();
    expect(readSearchNodeDetail(sql, actor, 'nope')).toBeNull();
  });

  test('the path runs root first to the node last', () => {
    const { db, sql, actor } = freshDb();
    seedTwoSearches(db, actor);
    const detail = readSearchNodeDetail(sql, actor, 'new-a1');
    expect(detail?.path.map((n) => n.id)).toEqual(['new-root', 'new-a', 'new-a1']);
    expect(detail?.id).toBe('new-a1');
    expect(detail?.parentId).toBe('new-a');
    expect(detail?.children).toEqual([]);
  });

  test('children come back best first: value, then visits, then insertion order', () => {
    const { db, sql, actor } = freshDb();
    insertNode(db, actor, { id: 'r', rootId: 'r', createdAt: 1 });
    scored(db, actor, { id: 'low', parentId: 'r', value: 0.1, visits: 9, createdAt: 10 });
    scored(db, actor, { id: 'tied-late', parentId: 'r', value: 0.9, visits: 2, createdAt: 30 });
    scored(db, actor, { id: 'tied-early', parentId: 'r', value: 0.9, visits: 2, createdAt: 20 });
    scored(db, actor, { id: 'best', parentId: 'r', value: 0.9, visits: 7, createdAt: 40 });
    expect(readSearchNodeDetail(sql, actor, 'r')?.children.map((c) => c.id))
      .toEqual(['best', 'tied-early', 'tied-late', 'low']);
  });

  test('a cyclic parent chain terminates rather than hanging the read', () => {
    const { db, sql, actor } = freshDb();
    insertNode(db, actor, { id: 'a', parentId: 'b', rootId: 'r', createdAt: 1 });
    insertNode(db, actor, { id: 'b', parentId: 'a', rootId: 'r', createdAt: 2 });
    expect(readSearchNodeDetail(sql, actor, 'a')?.path.map((n) => n.id)).toEqual(['b', 'a']);
  });

  test('the full node carries the fields a summary omits', () => {
    const { db, sql, actor } = freshDb();
    insertNode(db, actor, { id: 'solo', rootId: 'solo', createdAt: 7 });
    expect(readSearchNodeDetail(sql, actor, 'solo')).toMatchObject({
      id: 'solo', parentId: null, depth: 0, status: 'open', action: 'act',
      task: 'task', observation: 'obs', codeUsed: null, branchAgentKey: null,
      msgId: null, createdAt: 7,
    });
  });
});

/**
 * A RUNNING swarm's nodes are on the canvas while they run.
 *
 * The incident this pins, measured on the owner's own workspace: a swarm the
 * agent reported as 5/10 nodes deep drew a lone 0% root, "0 branches" and no
 * live nodes, for its whole life. Nothing was lost — every node was in the
 * journal and the response carried it — and the canvas chose not to look.
 *
 * The engine writes the root `search_nodes` row at dispatch
 * (`strategy/swarm-run.ts`) and a child row only once a node has REPORTED, while
 * each node's spawn is journalled the instant it starts under the same node id.
 * So mid-flight a swarm's tree half is exactly one row and its journal half is
 * every node currently working. A fold that reads one half or the other, and
 * prefers the tree because it is non-empty, therefore draws the root alone every
 * time — not for an edge case but for every real swarm.
 *
 * Which is why these tests are about a run that has completed ZERO nodes. That
 * is the state a search is in for most of its life and the state the canvas was
 * blind in.
 */

import { describe, test, expect } from 'bun:test';
import type { HeadRunView } from '@kinu.run/core';
import { explorationForkTree, type MctsRow } from '../src/lib/fork-tree-rows';
import type { ForkNode } from '../src/lib/protocol';

const ROOT = 'root-1';

/** The root row the engine writes at dispatch, and the only search row a swarm
 *  has until one of its nodes reports. */
function rootRow(): MctsRow {
  return {
    id: ROOT, parent_id: null, depth: 0, visits: 0, value: 0,
    status: 'open', action: '', task: 'optimise the tokenizer',
    root_id: ROOT, created_at: 1_000,
  };
}

/** A settled child row — what a node that HAS reported leaves in the tree. */
function settledRow(id: string, value: number): MctsRow {
  return {
    id, parent_id: ROOT, depth: 1, visits: 1, value,
    status: 'open', action: '', root_id: ROOT, created_at: 2_000,
  };
}

function head(id: string, status: string, extra: Partial<HeadRunView['heads'][number]> = {}) {
  return {
    id, task: `work ${id}`, rationale: 'why', status,
    summary: null, errorMessage: null, usage: {}, wallClockMs: 0,
    parentId: ROOT, depth: 1,
    spawnedAt: 1_100, lastStepAt: null, decisions: [],
    ...extra,
  };
}

function journal(heads: HeadRunView['heads'], status = 'running'): HeadRunView {
  return {
    rootId: ROOT, task: 'optimise the tokenizer', rationale: 'balanced',
    status, spawnedAt: 1_000, heads, merge: null,
  };
}

/** Every vertex of the folded tree, root included. */
function vertices(node: ForkNode | null): ForkNode[] {
  return node === null ? [] : [node, ...node.children.flatMap(vertices)];
}

describe('explorationForkTree — a running swarm', () => {
  test('five running nodes and a root-only tree draw six vertices', () => {
    const tree = explorationForkTree({
      tree: [rootRow()],
      head: journal([
        head('n1', 'running'), head('n2', 'running'), head('n3', 'running'),
        head('n4', 'running'), head('n5', 'running'),
      ]),
    });
    expect(tree).not.toBeNull();
    expect(tree!.id).toBe(ROOT);
    expect(vertices(tree)).toHaveLength(6);
    expect(tree!.children.map((child) => child.id).sort())
      .toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  test('a running node carries no score and no rollout count', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: journal([head('n1', 'running')]) });
    const node = tree!.children[0]!;
    expect(node.status).toBe('running');
    // The lie the incident's "0%" root told. A node that has reported nothing
    // has earned no number, and null is how this view spells that.
    expect(node.value).toBeNull();
    expect(node.visits).toBeNull();
  });

  test('the settled row wins over the journal row for the same node', () => {
    // A node that reported has BOTH halves under one id. The tree row is the
    // engine's own settled statement about it, so it decides — and the node
    // appears once, not twice.
    const tree = explorationForkTree({
      tree: [rootRow(), settledRow('n1', 0.71)],
      head: journal([head('n1', 'completed'), head('n2', 'running')]),
    });
    expect(vertices(tree)).toHaveLength(3);
    const settled = tree!.children.find((child) => child.id === 'n1')!;
    expect(settled.value).toBe(0.71);
    expect(settled.visits).toBe(1);
    expect(settled.status).toBe('open');
    expect(tree!.children.find((child) => child.id === 'n2')!.value).toBeNull();
  });

  test('a journalled node hangs under its own parent, not under the root', () => {
    // A depth-2 node's parent is a node, and flattening it to the root is the
    // shape a deeper search would be misdrawn in.
    const tree = explorationForkTree({
      tree: [rootRow(), settledRow('n1', 0.4)],
      head: journal([
        head('n1', 'completed'),
        head('n1a', 'running', { parentId: 'n1', depth: 2 }),
      ]),
    });
    const parent = tree!.children.find((child) => child.id === 'n1')!;
    expect(parent.children.map((child) => child.id)).toEqual(['n1a']);
    expect(parent.children[0]!.depth).toBe(2);
  });

  test('a node whose parent is not in either half still reaches the canvas', () => {
    // Dropping it would be the same silent loss at a smaller scale, so it
    // attaches to the root rather than vanishing.
    const tree = explorationForkTree({
      tree: [rootRow()],
      head: journal([head('orphan', 'running', { parentId: 'gone', depth: 3 })]),
    });
    expect(vertices(tree)).toHaveLength(2);
    expect(tree!.children[0]!.id).toBe('orphan');
  });

  test('a run with journalled nodes and no tree at all still folds', () => {
    const tree = explorationForkTree({
      tree: [], head: journal([head('n1', 'running'), head('n2', 'completed')]),
    });
    expect(vertices(tree)).toHaveLength(3);
  });

  test('a run with neither half folds to nothing', () => {
    expect(explorationForkTree({ tree: [], head: null })).toBeNull();
  });
});

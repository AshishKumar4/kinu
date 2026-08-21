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

/**
 * THE RUN AS PRODUCTION HELD IT, at the moment the owner's canvas drew one
 * vertex at 0%.
 *
 * Root `2rye1eyny1efm9583sqye`: one `search_nodes` root row, `mcts_search_runs`
 * status `running` at epoch 2, and FIFTEEN `head_journal` rows over three spawn
 * generations — 2 completed carrying real summaries, 5 running with `lastStepAt`
 * advancing past `spawnedAt`, 2 errored, 6 aborted. Each earlier generation was
 * retired when its activation died and re-spawned from zero, which is why one
 * search holds fifteen rows for five live nodes.
 *
 * A harder case than a clean wave in two ways, and both are the point. The two
 * FINISHED candidates were shadowed as completely as the live ones, so the run
 * had answers a reader could not reach. And six of the fifteen rows are dead:
 * drawing those as live would replace one silence with a worse lie, so the census
 * is asserted status by status rather than only by count.
 */
const GENERATIONS = [
  { spawnedAt: 1_787_284_776_338, ids: ['a1', 'a2', 'a3', 'a4', 'a5'], status: 'aborted' },
  { spawnedAt: 1_787_284_797_212, ids: ['b1'], status: 'aborted' },
  { spawnedAt: 1_787_285_712_156, ids: ['c1', 'c2', 'c3', 'c4', 'c5'], status: 'running' },
] as const;

function productionCensus(): HeadRunView {
  const heads = GENERATIONS.flatMap((generation) => generation.ids.map((id) => head(id, generation.status, {
    spawnedAt: generation.spawnedAt,
    // The five live nodes are demonstrably working: their last step is later than
    // their spawn. That is the fact the canvas had and did not draw.
    lastStepAt: generation.status === 'running' ? 1_787_285_894_585 : null,
  })));
  return journal([
    ...heads,
    head('cbf7hl3o5n0r52j716zeh', 'completed', {
      spawnedAt: 1_787_285_712_156,
      summary: "mcp.ts:229 takes a user-controlled URL and fetches it with no redirect:'manual'",
    }),
    head('q5ghadns41o1shnpl3vfh', 'completed', {
      spawnedAt: 1_787_285_712_156,
      summary: 'the detached lane amplifies one request into N Durable Object wakes',
    }),
    head('e1', 'errored', { spawnedAt: 1_787_285_712_156, errorMessage: 'Turn stalled: nothing flowed for 300s' }),
    head('e2', 'errored', { spawnedAt: 1_787_285_712_156, errorMessage: 'Turn stalled: nothing flowed for 300s' }),
  ]);
}

describe('explorationForkTree — the run as production held it', () => {
  test('fifteen journalled nodes and a root-only tree draw sixteen vertices', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: productionCensus() });
    expect(productionCensus().heads).toHaveLength(15);
    expect(vertices(tree)).toHaveLength(16);
    // Not one of them was drawn. The run header counted fifteen from the same
    // response, which is how the two numbers came to contradict each other on one
    // screen.
    expect(tree!.children).toHaveLength(15);
  });

  test('the two finished candidates reach the canvas with their answers', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: productionCensus() });
    const finished = tree!.children.filter((child) => child.status === 'open');
    expect(finished.map((child) => child.id).sort())
      .toEqual(['cbf7hl3o5n0r52j716zeh', 'q5ghadns41o1shnpl3vfh']);
    expect(finished[0]!.observation).toContain('mcp.ts:229');
  });

  test('the dead rows are drawn dead — six aborted and two errored, none of them live', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: productionCensus() });
    const byStatus = new Map<string, number>();
    for (const child of tree!.children) {
      byStatus.set(child.status, (byStatus.get(child.status) ?? 0) + 1);
    }
    // `aborted` and `errored` are both terminal and both failures, so the tree's
    // own vocabulary has one word for them. What matters is that eight rows are
    // NOT running: replacing an invisible node with a fake live one would be a
    // worse defect than the one being fixed.
    expect(byStatus.get('failed')).toBe(8);
    expect(byStatus.get('running')).toBe(5);
    expect(byStatus.get('open')).toBe(2);
    expect(byStatus.get('terminal')).toBeUndefined();
  });

  test('no node claims a score, because none of these rows carries one', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: productionCensus() });
    for (const child of tree!.children) {
      expect(child.value).toBeNull();
      expect(child.visits).toBeNull();
    }
  });
});

/**
 * The last of the lone `0% root`.
 *
 * The fold above puts a running node on the canvas. The ROOT is not a running
 * node: it comes from the settled half, because the engine writes its row at
 * dispatch — and `SearchNode.value` is a `number` initialised to 0. So the root
 * of a swarm that has evaluated nothing carries a real, stored `0`, survives the
 * fold intact, and is drawn `0%`.
 *
 * That is the caption in the owner's screenshot, and it is a lie of the same kind
 * as the missing nodes: 0 is the initialiser, not a measurement. `visits === 0`
 * is what says so — nothing has been backpropagated through this node — and it is
 * the store's own field, not a heuristic.
 */
describe('a node nothing has been backpropagated through has no score', () => {
  test('the root of a search that has evaluated nothing carries null, not 0', () => {
    const tree = explorationForkTree({ tree: [rootRow()], head: null });
    expect(tree?.visits).toBeNull();
    expect(tree?.value).toBeNull();
  });

  test('a visited node keeps the score it earned, including a genuine zero', () => {
    const scored: MctsRow = {
      ...rootRow(), id: 'n1', parent_id: ROOT, depth: 1, visits: 3, value: 0,
    };
    const tree = explorationForkTree({ tree: [rootRow(), scored], head: null });
    const child = tree?.children[0];
    // Three rollouts that all returned 0 is a measurement and must survive: this
    // is the case a blanket "hide zeroes" rule would erase.
    expect(child?.visits).toBe(3);
    expect(child?.value).toBe(0);
  });

  test('an unvisited row that somehow carries a value keeps it', () => {
    // The store should not produce this, and if it does the number is the only
    // evidence there is. Suppressing it would be inventing an absence.
    const odd: MctsRow = {
      ...rootRow(), id: 'n2', parent_id: ROOT, depth: 1, visits: 0, value: 0.7,
    };
    const tree = explorationForkTree({ tree: [rootRow(), odd], head: null });
    expect(tree?.children[0]?.value).toBe(0.7);
  });
});

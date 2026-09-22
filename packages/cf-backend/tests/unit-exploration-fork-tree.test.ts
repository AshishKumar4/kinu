/**
 * Defends: a running swarm drawn as a lone 0% root. The engine writes a child `search_nodes` row only once a node
 * reports, while spawns are journalled immediately, so a zero-completed run must be drawn from the journal half.
 */

import { describe, test, expect } from 'bun:test';
import type { HeadRunView } from '@kinu.run/core';
import { explorationForkTree, type MctsRow } from '@kinu.run/core';
import type { ForkNode, ForkNodeLifecycle } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

const ROOT = 'root-1';

/** Until a node reports, a swarm's only search row. */
function rootRow(): MctsRow {
  return {
    id: ROOT, parent_id: null, depth: 0, visits: 0, value: 0,
    status: 'open', action: '', task: 'optimise the tokenizer',
    root_id: ROOT, created_at: 1_000,
  };
}

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

function vertices(node: ForkNode | null): ForkNode[] {
  return node === null ? [] : [node, ...node.children.flatMap(vertices)];
}

describe('explorationForkTree — a running swarm', () => {
  test('five running nodes and a root-only tree draw six vertices', () => {
    const tree = present(explorationForkTree({
      tree: [rootRow()],
      head: journal([
        head('n1', 'running'), head('n2', 'running'), head('n3', 'running'),
        head('n4', 'running'), head('n5', 'running'),
      ]),
    }), 'the folded fork tree');

    expect(tree.id).toBe(ROOT);
    expect(vertices(tree)).toHaveLength(6);
    expect(tree.children.map((child) => child.id).sort())
      .toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  test('a running node carries no score and no rollout count', () => {
    const tree = present(explorationForkTree({ tree: [rootRow()], head: journal([head('n1', 'running')]) }), 'the folded fork tree');
    const node = tree.children[0];
    expect(node.status).toBe('running');
    // A node that has reported nothing has earned no number.
    expect(node.value).toBeNull();
    expect(node.visits).toBeNull();
  });

  test('the settled row wins over the journal row for the same node', () => {
    // A reported node has both halves under one id; the settled tree row decides, and it appears once.
    const tree = present(explorationForkTree({
      tree: [rootRow(), settledRow('n1', 0.71)],
      head: journal([head('n1', 'completed'), head('n2', 'running')]),
    }), 'the folded fork tree');

    expect(vertices(tree)).toHaveLength(3);
    const settled = present(tree.children.find((child) => child.id === 'n1'), 'the n1 vertex');
    expect(settled.value).toBe(0.71);
    expect(settled.visits).toBe(1);
    expect(settled.status).toBe('open');
    expect(present(tree.children.find((child) => child.id === 'n2'), 'the n2 vertex').value).toBeNull();
  });

  test('a journalled node hangs under its own parent, not under the root', () => {
    const tree = present(explorationForkTree({
      tree: [rootRow(), settledRow('n1', 0.4)],
      head: journal([
        head('n1', 'completed'),
        head('n1a', 'running', { parentId: 'n1', depth: 2 }),
      ]),
    }), 'the folded fork tree');

    const parent = present(tree.children.find((child) => child.id === 'n1'), 'the n1 vertex');
    expect(parent.children.map((child) => child.id)).toEqual(['n1a']);
    expect(parent.children[0].depth).toBe(2);
  });

  test('a node whose parent is not in either half still reaches the canvas', () => {
    // Attached to the root rather than silently dropped.
    const tree = present(explorationForkTree({
      tree: [rootRow()],
      head: journal([head('orphan', 'running', { parentId: 'gone', depth: 3 })]),
    }), 'the folded fork tree');

    expect(vertices(tree)).toHaveLength(2);
    expect(tree.children[0].id).toBe('orphan');
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
 * The production run behind the incident: fifteen journal rows over three spawn generations (2 completed, 5 running,
 * 2 errored, 6 aborted), so the census is asserted status by status, not only by count.
 */
const GENERATIONS = [
  { spawnedAt: 1_787_284_776_338, ids: ['a1', 'a2', 'a3', 'a4', 'a5'], status: 'aborted' },
  { spawnedAt: 1_787_284_797_212, ids: ['b1'], status: 'aborted' },
  { spawnedAt: 1_787_285_712_156, ids: ['c1', 'c2', 'c3', 'c4', 'c5'], status: 'running' },
] as const;

function productionCensus(): HeadRunView {
  const heads = GENERATIONS.flatMap((generation) => generation.ids.map((id) => head(id, generation.status, {
    spawnedAt: generation.spawnedAt,
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
    const tree = present(explorationForkTree({ tree: [rootRow()], head: productionCensus() }), 'the folded fork tree');
    expect(productionCensus().heads).toHaveLength(15);
    expect(vertices(tree)).toHaveLength(16);
    expect(tree.children).toHaveLength(15);
  });

  test('the two finished candidates reach the canvas with their answers', () => {
    const tree = present(explorationForkTree({ tree: [rootRow()], head: productionCensus() }), 'the folded fork tree');
    const finished = tree.children.filter((child) => child.status === 'open');
    expect(finished.map((child) => child.id).sort())
      .toEqual(['cbf7hl3o5n0r52j716zeh', 'q5ghadns41o1shnpl3vfh']);
    expect(finished[0].observation).toContain('mcp.ts:229');
  });

  test('the dead rows are drawn dead — six aborted and two errored, none of them live', () => {
    const tree = present(explorationForkTree({ tree: [rootRow()], head: productionCensus() }), 'the folded fork tree');
    const byStatus = new Map<string, number>();

    for (const child of tree.children) {
      byStatus.set(child.status, (byStatus.get(child.status) ?? 0) + 1);
    }

    // Eight rows are not running: drawing a dead node as live would be worse than the original defect.
    expect(byStatus.get('failed')).toBe(8);
    expect(byStatus.get('running')).toBe(5);
    expect(byStatus.get('open')).toBe(2);
    expect(byStatus.get('terminal')).toBeUndefined();
  });

  test('no node claims a score, because none of these rows carries one', () => {
    const tree = present(explorationForkTree({ tree: [rootRow()], head: productionCensus() }), 'the folded fork tree');

    for (const child of tree.children) {
      expect(child.value).toBeNull();
      expect(child.visits).toBeNull();
    }
  });
});

/** A root with `visits === 0` carries the initialiser `0`, not a measurement, and must not be drawn `0%`. */
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
    // Three rollouts all returning 0 is a measurement a blanket "hide zeroes" rule would erase.
    expect(child?.visits).toBe(3);
    expect(child?.value).toBe(0);
  });

  test('an unvisited row that somehow carries a value keeps it', () => {
    // Should not happen; if it does, the number is the only evidence.
    const odd: MctsRow = {
      ...rootRow(), id: 'n2', parent_id: ROOT, depth: 1, visits: 0, value: 0.7,
    };

    const tree = explorationForkTree({ tree: [rootRow(), odd], head: null });
    expect(tree?.children[0]?.value).toBe(0.7);
  });
});

/** `ForkNode.status` is the drawing vocabulary with one word per ending; the journal lifecycle rides beside it. */
describe('the fold keeps the journal\'s own status word', () => {
  /** Typed pairs rather than an object, so a status the union drops fails to compile here. */
  const DRAWN: ReadonlyArray<readonly [ForkNodeLifecycle, ForkNode['status']]> = [
    ['completed', 'open'],
    ['running', 'running'],
    ['interrupted', 'failed'],
    ['budget_exceeded', 'failed'],
    ['aborted', 'failed'],
    ['errored', 'failed'],
  ];

  for (const [status, drawn] of DRAWN) {
    test(`${status} draws as ${drawn} and still says ${status}`, () => {
      const tree = explorationForkTree({ tree: [rootRow()], head: journal([head('n1', status)]) });
      const child = tree?.children[0];
      expect(child?.status).toBe(drawn);
      expect(child?.lifecycle).toBe(status);
    });
  }

  test('a word no version of this journal writes names nothing at all', () => {
    // The graph prints `lifecycle ?? status`, so an unknown column value falls back to the drawing word.
    const tree = explorationForkTree({ tree: [rootRow()], head: journal([head('n1', 'reticulating')]) });
    expect(tree?.children[0]?.lifecycle).toBeUndefined();
    expect(tree?.children[0]?.status).toBe('failed');
  });

  test('a search row carries none — its own status IS its store\'s word', () => {
    const tree = explorationForkTree({ tree: [rootRow(), settledRow('n1', 0.5)], head: null });
    expect(tree?.children[0]?.lifecycle).toBeUndefined();
  });
});

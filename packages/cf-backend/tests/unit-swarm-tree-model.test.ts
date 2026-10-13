// The MCTS tree view's read model: principal line, node size, labels and folding, without a DOM.
import { describe, test, expect } from 'bun:test';
import type { ForkNode } from '@kinu.run/core';
import type { HeadRunView } from '@kinu.run/core';
import { explorationForkTree, type MctsRow } from '@kinu.run/core';
import { ancestorIds, cleanNodeLabel, findForkNode, losingBranchIds, principalVariation, subtreeCount, terminalForkNode, treeStats } from '@kinu.run/core/swarm-view';
import { present } from '@kinu.run/test-utils';

let seq = 0;

function node(over: Partial<ForkNode> = {}): ForkNode {
  return {
    id: `n${seq++}`, parentId: null, depth: 0, value: 0.5, visits: 1,
    status: 'open', action: 'do a thing', children: [], ...over,
  };
}

describe('principalVariation', () => {
  test('follows the most-visited child to a leaf', () => {
    const winner = node({ id: 'win', visits: 8, depth: 2 });

    const root = node({
      id: 'root', visits: 20,
      children: [
        node({ id: 'a', visits: 3, depth: 1 }),
        node({ id: 'b', visits: 12, depth: 1, children: [winner, node({ id: 'lose', visits: 2, depth: 2 })] }),
      ],
    });

    expect([...principalVariation(root)]).toEqual(['root', 'b', 'win']);
  });

  test('breaks a visit tie on score', () => {
    const root = node({
      id: 'root', visits: 4,
      children: [
        node({ id: 'lo', visits: 2, value: 0.2 }),
        node({ id: 'hi', visits: 2, value: 0.9 }),
      ],
    });

    expect(principalVariation(root).has('hi')).toBe(true);
    expect(principalVariation(root).has('lo')).toBe(false);
  });

  test('a lone root is its own variation', () => {
    expect([...principalVariation(node({ id: 'only' }))]).toEqual(['only']);
  });
});

describe('ancestorIds', () => {
  const deep = node({ id: 'deep' });

  const root = node({
    id: 'root',
    children: [node({ id: 'a' }), node({ id: 'b', children: [node({ id: 'c', children: [deep] })] })],
  });

  test('names every branch that has to be open for a node to be on screen', () => {
    expect(ancestorIds(root, 'deep')).toEqual(['root', 'b', 'c']);
  });

  test('the root has no ancestors, and an absent id has no path', () => {
    expect(ancestorIds(root, 'root')).toEqual([]);
    expect(ancestorIds(root, 'nope')).toEqual([]);
  });
});

describe('stored tree fields', () => {
  test('keeps the d0 root and a journalled depth-3 node at its stored depth', () => {
    const root: MctsRow = {
      id: 'root', parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0,
      status: 'open', action: 'root',
    };

    const head: HeadRunView = {
      rootId: 'root', task: 'inspect the tree', rationale: 'depth fixture',
      status: 'running', spawnedAt: 1, merge: null,
      heads: [{
        id: 'deep', parentId: 'missing-parent', depth: 3, task: 'deep node',
        rationale: 'the stored depth is authoritative', status: 'running',
        summary: null, errorMessage: null, usage: {}, wallClockMs: 0,
        spawnedAt: 2, lastStepAt: null, decisions: [],
      }],
    };

    const tree = present(explorationForkTree({ tree: [root], head }), 'the folded fork tree');

    expect(tree).toMatchObject({ id: 'root', depth: 0 });
    expect(tree.children[0]).toMatchObject({ id: 'deep', depth: 3, status: 'running' });
    expect(treeStats(tree)).toEqual({ nodes: 2, depth: 3 });
  });
});


describe('live selection', () => {
  test('an id resolves to the node from the newest immutable tree snapshot', () => {
    const first = node({
      id: 'root',
      children: [node({ id: 'branch', status: 'running', visits: 1, value: null })],
    });

    const next = node({
      id: 'root',
      children: [node({ id: 'branch', status: 'terminal', visits: 8, value: 0.91 })],
    });

    expect(findForkNode(first, 'branch')).toMatchObject({ status: 'running', visits: 1 });
    expect(findForkNode(next, 'branch')).toMatchObject({ status: 'terminal', visits: 8, value: 0.91 });
    expect(findForkNode(next, 'missing')).toBeNull();
  });
});

describe('settled winner', () => {
  test('a running search has no winner even when live branches already have scores', () => {
    const root = node({
      id: 'root',
      children: [node({ id: 'provisional', status: 'running', value: 0.99 })],
    });

    expect(terminalForkNode(root)).toBeNull();
  });

  test('the winner is the terminal branch, not a higher-scoring unchosen alternative', () => {
    const root = node({
      id: 'root',
      children: [
        node({ id: 'unchosen', status: 'open', value: 0.99 }),
        node({ id: 'chosen', status: 'terminal', value: 0.81 }),
      ],
    });

    expect(terminalForkNode(root)?.id).toBe('chosen');
  });
});

describe('folding', () => {

  test('an abandoned leaf has nothing to fold', () => {
    const root = node({ children: [node({ id: 'leaf', status: 'pruned' })] });
    expect(losingBranchIds(root).size).toBe(0);
  });

  // convergence.ts:107-111 prunes every open node of a settled search but the winner, root included,
  // so a settled root is 'pruned' or 'failed' and must not fold the whole search.
  test('a settled root is not a losing branch — the split is not a branch of itself', () => {
    for (const status of ['pruned', 'failed'] as const) {
      const root = node({
        id: 'root', status,
        children: [node({ id: 'a', children: [node({ id: 'a-kid' })] }), node({ id: 'b' })],
      });

      expect([...losingBranchIds(root)]).toEqual([]);
    }
  });

  test('a settled root still folds the abandoned branches underneath it', () => {
    const root = node({
      id: 'root', status: 'pruned',
      children: [
        node({ id: 'lost', status: 'pruned', children: [node({ id: 'lost-kid' })] }),
        node({ id: 'won', status: 'terminal' }),
      ],
    });

    expect([...losingBranchIds(root)]).toEqual(['lost']);
  });

  test('subtreeCount is the descendants a fold hides', () => {
    const root = node({ children: [node({ children: [node(), node()] }), node()] });
    expect(subtreeCount(root)).toBe(4);
    expect(subtreeCount(node())).toBe(0);
  });
});

describe('labels', () => {
  test('takes the first real line and strips the model prose out of it', () => {
    expect(cleanNodeLabel('\n\n## **Backfill** the `kind` column\nrest', 'x'))
      .toBe('Backfill the kind column');
    expect(cleanNodeLabel('- retry the migration', 'x')).toBe('retry the migration');
  });

  test('falls back when there is nothing to show', () => {
    expect(cleanNodeLabel('', '(root)')).toBe('(root)');
    expect(cleanNodeLabel(null, '(root)')).toBe('(root)');
    expect(cleanNodeLabel('   ', '(root)')).toBe('(root)');
  });

});

// A canvas that crops or de-labels itself silently reads as broken (#206): note below legible zoom or wider than view.

// The MCTS tree view's read model — the decisions that carry the meaning of
// the picture (which line the search paid for, how big a node is, what a label
// says, which branches are foldable) without a DOM to render them into.
import { describe, test, expect } from 'bun:test';
import type { ForkNode } from '../src/lib/protocol';
import type { HeadRunView } from '@kinu.run/core';
import { explorationForkTree, type MctsRow } from '../src/lib/fork-tree-rows';
import {
  ancestorIds, cleanNodeLabel, clipToWidth, findForkNode, LABEL_MIN_SCALE, linkWidth, losingBranchIds, maxVisits,
  NODE_R_MAX, NODE_R_MIN, nodeRadius, principalVariation, subtreeCount, terminalForkNode, treeStats,
  viewNoteFor,
} from '../src/components/swarm-tree-model';

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

  test('breaks a visit tie on mean value', () => {
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

describe('treeStats', () => {
  test('counts every node and reports the deepest depth', () => {
    const root = node({
      depth: 0,
      children: [
        node({ depth: 1, children: [node({ depth: 2 }), node({ depth: 2, children: [node({ depth: 3 })] })] }),
        node({ depth: 1 }),
      ],
    });
    expect(treeStats(root)).toEqual({ nodes: 6, depth: 3 });
  });
});

describe('stored tree fields', () => {
  test('keeps the d0 root and a journalled depth-3 node at its stored depth', () => {
    const root: MctsRow = {
      id: 'root', parent_id: null, depth: 0, visits: 0, value: 0,
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

    const tree = explorationForkTree({ tree: [root], head });

    expect(tree).toMatchObject({ id: 'root', depth: 0 });
    expect(tree!.children[0]).toMatchObject({ id: 'deep', depth: 3, status: 'running' });
    expect(treeStats(tree!)).toEqual({ nodes: 2, depth: 3 });
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

describe('size scales', () => {
  test('radius grows with visits and stays inside its bracket', () => {
    expect(nodeRadius(0, 20)).toBeCloseTo(NODE_R_MIN, 5);
    expect(nodeRadius(20, 20)).toBeCloseTo(NODE_R_MAX, 5);
    expect(nodeRadius(5, 20)).toBeGreaterThan(nodeRadius(1, 20));
    expect(nodeRadius(5, 20)).toBeLessThan(nodeRadius(20, 20));
  });

  test('area, not diameter, tracks visits', () => {
    // Four times the rollouts is twice the radius above the floor.
    const quarter = nodeRadius(5, 20) - NODE_R_MIN;
    const full = nodeRadius(20, 20) - NODE_R_MIN;
    expect(full / quarter).toBeCloseTo(2, 5);
  });

  test('an unvisited tree does not divide by zero', () => {
    expect(nodeRadius(0, 0)).toBeCloseTo(NODE_R_MIN, 5);
    expect(linkWidth(0, 0)).toBeGreaterThan(0);
  });

  test('visits beyond the maximum cannot blow the scale out', () => {
    expect(nodeRadius(999, 20)).toBeCloseTo(NODE_R_MAX, 5);
    expect(linkWidth(999, 20)).toBeCloseTo(linkWidth(20, 20), 5);
  });

  test('maxVisits reads the busiest node anywhere in the tree', () => {
    const root = node({ visits: 3, children: [node({ visits: 1, children: [node({ visits: 17 })] })] });
    expect(maxVisits(root)).toBe(17);
  });
});

describe('folding', () => {
  test('the topmost abandoned branch hides its cluster, and live ones are kept', () => {
    const root = node({
      id: 'root',
      children: [
        node({ id: 'pruned', status: 'pruned', children: [node({ id: 'pruned-kid', status: 'pruned', children: [node({ id: 'deep' })] })] }),
        node({ id: 'failed', status: 'failed', children: [node({ id: 'failed-kid' })] }),
        node({ id: 'open', children: [node({ id: 'open-kid' })] }),
      ],
    });
    expect([...losingBranchIds(root)].sort()).toEqual(['failed', 'pruned']);
  });

  test('an abandoned leaf has nothing to fold', () => {
    const root = node({ children: [node({ id: 'leaf', status: 'pruned' })] });
    expect(losingBranchIds(root).size).toBe(0);
  });

  // convergence.ts:107-111 prunes every still-open node of a settled search
  // except the winner, and the root matches that WHERE clause — so a converged
  // tree's root carries status 'pruned', and an abandoned one's carries
  // 'failed'. Folding "the topmost abandoned node" from the root down then
  // selected the root itself and hid the entire search behind one dot.
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

  // Fixed-width faces stand in for the real one. The contract under test is
  // that the clip is decided by the ROOM; measuring a proportional face here
  // would make every expected string an assertion about Chrome's metrics.
  const perChar = (text: string) => text.length * 10;
  const wide = (text: string) => [...text].reduce((sum, ch) => sum + (ch === 'W' ? 20 : 5), 0);

  test('a label that fits its room is not touched', () => {
    expect(clipToWidth('abcd', 40, perChar)).toBe('abcd');
    expect(clipToWidth('abcd', 40.5, perChar)).toBe('abcd');
  });

  test('the ellipsis is inside the room, never beyond it', () => {
    // 10 chars want 100px; 50px holds four glyphs, so three survive plus the
    // ellipsis. A clip that spent the room on text and then appended would
    // overflow by exactly one glyph — which is how a label lands on its
    // neighbour's column.
    expect(clipToWidth('abcdefghij', 50, perChar)).toBe('abcd…');
    expect(clipToWidth('abcdefghij', 55, perChar)).toBe('abcd…');
    expect(clipToWidth('abcdefghij', 60, perChar)).toBe('abcde…');
  });

  test('room too small for even one glyph yields nothing, never a bare ellipsis', () => {
    expect(clipToWidth('abcdefghij', 10, perChar)).toBe('');
    expect(clipToWidth('abcdefghij', 0, perChar)).toBe('');
    expect(clipToWidth('abcdefghij', -5, perChar)).toBe('');
  });

  test('room is spent on the widest prefix that fits, not on a character count', () => {
    // `iiiiii` and `WWWWWW` are the same six characters and not the same label.
    expect(clipToWidth('WWWWWW', 45, wide)).toBe('WW…');
    expect(clipToWidth('iiiiii', 45, wide)).toBe('iiiiii');
  });
});

// ── viewNoteFor ─────────────────────────────────────────────────────────────
// A canvas that crops or de-labels itself without a word is how a narrow
// viewport reads as a broken picture (#206). The note names the two states
// that silently lose information: below the label-legibility zoom, and wider
// than the view. Legible AND fitting says nothing.

describe('viewNoteFor', () => {
	const BAND = { x0: 0, x1: 946 };

	test('a legible tree that fits says nothing', () => {
		expect(viewNoteFor(BAND, 1, 1200)).toBeNull();
		expect(viewNoteFor(BAND, LABEL_MIN_SCALE, 1200)).toBeNull();
	});

	test('below the legibility zoom it says so, even when everything fits', () => {
		expect(viewNoteFor(BAND, 0.4, 1200)).toBe('too small to label · zoom in to read');
	});

	test('a tree wider than the view points at the pan, even while legible', () => {
		expect(viewNoteFor(BAND, 1, 600)).toBe('deeper columns continue right · drag to pan');
	});

	test('both losses name both facts in one line', () => {
		expect(viewNoteFor(BAND, 0.4, 300)).toBe('too small to label · deeper columns pan right');
	});
});

// The fork list reads two stores nothing pushes. It must keep re-reading while
// a fork is being written, and must never fall permanently silent once the
// loaded snapshot looks settled — the workspace can start a NEW fork from a
// background job, a drain, or an autonomous turn this browser tab was never
// "streaming" for, and the old policy (stop polling entirely once nothing in
// view looked live) left the tab frozen on a prior attempt until the operator
// forced a remount. It still polls fast while work is visibly in flight, and
// slow otherwise — never zero.
//
// The adapter tests below pin the other half of the unification: a merge is a
// depth-1 tree that carries NO scores, so nothing downstream can draw it as a
// competition that picked a winner.
import { describe, test, expect } from 'bun:test';
import type { ForkRunSummary, HeadRunView } from '@proteus/core';
import {
  FORK_IDLE_REVALIDATE_MS, FORK_REVALIDATE_MS, forkRunsRevalidateMs, hasLiveForkRun,
  headRunToTree, findHead,
} from '../src/components/surfaces/fork-runs.ts';
import { isCompeted, principalVariation, maxVisits } from '../src/components/fork-tree-model.ts';

function summary(over: Partial<ForkRunSummary> = {}): ForkRunSummary {
  return {
    id: 'r1', task: 'compare X vs Y', startedAt: 0, status: 'completed',
    settle: 'merged', branches: 2, winnerScore: null, ...over,
  };
}

function headRun(over: Partial<HeadRunView> = {}): HeadRunView {
  return {
    rootId: 'root-1',
    task: 'compare X vs Y',
    rationale: 'two approaches worth trying',
    status: 'completed',
    spawnedAt: 0,
    heads: [
      {
        id: 'head-0', task: 'try X', rationale: 'r', status: 'completed',
        summary: 'X works', errorMessage: null,
        tokenInput: 10, tokenOutput: 5, wallClockMs: 100,
        toolCalls: [], decisions: [], steps: [],
      },
      {
        id: 'head-1', task: 'try Y', rationale: 'r', status: 'errored',
        summary: null, errorMessage: 'Y blew up',
        tokenInput: 3, tokenOutput: 0, wallClockMs: 20,
        toolCalls: [], decisions: [], steps: [],
      },
    ],
    merge: { narrative: 'X, with Y’s guard rail', headCount: 2, totalTokens: 18 },
    ...over,
  };
}

describe('live fork runs', () => {
  test('a run is live while it is still running, whichever way it settles', () => {
    expect(hasLiveForkRun([summary({ status: 'running' })])).toBe(true);
    expect(hasLiveForkRun([summary({ settle: 'competed', status: 'running' })])).toBe(true);
    // …and a live run anywhere in the list counts.
    expect(hasLiveForkRun([summary(), summary({ id: 'r2', status: 'running' })])).toBe(true);
  });

  test('a settled run — however it settled — is not live', () => {
    expect(hasLiveForkRun([summary({ status: 'completed' })])).toBe(false);
    expect(hasLiveForkRun([summary({ status: 'partial' }), summary({ status: 'failed' })])).toBe(false);
    expect(hasLiveForkRun([])).toBe(false);
    expect(hasLiveForkRun(null)).toBe(false);
  });
});

describe('fork revalidation policy', () => {
  test('a live fork keeps the view refreshing at the fast cadence', () => {
    expect(forkRunsRevalidateMs([summary({ status: 'running' })], false)).toBe(FORK_REVALIDATE_MS);
  });

  test('a turn in flight refreshes fast even before the first run exists', () => {
    expect(forkRunsRevalidateMs([], true)).toBe(FORK_REVALIDATE_MS);
    expect(forkRunsRevalidateMs(null, true)).toBe(FORK_REVALIDATE_MS);
  });

  test('an idle workspace with settled runs keeps polling — slowly, never zero', () => {
    expect(forkRunsRevalidateMs([summary()], false)).toBe(FORK_IDLE_REVALIDATE_MS);
    expect(forkRunsRevalidateMs([], false)).toBe(FORK_IDLE_REVALIDATE_MS);
    expect(forkRunsRevalidateMs(null, false)).toBe(FORK_IDLE_REVALIDATE_MS);
  });

  test('the idle cadence is strictly slower than the live one — a keep-fresh tick, not a poll storm', () => {
    expect(FORK_IDLE_REVALIDATE_MS).toBeGreaterThan(FORK_REVALIDATE_MS);
  });
});

describe('a merge is a tree of depth 1', () => {
  test('the split is the root and each head is a child', () => {
    const tree = headRunToTree(headRun());
    expect(tree.id).toBe('root-1');
    expect(tree.depth).toBe(0);
    expect(tree.children.map((c) => [c.id, c.depth, c.action]))
      .toEqual([['head-0', 1, 'try X'], ['head-1', 1, 'try Y']]);
  });

  test('no branch carries a score or a rollout count — the merge ranked none of them', () => {
    const tree = headRunToTree(headRun());
    for (const node of [tree, ...tree.children]) {
      expect(node.value).toBeNull();
      expect(node.visits).toBeNull();
    }
    expect(isCompeted(tree)).toBe(false);
    expect(maxVisits(tree)).toBe(0);
  });

  test('and therefore no winning line is drawn down an arbitrary head', () => {
    // Every comparison against null is false, so the naive walk would pick
    // children[0] at each level and paint a spine that means nothing.
    expect([...principalVariation(headRunToTree(headRun()))]).toEqual([]);
  });

  test('no head is ever terminal — a merge settles on all of them at once', () => {
    const tree = headRunToTree(headRun());
    expect(tree.children.map((c) => c.status)).toEqual(['open', 'failed']);
    expect(tree.children.some((c) => c.status === 'terminal')).toBe(false);
  });

  test('a running head keeps its own state, and so does the run', () => {
    const tree = headRunToTree(headRun({
      status: 'running',
      heads: [{
        id: 'h', task: 't', rationale: 'r', status: 'running', summary: null, errorMessage: null,
        tokenInput: 0, tokenOutput: 0, wallClockMs: 0, toolCalls: [], decisions: [], steps: [],
      }],
    }));
    expect(tree.status).toBe('running');
    expect(tree.children[0]!.status).toBe('running');
  });

  test('the merge narrative rides on the root, where the root is what is selected', () => {
    expect(headRunToTree(headRun()).observation).toBe('X, with Y’s guard rail');
  });

  test('a node maps back to the head behind it; the root maps to none', () => {
    const run = headRun();
    expect(findHead(run, 'head-1')?.errorMessage).toBe('Y blew up');
    expect(findHead(run, 'root-1')).toBeNull();
  });
});

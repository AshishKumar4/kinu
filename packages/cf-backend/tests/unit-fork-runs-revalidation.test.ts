// The fork list reads two stores nothing pushes: it polls fast while work is in flight and slow
// otherwise, never zero. A merge is a depth-1 tree with no scores, never drawn as a competition.
import { describe, test, expect } from 'bun:test';
import type {
  ExplorationCanvasRun, ForkRunParams, ForkRunSummary, HeadRunView, SearchRunParams,
} from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import {
  FORK_IDLE_REVALIDATE_MS, FORK_REVALIDATE_MS, forkRunsRevalidateMs, hasLiveForkRun,
  hasActiveForkWork, selectForkRun, forkParamRows, unexplainedForkRoots,
} from '../src/components/surfaces/fork-runs';
import { explorationForkTree } from '@kinu.run/core';
import { isCompeted, principalVariation, maxVisits } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

function summary(over: Partial<ForkRunSummary> = {}): ForkRunSummary {
  return {
    id: 'r1', name: 'X vs Y', task: 'compare X vs Y', startedAt: 0, status: 'completed',
    hasSearchTree: false, hasNodeTranscripts: true, branches: 2, winnerScore: null, ...over,
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
        id: 'head-0', parentId: null, depth: 1, task: 'try X', rationale: 'r', status: 'completed',
        summary: 'X works', errorMessage: null,
        usage: { input: 10, output: 5 }, wallClockMs: 100,
        spawnedAt: 0, lastStepAt: null, decisions: [],
      },
      {
        id: 'head-1', parentId: null, depth: 1, task: 'try Y', rationale: 'r', status: 'errored',
        summary: null, errorMessage: 'Y blew up',
        usage: { input: 3, output: 0 }, wallClockMs: 20,
        spawnedAt: 0, lastStepAt: null, decisions: [],
      },
    ],
    merge: { narrative: 'X, with Y’s guard rail', headCount: 2, totalTokens: 18 },
    ...over,
  };
}

function backgroundJob(status: BackgroundJob['status']): BackgroundJob {
  return {
    id: 'job-1', kind: 'tool', label: null, workMode: 'build', status, result: null, error: null,
    createdAt: 0, settledAt: null,
  };
}

describe('live fork runs', () => {
  test('a run is live while it is still running, whichever way it settles', () => {
    expect(hasLiveForkRun([summary({ status: 'running' })])).toBe(true);
    expect(hasLiveForkRun([summary({ hasSearchTree: true, status: 'running' })])).toBe(true);
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

  test('detached workspace work keeps revalidation live without a streaming chat turn', () => {
    expect(hasActiveForkWork(false, [backgroundJob('running')])).toBe(true);
    expect(hasActiveForkWork(false, [backgroundJob('completed')])).toBe(false);
    expect(hasActiveForkWork(true, [])).toBe(true);
  });

  // The canvas builds its bands from the polled list, so a stale list is an invisible search.
  describe('a search whose movement the list cannot explain', () => {
    const canvasRow = (over: Partial<ForkRunSummary>): ExplorationCanvasRun => ({
      run: summary(over), params: null, tree: [], head: null, frontier: null,
    });

    test('a root the list has never heard of is a new search', () => {
      const listed = [canvasRow({ id: 'known', status: 'running' })];
      expect(unexplainedForkRoots(listed, ['known', 'brand-new'])).toEqual(['brand-new']);
    });

    test('a root the list holds as RUNNING is explained and asks for nothing', () => {
      const listed = [canvasRow({ id: 'known', status: 'running' })];
      expect(unexplainedForkRoots(listed, ['known'])).toEqual([]);
    });

    test('a root the list believes is over is a RESUMED run', () => {
      // A resume reuses its rootId and flips a reclaimed row back to running, from any terminal
      // state.
      for (const status of ['completed', 'failed', 'partial'] as const) {
        expect(
          unexplainedForkRoots([canvasRow({ id: 'again', status })], ['again']),
          `a ${status} row that moved should be a re-read`,
        ).toEqual(['again']);
      }
    });

    test('the answer is sorted and deduplicated, so it can be a memo key', () => {
      // Two orderings of the same set must compare equal, or every journal write is a fresh read.
      const listed = [canvasRow({ id: 'known', status: 'running' })];
      expect(unexplainedForkRoots(listed, ['b', 'a', 'b'])).toEqual(['a', 'b']);
      expect(unexplainedForkRoots(listed, ['b', 'a'])).toEqual(['a', 'b']);
    });

    test('nothing is unexplained before the list has answered at all', () => {
      // Re-reading a read already in flight would loop it.
      expect(unexplainedForkRoots(null, ['anything'])).toEqual([]);
    });
  });

});

describe('fork permalink selection', () => {
  const runs = [summary({ id: 'new' }), summary({ id: 'old' })];

  test('an explicit unknown id never renders a different run', () => {
    expect(selectForkRun(runs, 'missing')).toBeNull();
  });

  test('the newest run is the default only when no id was requested', () => {
    expect(selectForkRun(runs, null)?.id).toBe('new');
    expect(selectForkRun(runs, 'old')?.id).toBe('old');
  });

  test('loading and empty resources resolve to no selection', () => {
    expect(selectForkRun(null, 'new')).toBeNull();
    expect(selectForkRun([], null)).toBeNull();
  });
});

function journalTree(run: HeadRunView) {
  return present(explorationForkTree({ tree: [], head: run }), 'the folded fork tree');
}

describe('a merge is a tree of depth 1', () => {
  test('the split is the root and each head is a child', () => {
    const tree = journalTree(headRun());
    expect(tree.id).toBe('root-1');
    expect(tree.depth).toBe(0);
    expect(tree.children.map((c) => [c.id, c.depth, c.action]))
      .toEqual([['head-0', 1, 'try X'], ['head-1', 1, 'try Y']]);
  });

  test('no branch carries a score or a rollout count — the merge ranked none of them', () => {
    const tree = journalTree(headRun());

    for (const node of [tree, ...tree.children]) {
      expect(node.value).toBeNull();
      expect(node.visits).toBeNull();
    }

    expect(isCompeted(tree)).toBe(false);
    expect(maxVisits(tree)).toBe(0);
  });

  test('and therefore no winning line is drawn down an arbitrary head', () => {
    // Every comparison against null is false, so a naive walk would paint a meaningless spine.
    expect([...principalVariation(journalTree(headRun()))]).toEqual([]);
  });

  test('no head is ever terminal — a merge settles on all of them at once', () => {
    const tree = journalTree(headRun());
    expect(tree.children.map((c) => c.status)).toEqual(['open', 'failed']);
    expect(tree.children.some((c) => c.status === 'terminal')).toBe(false);
  });

  test('a running head keeps its own state, and so does the run', () => {
    const tree = journalTree(headRun({
      status: 'running',
      heads: [{
        id: 'h', parentId: null, depth: 1, task: 't', rationale: 'r', status: 'running', summary: null, errorMessage: null,
        usage: {}, wallClockMs: 0, spawnedAt: 0, lastStepAt: null, decisions: [],
      }],
    }));

    expect(tree.status).toBe('running');
    expect(tree.children[0].status).toBe('running');
  });

  test('the merge narrative rides on the root, where the root is what is selected', () => {
    expect(journalTree(headRun()).observation).toBe('X, with Y’s guard rail');
  });
});

// `judgeSamples` is a request, capped by the per-evaluation call budget shared with check
// generation: a strip rendering the request alone overstates what ran.
describe('the judges row names what the search actually ran', () => {
  function searched(over: Partial<SearchRunParams> = {}): ForkRunParams {
    return {
      rootId: 'r1',
      search: {
        budget: 8, branches: 3, maxDepth: null, explorationWeight: null,
        judgeSamplesRequested: 3, judgeSamplesRealised: 3, mode: null, ...over,
      },
      transcripts: null,
    };
  }

  test('a clamped ensemble names both numbers, realised first', () => {
    const rows = forkParamRows(searched({ judgeSamplesRequested: 20, judgeSamplesRealised: 3 }));
    expect(rows.find((row) => row.label === 'judges')?.value).toBe('3 of 20 requested');
  });

  test('an unrecoverable realised size is not reported as an honoured request', () => {
    // No ensemble was observed, so the realised size is unknown: say "requested", no per-branch
    // claim.
    const rows = forkParamRows(searched({ judgeSamplesRequested: 20, judgeSamplesRealised: null }));
    expect(rows.find((row) => row.label === 'judges')?.value).toBe('20 requested');
  });

  test('a request the budget funded reads as the plain per-branch figure', () => {
    const rows = forkParamRows(searched());
    expect(rows.find((row) => row.label === 'judges')?.value).toBe('3 per branch');
  });

  test('a run whose request was never recorded shows no judges row at all', () => {
    const rows = forkParamRows(searched({ judgeSamplesRequested: null, judgeSamplesRealised: null }));
    expect(rows.some((row) => row.label === 'judges')).toBe(false);
  });
});

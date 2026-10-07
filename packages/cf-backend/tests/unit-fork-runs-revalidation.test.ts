// The fork list reads two stores nothing pushes, so it must know when a search moved that it cannot explain. Permalinks,
// merges and new searches are proved in tests/browser/swarm-tree-geometry.test.ts.
import { describe, test, expect } from 'bun:test';
import type { ExplorationCanvasRun, ForkRunSummary } from '@kinu.run/core';
import { hasLiveForkRun, unexplainedForkRoots } from '../src/components/surfaces/fork-runs';

function summary(over: Partial<ForkRunSummary> = {}): ForkRunSummary {
  return {
    id: 'r1', name: 'X vs Y', task: 'compare X vs Y', startedAt: 0, status: 'completed',
    hasSearchTree: false, hasNodeTranscripts: true, branches: 2, winnerScore: null, ...over,
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


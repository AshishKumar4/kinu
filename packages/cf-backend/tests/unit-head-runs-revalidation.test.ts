// The Branches view reads a journal nothing pushes. It must keep re-reading
// while a split is being written, and must never fall permanently silent once
// the loaded snapshot looks settled — the workspace can start a NEW split from
// a background job, a drain, or an autonomous turn this browser tab was never
// "streaming" for, and the old policy (stop polling entirely once nothing in
// view looked live) left the tab frozen on a prior attempt until the operator
// forced a remount. It still polls fast while work is visibly in flight, and
// slow otherwise — never zero.
import { describe, test, expect } from 'bun:test';
import type { HeadRunView } from '@proteus/core';
import {
  BRANCHES_IDLE_REVALIDATE_MS, BRANCHES_REVALIDATE_MS, branchesRevalidateMs, hasLiveHeadRun,
} from '../src/components/surfaces/head-runs.ts';

function run(status: string, headStatuses: string[]): HeadRunView {
  return {
    rootId: `root-${status}`,
    task: 'compare X vs Y',
    rationale: '',
    status,
    spawnedAt: 0,
    heads: headStatuses.map((headStatus, i) => ({
      id: `head-${i}`, task: 't', rationale: 'r', status: headStatus,
      summary: null, errorMessage: null,
      tokenInput: 0, tokenOutput: 0, wallClockMs: 0,
      toolCalls: [], decisions: [], steps: [],
    })),
    merge: null,
  };
}

describe('live head runs', () => {
  test('a run is live while it, or any of its heads, is still running', () => {
    expect(hasLiveHeadRun([run('running', ['running', 'running'])])).toBe(true);
    // The run header settles before the last head does.
    expect(hasLiveHeadRun([run('partial', ['completed', 'running'])])).toBe(true);
    // …and a live run anywhere in the list counts.
    expect(hasLiveHeadRun([run('completed', ['completed']), run('running', ['running'])])).toBe(true);
  });

  test('a run whose heads have all settled — however they settled — is not live', () => {
    expect(hasLiveHeadRun([run('completed', ['completed', 'completed'])])).toBe(false);
    expect(hasLiveHeadRun([run('partial', ['errored', 'budget_exceeded', 'aborted'])])).toBe(false);
    expect(hasLiveHeadRun([])).toBe(false);
    expect(hasLiveHeadRun(null)).toBe(false);
  });
});

describe('branches revalidation policy', () => {
  test('a live split keeps the view refreshing at the fast cadence', () => {
    expect(branchesRevalidateMs([run('running', ['running'])], false)).toBe(BRANCHES_REVALIDATE_MS);
  });

  test('a turn in flight refreshes fast even before the first run exists', () => {
    // The split that is about to start is what the operator opened the tab for.
    expect(branchesRevalidateMs([], true)).toBe(BRANCHES_REVALIDATE_MS);
    expect(branchesRevalidateMs(null, true)).toBe(BRANCHES_REVALIDATE_MS);
  });

  test('an idle workspace with settled runs keeps polling — slowly, never zero', () => {
    // This is the regression: a split can start from work this tab never
    // observes as "streaming" (a background job, a drain, an autonomous
    // turn). A view that stops polling here never finds out.
    expect(branchesRevalidateMs([run('completed', ['completed'])], false)).toBe(BRANCHES_IDLE_REVALIDATE_MS);
    expect(branchesRevalidateMs([], false)).toBe(BRANCHES_IDLE_REVALIDATE_MS);
    // A failed load with nothing ever loaded still keeps trying.
    expect(branchesRevalidateMs(null, false)).toBe(BRANCHES_IDLE_REVALIDATE_MS);
  });

  test('the idle cadence is strictly slower than the live one — it is a keep-fresh tick, not a poll storm', () => {
    expect(BRANCHES_IDLE_REVALIDATE_MS).toBeGreaterThan(BRANCHES_REVALIDATE_MS);
  });
});

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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForkRunParams, ForkRunSummary, HeadRunView, SearchRunParams } from '@proteus/core';
import type { BackgroundJob } from '../src/lib/protocol';
import {
  FORK_IDLE_REVALIDATE_MS, FORK_REVALIDATE_MS, forkRunsRevalidateMs, hasLiveForkRun,
  hasActiveForkWork, headRunToTree, selectForkRun, forkParamRows,
} from '../src/components/surfaces/fork-runs';
import { isCompeted, principalVariation, maxVisits } from '../src/components/swarm-tree-model';

function summary(over: Partial<ForkRunSummary> = {}): ForkRunSummary {
  return {
    id: 'r1', task: 'compare X vs Y', startedAt: 0, status: 'completed',
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
        id: 'head-0', task: 'try X', rationale: 'r', status: 'completed',
        summary: 'X works', errorMessage: null,
        usage: { input: 10, output: 5 }, wallClockMs: 100,
        spawnedAt: 0, lastStepAt: null, decisions: [], steps: [],
      },
      {
        id: 'head-1', task: 'try Y', rationale: 'r', status: 'errored',
        summary: null, errorMessage: 'Y blew up',
        usage: { input: 3, output: 0 }, wallClockMs: 20,
        spawnedAt: 0, lastStepAt: null, decisions: [], steps: [],
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

  test('detached workspace work keeps revalidation live without a streaming chat turn', () => {
    expect(hasActiveForkWork(false, [backgroundJob('running')])).toBe(true);
    expect(hasActiveForkWork(false, [backgroundJob('completed')])).toBe(false);
    expect(hasActiveForkWork(true, [])).toBe(true);
  });

  test('the canvas and the full-page explorer read the resources they claim to', () => {
    const source = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');
    const embedded = source('src/components/surfaces/ExplorationSurface.tsx');
    const fullPage = source('src/pages/MCTSExplorer.tsx');
    const workSurface = source('src/components/surfaces/WorkSurface.tsx');

    // The embedded surface draws EVERY tree, so it reads the canvas projection —
    // one request carrying the runs, their dispatch parameters and every tree's
    // rows. The full page drills into one run and needs only the list.
    expect(embedded).toContain('useExplorationCanvas(rpc, isStreaming, backgroundJobs, liveTrees)');
    expect(embedded).not.toContain('useLiveForkRuns(');
    expect(fullPage).toMatch(/useLiveForkRuns\(\s*state\.rpc,\s*state\.isStreaming,\s*state\.backgroundJobs,?\s*\)/);
    expect(workSurface).toContain('backgroundJobs={props.backgroundJobs}');

    // Live trees are keyed by search on both paths: one slot let two concurrent
    // searches overwrite each other's tree.
    expect(workSurface).toContain('liveTrees={props.mctsTrees}');
    expect(fullPage).toContain('state.mctsTrees.get(run.id) ?? null');

    // The full page's failure copy says "exploration runs" and the embedded surface
    // still says "fork runs": the strings moved with the surface's vocabulary when
    // the fork verb left the delegation surface, and the invariant this pins is that
    // BOTH read a failure through `LoadFailure` rather than swallowing one.
    expect(embedded).toContain('<LoadFailure what="fresh fork runs"');
    expect(fullPage).toContain('<LoadFailure what="fresh exploration runs"');
    expect(fullPage).toContain('<LoadFailure what="the latest fork tree"');
    // Paged reads are consumed as pages. `listForkRuns` answers a `Page` and a bare
    // limit is not a `PageRequest`, so the hook may not ask for an array: it did,
    // and `Page` has no `some`, so the revalidation clock threw on the first
    // successful load against a real server.
    expect(source('src/components/surfaces/fork-runs.ts'))
      .toContain('rpc<Page<ForkRunSummary>>("listForkRuns", [{ limit: FORK_RUN_LIMIT }])');
    expect(embedded).not.toContain('rpc<ForkRunSummary[]>("listForkRuns"');
    expect(fullPage).not.toContain('rpc<ForkRunSummary[]>("listForkRuns"');
    expect(fullPage).toContain('useExactForkRun(state.rpc, runId, hasActiveWork)');
  });

  test('a branch opens BESIDE the canvas, never over it', () => {
    const embedded = readFileSync(
      join(import.meta.dir, '..', 'src/components/surfaces/ExplorationSurface.tsx'), 'utf8',
    );
    // A branch click sets the selection, and the selection opens a THIRD pane.
    // It used to replace the canvas — `opened ? <ForkBranchView …> : <ForkCanvas …>`
    // — which answered "what did this branch do" by taking away the tree that
    // gave the answer its place. Both are mounted now, so neither ternary may
    // come back.
    expect(embedded).toContain('<ForkBranchView');
    expect(embedded).toContain('<ForkCanvas');
    expect(embedded).not.toContain(': <ForkCanvas');
    // Three columns at the width that fits them: runs, canvas, branch.
    expect(embedded).toMatch(/@6xl:grid-cols-\[[^\]]+_[^\]]+_[^\]]+\]/);
    // Closed, not navigated back: there is nothing to go back to.
    expect(embedded).toContain('onClose={() => setSelection(null)}');
    expect(embedded).not.toContain('BranchInspector');
    // A branch's behaviour is read through the ONE transcript component, which
    // renders every step with the main chat's own `MessageView`. The card this
    // replaced (`HeadTrace`/`StepRow`, clamping reasoning to three lines and
    // tool output to 160 characters) is gone rather than left beside it.
    expect(embedded).toContain('<NodeTranscript');
    // The second renderer is deleted, not merely unreferenced. `useForkRunDetail`
    // legitimately still reads `getHeadRun` — the CANVAS folds a merged run's
    // journal into a tree — so what is pinned here is the absence of the trace
    // components, which is the duplication that mattered.
    expect(embedded).not.toContain('HeadTrace');
    expect(embedded).not.toContain('StepRow');

    const transcript = readFileSync(
      join(import.meta.dir, '..', 'src/components/NodeTranscript.tsx'), 'utf8',
    );
    // One renderer, not two: the steps go through the chat's component, and the
    // user affordances are absent because they are simply not passed.
    expect(transcript).toContain('import { MessageView } from "@/components/MessageView"');
    expect(transcript).toContain('<MessageView');
    for (const affordance of ['onFork', 'onFeedback', 'onRestoreFiles', 'takesChip']) {
      expect(transcript).not.toContain(`${affordance}=`);
    }
    // One read model, not a client-side choice of store.
    expect(transcript).toContain('rpc<NodeTranscriptView | null>("getNodeTranscript", [runId, nodeId])');
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
        usage: {}, wallClockMs: 0, spawnedAt: 0, lastStepAt: null, decisions: [], steps: [],
      }],
    }));
    expect(tree.status).toBe('running');
    expect(tree.children[0]!.status).toBe('running');
  });

  test('the merge narrative rides on the root, where the root is what is selected', () => {
    expect(headRunToTree(headRun()).observation).toBe('X, with Y’s guard rail');
  });
});

// The invisible spend ceiling (2026-08-18): `judgeSamples` is a REQUEST, capped
// by the per-evaluation call budget it shares with check generation. This strip
// used to render the request alone, so a search that asked for 20 judges and ran
// 3 read as a search that ran 20.
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
    // No candidate's ensemble was ever observed, so the realised size is unknown.
    // Unknown says "requested" and makes no per-branch claim: "20 per branch" would
    // assert the very thing that cannot be known here.
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

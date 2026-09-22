/**
 * Swarm model recovered from the store: a named preset resolves to its tuple (`settle` derived; an
 * unconstructible row is a third case); fan-in vertices are identified by `strategy/swarm-run.ts`'s
 * rationale; a run that reached nothing carries a refusal, reason first.
 */

import { describe, test, expect } from 'bun:test';
import type { HeadRunView } from '@kinu.run/core';
import {
  fanInArity, fanInVertices, formatEvidenceValue, nodeRationales, runLiveness, runRefusal, swarmAxisRows,
  swarmResolutionOf,
} from '@kinu.run/core';

type JournalNode = HeadRunView['heads'][number];

function node(id: string, rationale: string, errorMessage: string | null = null): JournalNode {
  return {
    id, parentId: null, depth: 1, task: 'reduce p95', rationale,
    status: errorMessage === null ? 'completed' : 'errored',
    summary: null, errorMessage, usage: {}, wallClockMs: 1,
    spawnedAt: 1, lastStepAt: null, decisions: [],
  };
}

/** A node at a chosen lifecycle point, as a live run's journal holds it. */
function liveNode(
  id: string, status: string, at: Partial<Pick<JournalNode, 'depth' | 'spawnedAt' | 'lastStepAt' | 'summary' | 'errorMessage'>> = {},
): JournalNode {
  return {
    ...node(id, 'expansion'), status,
    depth: at.depth ?? 1,
    spawnedAt: at.spawnedAt ?? 1_000,
    lastStepAt: at.lastStepAt ?? null,
    summary: at.summary ?? null,
    errorMessage: at.errorMessage ?? null,
  };
}

function journal(nodes: readonly JournalNode[]): HeadRunView {
  return {
    rootId: 'r1', task: 'reduce p95', rationale: 'optimise', status: 'completed',
    spawnedAt: 1, heads: nodes, merge: null,
  };
}

describe('the resolution a run resolved', () => {
  test('a named preset resolves to its tuple, and settle is derived from it', () => {
    const resolution = swarmResolutionOf('prove');
    expect(resolution).toMatchObject({ kind: 'preset', preset: 'prove', settle: 'best' });
    expect(resolution?.kind === 'preset' ? swarmAxisRows(resolution.config) : []).toEqual([
      { axis: 'unit', value: 'answer' },
      { axis: 'context', value: 'inherit' },
      { axis: 'expand', value: 'sample' },
      { axis: 'score', value: 'verify' },
      { axis: 'advance', value: 'best-first' },
      { axis: 'carry', value: 'artifacts ≥1' },
    ]);
  });

  test('a preset with no selector and no score derives settle=merge, not settle=best', () => {
    expect(swarmResolutionOf('ideate')).toMatchObject({ kind: 'preset', settle: 'merge' });
  });

  test('every named preset resolves, so redteam has an archive floor to show', () => {
    // `redteam`'s archive novelty floor is Rainbow Teaming's τ=0.6 converted from a similarity
    // ceiling to a distance floor.
    const resolution = swarmResolutionOf('redteam');
    expect(resolution?.kind).toBe('preset');
    expect(resolution?.kind === 'preset' ? swarmAxisRows(resolution.config) : []).toContainEqual(
      { axis: 'advance', value: 'archive ≥0.4' },
    );
  });

  test('a label that names no preset is a composition, carried as its provenance label', () => {
    expect(swarmResolutionOf('conflict-reconciling ensemble'))
      .toEqual({ kind: 'custom', label: 'conflict-reconciling ensemble' });
  });

  test('no label is no resolution — absent, never a composition with an empty name', () => {
    expect(swarmResolutionOf(null)).toBeNull();
    expect(swarmResolutionOf('')).toBeNull();
    expect(swarmResolutionOf('   ')).toBeNull();
  });

  test('a judged composition prints its ensemble on the axis that owns it', () => {
    expect(swarmAxisRows({
      unit: { kind: 'answer' }, context: 'inherit', expand: 'aggregate',
      score: { kind: 'judge', samples: 20 },
      advance: { kind: 'archive', novelty: 0.6 },
      carry: { kind: 'reflections', threshold: 0.4 },
    })).toEqual([
      { axis: 'unit', value: 'answer' },
      { axis: 'context', value: 'inherit' },
      { axis: 'expand', value: 'aggregate' },
      { axis: 'score', value: 'judge ×20' },
      { axis: 'advance', value: 'archive ≥0.6' },
      { axis: 'carry', value: 'reflections ≥0.4' },
    ]);
  });
});

describe('the fan-in vertex, read out of the rationale the engine writes', () => {
  test('the vertex rationale swarm-run spawns yields its arity', () => {
    // Verbatim from `strategy/swarm-run.ts`'s `spawnMergeNode`. If that sentence
    // moves, this is the test that says so.
    expect(fanInArity('fan-in over 3 parents of depth 1')).toBe(3);
    expect(fanInArity('fan-in over 12 parents of depth 4')).toBe(12);
  });

  test('a sampled sibling is not a vertex, however it was worded', () => {
    expect(fanInArity('expansion 2 of 3')).toBeNull();
    expect(fanInArity('the strongest accepted line so far')).toBeNull();
    expect(fanInArity(null)).toBeNull();
    // The engine refuses a fan-in over one parent, so a count below two is a misread.
    expect(fanInArity('fan-in over 1 parents of depth 2')).toBeNull();
    expect(fanInArity('reconcile the fan-in over 3 parents we saw earlier')).toBeNull();
  });

  test('a run reports every vertex and its arity, and no sibling', () => {
    const vertices = fanInVertices(journal([
      node('a', 'expansion 1 of 3'),
      node('b', 'fan-in over 3 parents of depth 1'),
      node('c', 'fan-in over 2 parents of depth 2'),
    ]));

    expect([...vertices]).toEqual([['b', 3], ['c', 2]]);
  });

  test('a run with no journal fans in nothing rather than throwing', () => {
    expect(fanInVertices(null).size).toBe(0);
    expect(nodeRationales(null).size).toBe(0);
  });

  test("each node's own reason survives verbatim, and an unlabelled node is absent", () => {
    const why = nodeRationales(journal([
      node('a', 'expansion 1 of 2'),
      node('b', '   '),
    ]));

    expect(why.get('a')).toBe('expansion 1 of 2');
    expect(why.has('b')).toBe(false);
  });
});

describe('a run that reached nothing reads as a refusal', () => {
  test("a failed run names a BRANCH's own cause, not the ledger's class", () => {
    expect(runRefusal(
      { status: 'failed', branches: 3 },
      journal([node('a', 'expansion 1 of 3', 'the workspace filesystem has no credential')]),
    )).toEqual({ reason: 'failed', error: 'the workspace filesystem has no credential' });
  });

  test('a failed run whose journal recorded no message says so instead of inventing one', () => {
    const refusal = runRefusal({ status: 'failed', branches: 0 }, null);
    expect(refusal?.reason).toBe('failed');
    expect(refusal?.error).toContain('no branch recorded a cause');
  });

  test('stopping without an answer is a different reason from failing', () => {
    expect(runRefusal({ status: 'partial', branches: 4 }, null)?.reason).toBe('stopped');
  });

  test('a settled run that expanded nothing is a refusal, not an empty tree', () => {
    expect(runRefusal({ status: 'completed', branches: 0 }, null)?.reason).toBe('no_branch');
  });

  test('a settled run with branches, and a running one, carry no refusal', () => {
    expect(runRefusal({ status: 'completed', branches: 9 }, null)).toBeNull();
    // Running has not reached anything yet, which is not having reached nothing.
    expect(runRefusal({ status: 'running', branches: 0 }, null)).toBeNull();
  });
});

/** `runRefusal` is null while running; this progress fact is computed from the journal, not the status word. */
describe('what a running search says about itself', () => {
  test('the counts are per node lifecycle, not the run status word', () => {
    const live = runLiveness(
      journal([
        liveNode('a', 'running'), liveNode('b', 'running'),
        liveNode('c', 'completed', { summary: 'found the null kind' }),
        liveNode('d', 'errored', { errorMessage: 'provider refused' }),
        liveNode('e', 'aborted', { errorMessage: 'operator stopped it' }),
      ]),
    );

    expect(live).toMatchObject({ running: 2, reported: 1, failed: 2, total: 5 });
  });

  test('the newest event is the newest STEP, and a node that never stepped falls back to its spawn', () => {
    // A run whose only moving node has stepped is live at that step, not at a sibling's spawn.
    const live = runLiveness(journal([
      liveNode('a', 'running', { spawnedAt: 1_000, lastStepAt: 9_000 }),
      liveNode('b', 'running', { spawnedAt: 4_000, lastStepAt: null }),
    ]));

    expect(live?.lastEventAt).toBe(9_000);

    const unstarted = runLiveness(journal([
      liveNode('b', 'running', { spawnedAt: 4_000, lastStepAt: null }),
    ]));

    expect(unstarted?.lastEventAt).toBe(4_000);
  });

  test('levels come from the journal depth, so a deeper search is not flattened', () => {
    const live = runLiveness(journal([
      liveNode('a', 'completed', { depth: 1 }), liveNode('b', 'completed', { depth: 1 }),
      liveNode('c', 'running', { depth: 2 }), liveNode('d', 'running', { depth: 2 }),
    ]));

    expect(live?.levels).toEqual([
      { depth: 1, running: 0, reported: 2, failed: 0, total: 2 },
      { depth: 2, running: 2, reported: 0, failed: 0, total: 2 },
    ]);
  });

  test('a settled run still reports its shape — the panel is not a running-only widget', () => {
    const live = runLiveness(journal([
      liveNode('a', 'completed'), liveNode('b', 'completed'),
    ]));

    expect(live).toMatchObject({ running: 0, reported: 2, failed: 0, total: 2 });
  });

  test('no journal is no liveness — never a row of zeroes', () => {
    // Zeroes would falsely read as idle nodes; absence is absence.
    expect(runLiveness(null)).toBeNull();
    expect(runLiveness(journal([]))).toBeNull();
  });

  test('an unrecognised status counts as neither reported nor failed, and never as running', () => {
    const live = runLiveness(journal([
      liveNode('a', 'interrupted'),
    ]));

    expect(live).toMatchObject({ running: 0, reported: 0, failed: 0, total: 1 });
  });
});

describe('a frontier value in its own unit', () => {
  const valueCases = [
    { name: 'integers print whole — a cost of 10 is not 1000%', values: [[10, '10'], [0, '0']] },
    { name: 'fractions trim without trailing zeroes', values: [[0.9, '0.9'], [0.333333, '0.333']] },
  ] as const;

  for (const { name, values } of valueCases) {
    test(name, () => {
      for (const [value, printed] of values) expect(formatEvidenceValue(value)).toBe(printed);
    });
  }
});

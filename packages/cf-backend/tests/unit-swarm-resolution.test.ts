/**
 * The shipped swarm model, as the surface recovers it from what the store kept.
 *
 * Three contracts, and each of them is a fact the surface would otherwise have to
 * invent:
 *
 *   1. A NAMED PRESET resolves to its tuple, and `settle` is derived from two of
 *      those axes rather than read off a column. A preset whose row cannot be
 *      constructed as printed is a THIRD case, not an empty tuple.
 *   2. A fan-in vertex is identified by the rationale `strategy/swarm-run.ts` spawns
 *      it with. That sentence is the only record of an `expand:'aggregate'` edge
 *      that reaches a client, so the parser is pinned against it verbatim — and
 *      against the sampled sibling's rationale, which must NOT read as a vertex.
 *   3. A run that reached nothing carries a refusal, reason FIRST, and the cause is
 *      a branch's own message wherever one recorded it.
 */

import { describe, test, expect } from 'bun:test';
import type { HeadRunView } from '@kinu/core';
import {
  fanInArity, fanInVertices, nodeRationales, runRefusal, swarmAxisRows, swarmResolutionOf,
} from '../src/components/surfaces/swarm-resolution';

/** One journalled node, at the resolution the wire carries. */
type JournalNode = HeadRunView['heads'][number];

function node(id: string, rationale: string, errorMessage: string | null = null): JournalNode {
  return {
    id, task: 'reduce p95', rationale,
    status: errorMessage === null ? 'completed' : 'errored',
    summary: null, errorMessage, usage: {}, wallClockMs: 1,
    spawnedAt: 1, lastStepAt: null, decisions: [], steps: [],
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
    // The tuple, not the name: the same name resolving differently is the thing a
    // reader needs to see, so every axis is present and each carries its own
    // parameter.
    expect(resolution?.kind === 'preset' ? swarmAxisRows(resolution.config) : []).toEqual([
      { axis: 'unit', value: 'generator' },
      { axis: 'context', value: 'fork' },
      { axis: 'expand', value: 'sample' },
      { axis: 'score', value: 'verify' },
      { axis: 'advance', value: 'best-first' },
      { axis: 'carry', value: 'artifacts ≥1' },
    ]);
  });

  test('a preset with no selector and no score derives settle=merge, not settle=best', () => {
    expect(swarmResolutionOf('ideate')).toMatchObject({ kind: 'preset', settle: 'merge' });
  });

  test('an UNDECLARED row is a third case and quotes what the table has not stated', () => {
    const resolution = swarmResolutionOf('redteam');
    expect(resolution?.kind).toBe('undeclared');
    // Not an empty tuple: an empty axis list reads as "the axes are unknown", and
    // what is true is that this row cannot be constructed as printed.
    expect(resolution?.kind === 'undeclared' ? resolution.undeclared : '').toContain('novelty rejection test');
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
    // Tagged onto `judge`, so the axis row carries it rather than a field beside it.
    expect(swarmAxisRows({
      unit: { kind: 'answer' }, context: 'fork', expand: 'aggregate',
      score: { kind: 'judge', samples: 20 },
      advance: { kind: 'archive', novelty: 0.6 },
      carry: { kind: 'reflections', threshold: 0.4 },
    })).toEqual([
      { axis: 'unit', value: 'answer' },
      { axis: 'context', value: 'fork' },
      { axis: 'expand', value: 'aggregate' },
      { axis: 'score', value: 'judge ×20' },
      { axis: 'advance', value: 'archive τ0.6' },
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
    // The engine refuses to relabel a fan-in over one parent, so a count below two
    // is this parser misreading a sentence rather than a vertex it has found.
    expect(fanInArity('fan-in over 1 parents of depth 2')).toBeNull();
    // A prose mention is not the engine's own record of a vertex.
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
    expect(refusal?.error).toContain('no branch carried a cause');
  });

  test('stopping without an answer is a different reason from failing', () => {
    expect(runRefusal({ status: 'partial', branches: 4 }, null)?.reason).toBe('stopped');
  });

  test('a settled run that expanded nothing is a refusal, not an empty tree', () => {
    expect(runRefusal({ status: 'completed', branches: 0 }, null)?.reason).toBe('no_branch');
  });

  test('a settled run with branches, and a running one, carry no refusal', () => {
    expect(runRefusal({ status: 'completed', branches: 9 }, null)).toBeNull();
    // Running is not refused: it has not reached anything YET, which is a different
    // claim from having reached nothing.
    expect(runRefusal({ status: 'running', branches: 0 }, null)).toBeNull();
  });
});

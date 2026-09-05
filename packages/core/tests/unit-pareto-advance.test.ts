import { describe, expect, test } from 'bun:test';
import {
  paretoFront, paretoObjectiveAxes, validateParetoEvidence,
  type InstancedObjective, type VectorObjective,
} from '../src/strategy/objective';
import { regionRefusal, seedResumedSearch } from '../src/strategy/swarm-setup';
import type { SwarmReentry } from '../src/strategy/swarm-resume';
import type { TreeNode } from '../src/strategy/swarm-tree';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';

const INSTANCED: InstancedObjective = {
  kind: 'instanced', metric: 'held-out score', unit: 'fraction', direction: 'maximise',
  scale: 'linear', target: 1, instances: ['a', 'b'], verify: { kind: 'exec-ratio', spec: {} },
};
const VECTOR: VectorObjective = {
  kind: 'vector',
  components: [
    { ...INSTANCED, kind: 'scalar', metric: 'quality', direction: 'maximise' },
    { ...INSTANCED, kind: 'scalar', metric: 'cost', direction: 'minimise' },
  ],
};

describe('Pareto advance evidence', () => {
  test('returns exactly the nondominated candidates in deterministic candidate order', () => {
    const axes = paretoObjectiveAxes(INSTANCED);
    if ('reason' in axes) throw new Error(axes.reason);
    expect(paretoFront(axes.axes, [
      { id: 'trade-quality', evidence: { a: 0.9, b: 0.2 } },
      { id: 'dominated', evidence: { a: 0.4, b: 0.1 } },
      { id: 'trade-coverage', evidence: { a: 0.2, b: 0.9 } },
      { id: 'equal', evidence: { a: 0.9, b: 0.2 } },
    ]).map((candidate) => candidate.id)).toEqual(['trade-quality', 'trade-coverage', 'equal']);
  });
  test('honours each declared vector direction instead of assuming maximise', () => {
    const axes = paretoObjectiveAxes(VECTOR);
    if ('reason' in axes) throw new Error(axes.reason);
    expect(paretoFront(axes.axes, [
      { id: 'high-quality-expensive', evidence: { quality: 0.9, cost: 10 } },
      { id: 'lower-quality-cheap', evidence: { quality: 0.8, cost: 2 } },
      { id: 'worse-both', evidence: { quality: 0.7, cost: 12 } },
    ]).map((candidate) => candidate.id)).toEqual(['high-quality-expensive', 'lower-quality-cheap']);
  });
  test('refuses missing, extra, and nonfinite evidence rather than assigning a default score', () => {
    const axes = paretoObjectiveAxes(INSTANCED);
    if ('reason' in axes) throw new Error(axes.reason);
    expect(validateParetoEvidence(axes.axes, { a: 0.2 })).toMatchObject({ reason: expect.stringContaining('missing') });
    expect(validateParetoEvidence(axes.axes, { a: 0.2, b: 0.4, invented: 1 })).toMatchObject({ reason: expect.stringContaining('undeclared') });
    expect(validateParetoEvidence(axes.axes, { a: 0.2, b: Number.NaN })).toMatchObject({ reason: expect.stringContaining('non-finite') });
  });

  test('restores durable Pareto evidence before selecting a resumed tree', () => {
    const root: TreeNode = {
      id: 'root', parentId: null, depth: 0, artifact: null, measurement: null, score: 0,
      pareto: null, proposal: null, proposalError: null, granted: null, conclusion: null,
      transcript: [], compacted: null, aggregated: [],
    };
    const evidence = { a: 0.8, b: 0.4 };
    const reentry: SwarmReentry = {
      rootId: 'root',
      epoch: 1,
      superseded: [],
      pending: [],
      profile: null,
      originContext: [],
      nodes: [
        { id: 'root', parentId: null, depth: 0, artifact: '', record: null, merged: false, produced: [] },
        {
          id: 'child', parentId: 'root', depth: 1, artifact: 'answer', merged: false, produced: [],
          record: {
            outcome: {
              kind: 'pareto',
              axes: [{ id: 'a', direction: 'maximise' }, { id: 'b', direction: 'maximise' }],
              evidence,
              detail: 'measured',
            },
            conclusion: null,
            aggregated: [],
            tokens: null,
          },
        },
      ],
    };
    const nodes = new Map([[root.id, root]]);
    const seeded = seedResumedSearch({
      reentry,
      nodes,
      rankDirection: 'maximise',
      spentBy: new Map(),
    });
    expect(seeded.candidates[0]?.pareto).toEqual(evidence);
    expect(nodes.get('child')?.pareto).toEqual(evidence);
  });
});

describe('Pareto advance with a publishing carry', () => {
  test('both entry points refuse elites and artifacts as bad_input before anything spends', () => {
    // A Pareto frontier lives in node evidence as a vector; the records store only
    // persists scalars, so a publishing carry under advance:"pareto" could never land.
    // Both gates refuse the tuple outright — the tool surface through `swarmValidity`
    // and an in-process caller through `regionRefusal`, which `runSwarm` checks first.
    for (const carry of [{ kind: 'elites' } as const, { kind: 'artifacts', threshold: 0.8 } as const]) {
      const call = resolveSwarm({
        preset: 'custom',
        label: 'pareto-publishing-carry',
        task: 'reach the front',
        objective: VECTOR,
        config: {
          unit: { kind: 'thought' },
          context: 'fork',
          expand: 'sample',
          score: { kind: 'verify' },
          advance: { kind: 'pareto' },
          carry,
        },
        depth: 2,
        branches: 2,
      });
      if ('reason' in call) throw new Error(`the tuple must resolve so validity can refuse it: ${call.error}`);
      expect(swarmValidity(call)).toMatchObject({ reason: 'bad_input' });
      expect(swarmValidity(call)?.error).toContain('advance:"pareto"');
      expect(regionRefusal(call)).toMatchObject({ reason: 'bad_input' });
      expect(regionRefusal(call)?.error).toContain('advance:"pareto"');
    }
  });
});

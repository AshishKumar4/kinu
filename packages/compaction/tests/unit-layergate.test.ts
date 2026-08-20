// The compaction-ladder layer-gate slice — this package's own deterministic
// regression gate over the ladder that rewrites history (core declares the
// layer; this package measures it). Same contract as core's gate: locked
// baseline conformance, deterministic observation, and a fault that craters
// its own slice. Cross-layer isolation against the CORE layers is proven by
// the merged matrix in scripts/layergate.ts --matrix.
import { describe, expect, test } from 'bun:test';
import { observePipeline, runLayerGate, runFaultMatrix, LOCALIZATION_OWN_MIN_PP } from '@kinu/core';
import {
  COMPACTION_LAYERS, COMPACTION_FAULTS, COMPACTION_LOCKED_BASELINE,
  createCompactionLadderSubjects,
} from '../src/index';

const subjects = createCompactionLadderSubjects();
const allProbes = COMPACTION_LAYERS.flatMap((layer) => layer.probes);

describe('compaction-ladder layer gate', () => {
  test('the slice conforms to its locked baseline', async () => {
    const report = await runLayerGate({
      subjects, baseline: COMPACTION_LOCKED_BASELINE, layers: COMPACTION_LAYERS,
    });
    const moved = report.layers
      .filter((score) => score.drifted.length > 0 || score.unlocked.length > 0)
      .map((score) => ({ layer: score.layer, drifted: score.drifted, unlocked: score.unlocked }));
    expect(moved).toEqual([]);
    expect(report.aggregate).toBe(1);
  });

  test('the lock covers exactly the probe set — no stale keys, no unlocked probes', () => {
    expect(Object.keys(COMPACTION_LOCKED_BASELINE).sort()).toEqual(allProbes.map((probe) => probe.id).sort());
  });

  test('observation is deterministic — no clock, no RNG, no I/O', async () => {
    const first = await observePipeline(subjects, COMPACTION_LAYERS);
    const second = await observePipeline(createCompactionLadderSubjects(), COMPACTION_LAYERS);
    expect([...second]).toEqual([...first]);
  });

  test('probe ids are unique and namespaced by their layer', () => {
    const ids = allProbes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of COMPACTION_LAYERS) {
      for (const probe of layer.probes) expect(probe.id.startsWith(`${layer.id}/`)).toBe(true);
    }
  });

  test('the fault patches only owned subjects and craters its own slice', async () => {
    for (const fault of COMPACTION_FAULTS) {
      const owned = COMPACTION_LAYERS.find((layer) => layer.id === fault.layer)!.subjects;
      expect(fault.patches.every((subject) => owned.includes(subject))).toBe(true);
      expect(fault.patches.length).toBeGreaterThan(0);
    }
    const impacts = await runFaultMatrix(subjects, COMPACTION_FAULTS, COMPACTION_LAYERS);
    // The floor packages/core's copy of this test carries and this one did not:
    // a matrix that produced no rows satisfies every localization claim below.
    expect(impacts).toHaveLength(COMPACTION_FAULTS.length);
    for (const impact of impacts) {
      expect(impact.ownDropPp).toBeGreaterThanOrEqual(LOCALIZATION_OWN_MIN_PP);
    }
  });
});

/**
 * Scoring the layer slices against a locked baseline.
 *
 * The point of a per-layer score is resolution. One aggregate number over a
 * whole pipeline moves by a point or two when a stage breaks, and no amount of
 * single-user traffic resolves that; the same regression moves its own layer's
 * slice by tens of points. So the report is per layer, always — and a layer
 * with no slice reports `null`, never 1. Silent perfection for untested code
 * is worse than no gate at all.
 *
 * The digest primitives are imported directly (never through PipelineSubjects)
 * so injecting a fault into `stableStringify` cannot corrupt the scoring that
 * measures it.
 */

import { fnv1a64 } from '../prompting/volatile-context.js';
import { stableStringify } from '../safety/argument-digest.js';
import { LAYERS, type Layer } from './layers.js';
import type { PipelineSubjects } from './subjects.js';

/** Probe id → observation digest. */
export type Baseline = Readonly<Record<string, string>>;

export interface LayerScore {
  readonly layer: string;
  /** Share of the layer's probes matching the baseline, in [0,1] — or `null`
   *  when the layer has no assertion slice. An unmeasured layer is NEVER 1. */
  readonly conformance: number | null;
  readonly probes: number;
  readonly matched: number;
  /** Probes whose observation moved away from the baseline. */
  readonly drifted: readonly string[];
  /** Probes with no baseline entry — the lock is stale, not the code. */
  readonly unlocked: readonly string[];
}

export interface LayerGateReport {
  readonly layers: readonly LayerScore[];
  /** Mean conformance over MEASURED layers, or `null` when none is measured. */
  readonly aggregate: number | null;
  readonly measured: readonly string[];
  readonly unmeasured: readonly string[];
}

function digest(value: unknown): string {
  return fnv1a64(stableStringify(value));
}

/** Run every probe once. A probe that throws is recorded as an observation,
 *  not a crashed run — otherwise one broken subject would take the whole
 *  matrix down instead of scoring the layer that owns it. */
export async function observePipeline<S = PipelineSubjects>(
  subjects: S,
  // The default serves the core pipeline; a custom subjects record must pass
  // its own layers, so the cast is never observable to such callers.
  layers: readonly Layer<S>[] = LAYERS as unknown as readonly Layer<S>[],
): Promise<Map<string, string>> {
  const observations = new Map<string, string>();
  for (const layer of layers) {
    for (const probe of layer.probes) {
      let value: unknown;
      try {
        value = await probe.observe(subjects);
      } catch (err) {
        value = { threw: err instanceof Error ? err.message : String(err) };
      }
      observations.set(probe.id, digest(value));
    }
  }
  return observations;
}

export function scoreAgainstBaseline<S = PipelineSubjects>(
  observations: ReadonlyMap<string, string>,
  baseline: Baseline,
  layers: readonly Layer<S>[] = LAYERS as unknown as readonly Layer<S>[],
): LayerGateReport {
  const scores: LayerScore[] = [];
  for (const layer of layers) {
    const drifted: string[] = [];
    const unlocked: string[] = [];
    let matched = 0;
    for (const probe of layer.probes) {
      const locked = baseline[probe.id];
      if (locked === undefined) unlocked.push(probe.id);
      else if (locked === observations.get(probe.id)) matched += 1;
      else drifted.push(probe.id);
    }
    scores.push({
      layer: layer.id,
      conformance: layer.probes.length === 0 ? null : matched / layer.probes.length,
      probes: layer.probes.length,
      matched,
      drifted,
      unlocked,
    });
  }
  const measured = scores.filter((s) => s.conformance !== null);
  return {
    layers: scores,
    aggregate: measured.length === 0
      ? null
      : measured.reduce((acc, s) => acc + (s.conformance ?? 0), 0) / measured.length,
    measured: measured.map((s) => s.layer),
    unmeasured: scores.filter((s) => s.conformance === null).map((s) => s.layer),
  };
}

export async function runLayerGate<S = PipelineSubjects>(opts: {
  subjects: S;
  baseline: Baseline;
  layers?: readonly Layer<S>[];
}): Promise<LayerGateReport> {
  const layers = opts.layers ?? (LAYERS as unknown as readonly Layer<S>[]);
  return scoreAgainstBaseline(await observePipeline(opts.subjects, layers), opts.baseline, layers);
}

/** Re-lock: the observation digests as they stand now. */
export async function lockBaseline<S = PipelineSubjects>(
  subjects: S,
  layers: readonly Layer<S>[] = LAYERS as unknown as readonly Layer<S>[],
): Promise<Baseline> {
  return Object.fromEntries([...await observePipeline(subjects, layers)].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function pct(value: number | null): string {
  return value === null ? '   null' : `${(value * 100).toFixed(1).padStart(6)}%`;
}

export function renderLayerGateReport(report: LayerGateReport): string {
  const width = Math.max(...report.layers.map((s) => s.layer.length));
  const lines = report.layers.map((s) => {
    const head = `  ${s.layer.padEnd(width)}  ${pct(s.conformance)}  ${s.matched}/${s.probes}`;
    const notes = [
      s.drifted.length ? `drifted: ${s.drifted.join(', ')}` : '',
      s.unlocked.length ? `unlocked: ${s.unlocked.join(', ')}` : '',
      s.conformance === null ? 'NOT MEASURED' : '',
    ].filter(Boolean);
    return notes.length ? `${head}  — ${notes.join('; ')}` : head;
  });
  return [
    'Layer gate',
    ...lines,
    `  ${'aggregate (measured layers only)'.padEnd(width)}  ${pct(report.aggregate)}`,
    `  ${report.measured.length} measured, ${report.unmeasured.length} declared but not measured`,
  ].join('\n');
}

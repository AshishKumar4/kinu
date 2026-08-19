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

import { fnv1a64 } from '../prompting/volatile-context';
import { stableStringify } from '../safety/argument-digest';
import { parseJsonValue } from '../utils/json';
import { LAYERS, type Layer, type LayerObservation } from './layers';
import type { PipelineSubjects } from './subjects';
import { renderThrownChain } from '../obs/index';

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

function digest(value: LayerObservation): string {
  if (value === undefined) return fnv1a64('undefined');
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('layer observation must be JSON-serializable');
  }
  return fnv1a64(stableStringify(parseJsonValue(serialized)));
}

/** Run every probe once. A probe that throws is recorded as an observation,
 *  not a crashed run — otherwise one broken subject would take the whole
 *  matrix down instead of scoring the layer that owns it. */
async function observeLayers<S>(
  subjects: S,
  layers: readonly Layer<S>[],
): Promise<Map<string, string>> {
  const observations = new Map<string, string>();
  for (const layer of layers) {
    for (const probe of layer.probes) {
      let value: LayerObservation;
      try {
        value = await probe.observe(subjects);
      } catch (err) {
        value = { threw: renderThrownChain({ cause: err }) };
      }
      observations.set(probe.id, digest(value));
    }
  }
  return observations;
}

export function observePipeline(subjects: PipelineSubjects): Promise<Map<string, string>>;
export function observePipeline<S>(
  subjects: S,
  layers: readonly Layer<S>[],
): Promise<Map<string, string>>;
export function observePipeline<S>(
  ...input: [subjects: PipelineSubjects] | [subjects: S, layers: readonly Layer<S>[]]
): Promise<Map<string, string>> {
  if (input.length === 1) return observeLayers(input[0], LAYERS);
  return observeLayers(input[0], input[1]);
}

interface ScoringLayer {
  readonly id: string;
  readonly probes: readonly { readonly id: string }[];
}

export function scoreAgainstBaseline(
  observations: ReadonlyMap<string, string>,
  baseline: Baseline,
  layers: readonly ScoringLayer[] = LAYERS,
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

type DefaultGateOptions = {
  subjects: PipelineSubjects;
  baseline: Baseline;
  layers?: undefined;
};

type CustomGateOptions<S> = {
  subjects: S;
  baseline: Baseline;
  layers: readonly Layer<S>[];
};

export async function runLayerGate<S>(
  opts: DefaultGateOptions | CustomGateOptions<S>,
): Promise<LayerGateReport> {
  if (opts.layers === undefined) {
    return scoreAgainstBaseline(await observePipeline(opts.subjects), opts.baseline);
  }
  return scoreAgainstBaseline(
    await observePipeline(opts.subjects, opts.layers),
    opts.baseline,
    opts.layers,
  );
}

/** Re-lock: the observation digests as they stand now. */
export function lockBaseline(subjects: PipelineSubjects): Promise<Baseline>;
export function lockBaseline<S>(subjects: S, layers: readonly Layer<S>[]): Promise<Baseline>;
export async function lockBaseline<S>(
  ...input: [subjects: PipelineSubjects] | [subjects: S, layers: readonly Layer<S>[]]
): Promise<Baseline> {
  const observations = input.length === 1
    ? await observePipeline(input[0])
    : await observePipeline(input[0], input[1]);
  return Object.fromEntries([...observations].sort(([a], [b]) => (a < b ? -1 : 1)));
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

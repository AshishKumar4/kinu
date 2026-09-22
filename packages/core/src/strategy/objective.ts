/**
 * What is measured, who measures it, and where the number is kept. Spec:
 * docs/EXPLORATION.md "The objective" through "The records store".
 * A node never supplies its own score: a verifier gets a filesystem and a shell
 * only, so an outcome is a property of the final state. test-utils declares an
 * identical `VerifierContext` and cannot be imported here; keep the two in step.
 */

import type {
  CarrySuppression, Floor,
  Objective, ObjectiveDirection, ObjectiveScale,
  ParetoAxes, ParetoAxis, ParetoEvidence, PublicationState, PublicationSurface,
  PublicationVerdict, PublishingCarry, VerifierKind,
  InstancedObjective, VectorObjective, MeasuredObjective,
} from '../types/objective';
import { PUBLICATION_SURFACES } from '../types/objective';

export type {
  CarrySuppression, Floor, FloorBreach, FloorRederivation, MeasuredValue, Measurement,
  MeasurementContext, Objective, ObjectiveDirection, ObjectiveIdentity, ObjectiveScale,
  ParetoAxes, ParetoAxis, ParetoEvidence, PublicationState, PublicationSurface,
  PublicationVerdict, PublishingCarry, Unmeasurable, Verifier, VerifierFault,
  VerifierKind, VerifierSource, VerifierSpec, WitnessObjective,
  ScalarObjective, InstancedObjective, VectorObjective, MeasuredObjective,
  ExplorationRecord,
} from '../types/objective';

export {
  PUBLICATION_SURFACES, PUBLISHING_CARRIES, VERIFIER_KINDS,
} from '../types/objective';

/**
 * The model-facing statement of each registered kind and the `spec` keys it needs.
 * Lives here so {@link swarmValidity} can read it at call time; a test holds
 * `specFields` equal to what the registry's schema requires.
 */
export const VERIFIER_KIND_DOC = {
  'exec-ratio': {
    summary: 'counts the oracle calls a candidate spends against a reference solution run on the '
      + 'same instance, so it fits a task whose cost you can count by RUNNING code',
    specFields: ['params', 'reference', 'body', 'targetOps', 'lowerBoundOps'],
  },
} satisfies Record<VerifierKind, {
  readonly summary: string;
  readonly specFields: readonly string[];
}>;

/**
 * Room a floor leaves, as a fraction of the best known honest cost. Reported, never
 * thresholded. 0 at the best known cost, 1 when the floor is 0; negative refutes the floor.
 */
export function floorMargin(floor: Floor, direction: ObjectiveDirection): number {
  const best = floor.bestKnownHonest;

  if (best === 0) return floor.value === 0 ? 0 : Number.NEGATIVE_INFINITY;
  const room = direction === 'minimise' ? best - floor.value : floor.value - best;

  return room / Math.abs(best);
}

/**
 * The publication gate, total over {@link PUBLICATION_SURFACES}: the caller must name
 * the surface. A sealed state with a recorded {@link FloorRederivation} admits again.
 */
export function admitsPublication(
  state: PublicationState, surface: PublicationSurface,
): PublicationVerdict {
  if (state.kind === 'open') return { kind: 'admitted' };

  if (state.clearedBy !== null) return { kind: 'admitted' };

  return { kind: 'refused', surface, breach: state.breach };
}

/** The disclosure, or `null` when not suppressed (distinct from a suppression of zero cells). */
export function carrySuppression(
  state: PublicationState, carry: PublishingCarry, suppressedCells: number,
): CarrySuppression | null {
  if (state.kind === 'open') return null;

  if (state.clearedBy !== null) return null;

  return {
    carry,
    breach: state.breach,
    refused: PUBLICATION_SURFACES.filter(
      (surface) => admitsPublication(state, surface).kind === 'refused',
    ),
    suppressedCells,
  };
}

/** Axes come from the objective, so a verifier cannot rename, add, or invert a dimension. */
export function paretoObjectiveAxes(objective: InstancedObjective | VectorObjective): ParetoAxes {
  const axes = objective.kind === 'instanced'
    ? objective.instances.map((id) => ({ id, direction: objective.direction }))
    : objective.components.map((component) => ({
      id: component.metric,
      direction: component.direction,
    }));

  const duplicate = axes.find((axis, index) => axes.findIndex((other) => other.id === axis.id) !== index);

  return duplicate
    ? { reason: `Pareto objective declares axis "${duplicate.id}" more than once.` }
    : { axes };
}

/** Check that a verifier supplied exactly one finite value for every declared axis.
 * Missing evidence is not zero, and an added axis is not comparable evidence. */
export function validateParetoEvidence(
  axes: readonly ParetoAxis[], evidence: ParetoEvidence,
): { readonly evidence: ParetoEvidence } | { readonly reason: string } {
  for (const axis of axes) {
    const value = evidence[axis.id];

    if (value === undefined) return { reason: `Pareto evidence is missing declared axis "${axis.id}".` };

    if (!Number.isFinite(value)) {
      return { reason: `Pareto evidence for axis "${axis.id}" is non-finite.` };
    }
  }

  for (const id of Object.keys(evidence)) {
    if (!axes.some((axis) => axis.id === id)) {
      return { reason: `Pareto evidence names undeclared axis "${id}".` };
    }
  }

  return { evidence };
}

export function dominatesPareto(
  axes: readonly ParetoAxis[], left: ParetoEvidence, right: ParetoEvidence,
): boolean {
  let strict = false;

  for (const axis of axes) {
    const l = left[axis.id];
    const r = right[axis.id];

    if (l === undefined || r === undefined || !Number.isFinite(l) || !Number.isFinite(r)) {
      throw new Error(`cannot compare Pareto evidence on axis "${axis.id}"`);
    }

    if (axis.direction === 'maximise' ? l < r : l > r) return false;

    if (l !== r) strict = true;
  }

  return strict;
}

/** Nondominated candidates in supplied order; equal vectors remain equally nondominated. */
export function paretoFront<Candidate extends { readonly evidence: ParetoEvidence }>(
  axes: readonly ParetoAxis[], candidates: readonly Candidate[],
): readonly Candidate[] {
  for (const candidate of candidates) {
    const checked = validateParetoEvidence(axes, candidate.evidence);

    if ('reason' in checked) throw new Error(checked.reason);
  }

  return candidates.filter((candidate, index) =>
    !candidates.some((other, otherIndex) =>
      otherIndex !== index && dominatesPareto(axes, other.evidence, candidate.evidence)));
}

/**
 * Strictly better: a tie does not displace. Displacement, eviction and a cell's
 * best must all use this so the store stays monotone (Lean invariant S2).
 */
export function isBetter(
  candidate: number, incumbent: number, direction: ObjectiveDirection,
): boolean {
  return direction === 'minimise' ? candidate < incumbent : candidate > incumbent;
}

/**
 * The raw measurement mapped onto [0,1]: 0 is the measured baseline, 1 the declared
 * target. `null` when there is no range to score on (baseline meets the target, or
 * `log` over a value with no logarithm); the caller refuses the run.
 */
export function normalisedScore(input: {
  readonly value: number;
  readonly baseline: number;
  readonly target: number;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
}): number | null {
  const { direction, scale } = input;

  if (scale === 'log' && (input.value <= 0 || input.baseline <= 0 || input.target <= 0)) return null;
  const at = scale === 'log' ? Math.log : (x: number): number => x;
  const [value, baseline, target] = [at(input.value), at(input.baseline), at(input.target)];
  const span = direction === 'minimise' ? baseline - target : target - baseline;

  if (!(span > 0)) return null;
  const progress = direction === 'minimise' ? baseline - value : value - baseline;

  return Math.min(1, Math.max(0, progress / span));
}

export function measuredHalf(objective: Objective): MeasuredObjective | null {
  if (objective.kind === 'witness') {
    if (!objective.proxy) return null;
    const proxy = measuredHalf(objective.proxy);

    return proxy && { ...proxy, witness: objective.check };
  }

  // Multi-axis kinds have no single measurable reduction (*Accepted and ignored*).
  if (objective.kind === 'vector' || objective.kind === 'instanced') return null;

  return {
    metric: objective.metric,
    unit: objective.unit,
    direction: objective.direction,
    scale: objective.scale,
    target: objective.target,
    verify: objective.verify,
    floor: objective.floor,
    witness: null,
  };
}

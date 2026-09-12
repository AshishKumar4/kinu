/**
 * What is measured, who measures it, and where the number is kept.
 *
 * Specified by docs/EXPLORATION.md — "The objective", "Witness objectives", "The
 * closed verifier registry", "Comparability", "The floor", "The publication seal"
 * and "The records store". This module is the declarations those rules are stated
 * over: `strategy/swarm-run.ts` wires them into a run, `strategy/verifier-registry.ts`
 * resolves an instrument, and `strategy/records.ts` creates and writes the records
 * table. The types exist so the specification is compiled rather than prose, and so
 * the Lean stage has concrete field names to model.
 *
 * THE ONE RULE EVERYTHING HERE SERVES. A node never supplies its own score. A
 * verifier is handed a filesystem and a shell and nothing else — no model, no
 * network, no run-event ledger — so an outcome is a property of the FINAL STATE
 * and reproducible without the trajectory that produced it. That is exactly the
 * contract test-utils/src/eval-outcome.ts:91-98 already holds for the eval tier;
 * this generalises it to a live search.
 *
 * WHY THE CONTEXT TYPE IS DUPLICATED AND WHERE THE DUPLICATION DIES. `test-utils`
 * declares a structurally identical `VerifierContext` (eval-outcome.ts:95-98).
 * `@kinu.run/core` cannot import `@kinu.run/test-utils` — the dependency arrow runs
 * the other way — so the canonical declaration has to be here and test-utils has
 * to be re-pointed at it when this is wired. That re-pointing is a WIRING step,
 * deliberately not taken in this commit, and it is recorded here rather than in a
 * changelog because the second shape is the thing that drifts.
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
 * What each registered kind measures and what its `spec` must carry — the ONE
 * model-facing statement of both.
 *
 * IT LIVES HERE FOR THE REASON {@link VERIFIER_KINDS} DOES, one line up: the
 * vocabulary is reachable from {@link swarmValidity} and the registry is not, so a
 * refusal that wants to name the whole shape at CALL time has to read it from here.
 * Without it the caller learned the shape one field at a time from the registry's own
 * `bind`, which runs after the run has started — the measured incident this table
 * exists to end: five round trips, four of them spent discovering a field.
 *
 * `specFields` is the field LIST and deliberately not a second copy of the schema.
 * `verifier-registry.ts` owns the types, the ranges and the cross-field rules; this
 * says which keys a caller has to send, which is the half a refusal has to print. The
 * two are held together behaviourally rather than by comment: a test binds a spec
 * carrying exactly these keys through the real registry and fails if the registry
 * wants a key this list omits, or ignores one it names.
 */
export const VERIFIER_KIND_DOC = {
  'exec-ratio': {
    summary: 'counts the oracle calls a candidate spends against a reference solution run on the '
      + 'same instance, so it fits a task whose cost you can count by RUNNING code',
    specFields: ['params', 'reference', 'body', 'targetOps', 'lowerBoundOps'],
  },
} satisfies Record<VerifierKind, {
  /** When this instrument is the right one, in the caller's terms. */
  readonly summary: string;
  /** Every key the kind's own schema requires inside `spec`. */
  readonly specFields: readonly string[];
}>;

/**
 * How much room a floor leaves, as a fraction of the best known honest cost.
 *
 * Reported, never thresholded: no single number is right for every problem, and a
 * threshold would either forbid legitimately tight bounds or wave through the
 * majority-vote floor. What the spec requires is that the margin is computed and
 * surfaced, because the failure being designed against was a thin margin nobody
 * had ever looked at.
 *
 * Returns 0 when the floor sits exactly at the best known cost and 1 when the
 * floor is 0. Negative means the floor already EXCEEDS the best known honest
 * cost, which refutes the floor outright.
 *
 * A named function rather than an inline expression because the sign convention
 * depends on `direction` and getting it backwards inverts the check it exists to
 * perform — the exact class of mistake the floor described in *The floor* was. It is
 * also the predicate *Floor margin*'s C1 check and the Lean model are stated over.
 */
export function floorMargin(floor: Floor, direction: ObjectiveDirection): number {
  const best = floor.bestKnownHonest;

  if (best === 0) return floor.value === 0 ? 0 : Number.NEGATIVE_INFINITY;
  const room = direction === 'minimise' ? best - floor.value : floor.value - best;

  return room / Math.abs(best);
}

/**
 * The gate. Total over {@link PUBLICATION_SURFACES} on purpose: the seal admits no
 * per-surface exception, so the surface is an argument the caller must NAME rather
 * than a discriminator this function reads. A new writer therefore cannot reach a
 * store without choosing a member of the enumeration.
 *
 * A sealed state with a recorded {@link FloorRederivation} admits again — that is
 * the retroactive publication *The publication seal* allows, and it is the one edge
 * out of a seal. Tested with `!== null` and never for falsiness: a re-derivation is
 * present or absent, and absent is not the same claim as a re-derivation that
 * adjudicated nothing.
 */
export function admitsPublication(
  state: PublicationState, surface: PublicationSurface,
): PublicationVerdict {
  if (state.kind === 'open') return { kind: 'admitted' };

  if (state.clearedBy !== null) return { kind: 'admitted' };

  return { kind: 'refused', surface, breach: state.breach };
}

/**
 * The disclosure, or `null` when the carry was not suppressed.
 *
 * `null` is "not suppressed". It is NOT the same claim as a suppression of zero
 * cells: a sealed run that reached no new best still had its carry axis voided, and
 * the report must say so.
 */
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

/** Derive the comparison axes from the objective rather than from measurements.
 * This makes a verifier unable to rename, add, or invert an objective dimension. */
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

/** `left` dominates `right` iff it is weakly better on every declared axis and
 * strictly better on at least one. */
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

/** Return the nondominated candidates in their supplied order. Input order is the
 * deterministic tie rule; equal vectors remain equally nondominated. */
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
 * Is `candidate` better than `incumbent` in this direction?
 *
 * STRICTLY better — a tie does not displace. A tie carries no signal, and
 * `ORDER BY value DESC` over equal values is row order; mcts/convergence.ts:56-93
 * is the live precedent for refusing to read a winner out of a tie.
 *
 * A named function rather than an inline comparison for three reasons the rule
 * admits: it is the definition monotone displacement (*The records store*) is stated
 * over, the Lean invariant S2 (*The Lean invariants*) quantifies over it by name, and
 * its three intended call sites — displacement, eviction, and a cell's best — must
 * move in lockstep or the store stops being monotone in one of them.
 */
export function isBetter(
  candidate: number, incumbent: number, direction: ObjectiveDirection,
): boolean {
  return direction === 'minimise' ? candidate < incumbent : candidate > incumbent;
}

/**
 * The normalisation *Raw units* leaves to the harness: the raw measurement mapped
 * onto the [0,1] a search climbs.
 *
 * `0` means "no better than the baseline the harness measured" and `1` means
 * "reached the declared target". The BASELINE is an argument rather than a field on
 * the objective because *Measured baseline* forbids a caller supplying one — it is
 * measured on the workspace as found, before any candidate exists.
 *
 * `null` means THERE IS NO RANGE TO SCORE ON: the baseline already meets the target,
 * or a `log` scale was asked for over a value that has no logarithm. Null rather than
 * 0, because a degenerate span makes every candidate saturate and a fabricated 0
 * would be indistinguishable from a candidate that genuinely improved on nothing —
 * the caller refuses the run instead — *Measured baseline*'s second normative
 * consequence.
 *
 * A named function for the same reason as {@link floorMargin} and {@link isBetter}:
 * the direction and the scale both invert the arithmetic, getting either backwards
 * silently reverses the search, and this is the expression *Raw units* is stated as.
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

/** The measurable reduction of an objective, or null when none exists. */
export function measuredHalf(objective: Objective): MeasuredObjective | null {
  if (objective.kind === 'witness') {
    if (!objective.proxy) return null;
    const proxy = measuredHalf(objective.proxy);

    return proxy && { ...proxy, witness: objective.check };
  }

  // BOTH multi-axis kinds return null, and `instanced` was the one that did not. It
  // carries every field a scalar does, so it fell through this function and was measured
  // as though its `instances` were not there — the refusal below already said "measured
  // per component or per instance" while only the component half was reachable. A run
  // that reduces a declared front to one aggregate number is the accepted-and-ignored
  // axis *Accepted and ignored* refuses, so the objective's own kind is what refuses.
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

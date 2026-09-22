/** Objective and measurement contract, declared at the platform layer so the swarm engine,
 *  swarm-input schemas and delegation surface share it without importing the strategy harness. */

import type { ExecOutcome } from '../execution/exec-result';
import type { VFS } from './primitives';
import type { JsonValue } from '../utils/json';

/** What a verifier is given. No model, no network, no trajectory: a measurement must be
 *  reproducible and unpersuadable by the reasoning that produced the answer. */
export interface MeasurementContext {
  readonly vfs: VFS;
  readonly exec: (command: string) => Promise<ExecOutcome>;
}

/** No default: guessing "higher is better" silently inverts every cost. */
export type ObjectiveDirection = 'minimise' | 'maximise';

/** How a raw measurement maps onto [0,1]. `log` for multiplicative improvement (n² → n^1.5),
 *  `linear` for quantities that add. */
export type ObjectiveScale = 'linear' | 'log';

/** A measured verdict. `value` is raw, in the objective's unit; the harness normalises it
 *  from the measured baseline and declared target. */
export interface MeasuredValue {
  readonly kind: 'measured';
  /** Finite. In `ScalarObjective.unit`. */
  readonly value: number;
  /** What was measured, naming the ground truth it was measured against. */
  readonly detail: string;
  /** Raw quantities the value was derived from, so a ratio stays re-derivable. */
  readonly measured?: Readonly<Record<string, number>>;
  /** Per-instance scores; required for an {@link InstancedObjective}, where `value` is the
   *  aggregate. Absent (not empty) otherwise: an empty map would claim every instance scored 0. */
  readonly perInstance?: Readonly<Record<string, number>>;
}

/** The candidate produced no usable answer. Scored at the direction's worst, with the reason. */
export interface Unmeasurable {
  readonly kind: 'unmeasurable';
  /** Required: an unexplained zero is indistinguishable from a broken verifier. */
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number>>;
}

/** No member reports "the verifier broke": a broken instrument throws, and a throw is never
 *  converted into `Unmeasurable` — see {@link VerifierFault}. */
export type Measurement = MeasuredValue | Unmeasurable;

/** Closed set of resolvable verifier kinds. Lives beside the type (not the registry) so
 *  {@link swarmValidity} can refuse unknown kinds at call time without an import cycle. */
export const VERIFIER_KINDS = ['exec-ratio'] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

/** A task's ground truth, as code. */
export type Verifier = (ctx: MeasurementContext) => Promise<Measurement>;

/** A verifier declared as data, so {@link ObjectiveIdentity}'s digest is definable: a closure's
 *  `toString()` omits its captures, so identical source can digest equal and behave differently. */
export interface VerifierSpec {
  /** Drawn from {@link VERIFIER_KINDS}; unregistered kinds are refused as bad_input. The
   *  registry is part of the objective's identity. */
  readonly kind: string;
  /** Everything the kind needs, as JSON. Opaque to the objective's snake_case convention and
   *  never transformed by the harness, so the digest is taken over the bytes as received. */
  readonly spec: JsonValue;
}

/** Only `VerifierSpec` is reachable from the tool surface. The closure arm is for in-process
 *  callers, unguarded by the registry, and never publishable. */
export type VerifierSource = VerifierSpec | Verifier;

/** The instrument broke (threw, rejected, or returned a non-{@link Measurement}). Produced by the
 *  harness; fails the run — nothing is scored, published, or recorded. */
export interface VerifierFault {
  readonly reason: 'unavailable';
  /** What the verifier did instead of measuring, quoting any return value. */
  readonly error: string;
}

/** A bound no correct solution may cross, so a cheat is detectable. Must be a proof. */
export interface Floor {
  /** In the objective's unit. For `minimise`, no correct candidate may measure below it. */
  readonly value: number;
  /** The argument, not a citation: a textbook worst case is not a per-instance certificate. */
  readonly proof: string;
  /** Only `certificate` is safe as a floor; an `adversary` bound scores a lucky honest run on a
   *  fortunate input as a cheat. `physical` is a conservation law or hardware limit. */
  readonly kind: 'certificate' | 'adversary' | 'physical';
  /** Best honest cost known when the floor was written; makes {@link floorMargin} computable. */
  readonly bestKnownHonest: number;
}

/** A candidate measured past the floor. Not a verdict: both hypotheses stay named and the
 *  measurement is retained rather than scored 0. */
export interface FloorBreach {
  readonly floor: Floor;
  readonly measured: MeasuredValue;
  /** `bestKnownHonest`-relative room the floor claimed. */
  readonly margin: number;
  /** Demand opposite responses (re-derive the bound vs. fix the channel); nothing downstream
   *  may pick one. */
  readonly hypotheses: readonly ['floor_wrong', 'verifier_gameable'];
}

/**
 * Every surface through which a search's output reaches another run; the seal is stated over
 * this set. `contract-publication-seal.test.ts` pins it against the settle path's writer census.
 */
export const PUBLICATION_SURFACES = [
  'records', 'experience_library', 'craft', 'memory', 'task_history',
  'scaffold_versions',
] as const;

export type PublicationSurface = (typeof PUBLICATION_SURFACES)[number];

/** A breach seals publication on every {@link PUBLICATION_SURFACES} member (Lean invariant S7);
 *  the search itself continues. Gate: {@link admitsPublication}. */
export type PublicationState =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'sealed';
      readonly breach: FloorBreach;
      /** Cleared only by a recorded re-derivation, never by a retry or a later in-bound score. */
      readonly clearedBy: FloorRederivation | null;
    };

/** A refusal is a value, not a throw, so it stays distinguishable from a broken store. */
export type PublicationVerdict =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'refused';
      readonly surface: PublicationSurface;
      readonly breach: FloorBreach;
    };

/** `carry` values whose purpose is publication. A containment test pins it against
 *  `SWARM_CARRIES`. */
export const PUBLISHING_CARRIES = ['elites', 'artifacts'] as const;

export type PublishingCarry = (typeof PUBLISHING_CARRIES)[number];

/** What a settle report must state when the seal voided the run's `carry`. */
export interface CarrySuppression {
  readonly carry: PublishingCarry;
  readonly breach: FloorBreach;
  readonly refused: readonly PublicationSurface[];
  /** Distinct cells whose best could not be recorded, counted once per cell. Deliberately not
   *  Lean's `suppression_counts_every_refusal` attempt count. */
  readonly suppressedCells: number;
}

/** A human's replacement for a breached floor; required to clear a seal. */
export interface FloorRederivation {
  readonly floor: Floor;
  /** Which of `FloorBreach.hypotheses` was adjudicated, and on what evidence. */
  readonly adjudication: string;
  readonly at: number;
}

/** A checkable certificate: a witness plus the predicate it must satisfy. */
export interface WitnessObjective {
  readonly kind: 'witness';
  readonly witness: string;
  /** Returns a {@link Measurement} with `value` 1 when satisfied, 0 otherwise. */
  readonly check: VerifierSource;
  /** A scalar to climb while the witness is unfound; without one a tree degenerates to
   *  breadth-first enumeration. */
  readonly proxy?: ScalarObjective;
}

/** A measured cost or quality with a direction. */
export interface ScalarObjective {
  readonly kind: 'scalar';
  /** Names the row in the records store. */
  readonly metric: string;
  /** Spelled out, e.g. `'oracle calls'`, `'ms'`. */
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /** Where the normalised score saturates. Not a baseline — the harness measures that; a target
   *  at or beyond the baseline refuses the run. */
  readonly target: number;
  readonly verify: VerifierSource;
  readonly floor?: Floor;
}

/** One metric over many instances: GEPA's per-instance Pareto front (arXiv:2507.19457 Alg. 2),
 *  distinct from {@link VectorObjective}'s per-metric front. */
export interface InstancedObjective {
  readonly kind: 'instanced';
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  readonly target: number;
  /** At least two; these are the front's axes. */
  readonly instances: readonly string[];
  /** Must populate `perInstance` for every declared instance, with `value` as the aggregate. */
  readonly verify: VerifierSource;
  readonly floor?: Floor;
}

/** Several different metrics, each with its own unit, direction, scale, target and floor. */
export interface VectorObjective {
  readonly kind: 'vector';
  /** At least two. */
  readonly components: readonly ScalarObjective[];
}

/** One Pareto axis: an instance name (instanced) or a metric name (vector). */
export interface ParetoAxis {
  readonly id: string;
  readonly direction: ObjectiveDirection;
}

export type ParetoEvidence = Readonly<Record<string, number>>;

export type ParetoAxes =
  | { readonly axes: readonly ParetoAxis[] }
  | { readonly reason: string };

export type Objective =
  | ScalarObjective
  | InstancedObjective
  | VectorObjective
  | WitnessObjective;

/** What makes two runs comparable: metric and instrument only. Floor, target and search
 *  configuration are provenance, not identity. */
export interface ObjectiveIdentity {
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /** Digest of the verifier, not a caller-supplied name, so a changed instrument changes
   *  identity instead of silently displacing old records. */
  readonly verifierDigest: string;
}

/** A records-store row. Cell = `(objectiveId, descriptor)`; `artifactDigest` is identity within
 *  the cell, so a cell holds a population. */
export interface ExplorationRecord {
  /** Digest over {@link ObjectiveIdentity}. */
  readonly objectiveId: string;
  /** Archive cell for `advance:'archive'`. NULL means no descriptor partition, not an unnamed cell. */
  readonly descriptor: string | null;
  readonly artifactDigest: string;
  readonly artifact: string;
  /** Raw measured value in the objective's unit, never normalised. */
  readonly value: number;
  readonly detail: string;
  readonly measured: Readonly<Record<string, number>> | null;
  /** The preset that produced it, or `'custom'`. */
  readonly preset: string;
  /** NULL for an unmodified preset run. */
  readonly label: string | null;
  /** `search_nodes.root_id`, not `mcts_search_runs.root_id`: that ledger deletes settled rows
   *  after 24h. */
  readonly rootId: string;
  /** Digest over the fully resolved configuration: axes, axis-parameters and caps in force. */
  readonly configDigest: string;
  readonly depth: number;
  readonly branches: number;
  /** Digest of the whole `Floor` published under, so a later correction can find affected rows.
   *  NULL when no floor was declared (not a floor of zero). */
  readonly floorDigest: string | null;
  /** NULL together with {@link floorDigest}. */
  readonly floorValue: number | null;
  readonly floorProof: string | null;
  /** NULL when unreported: absent is not zero. */
  readonly costUsd: number | null;
  readonly costTokens: number | null;
  readonly firstRecordedAt: number;
  /** How many times this cell's best has moved since this row was written. */
  readonly displacements: number;
}

/** The scalar half of an objective a measured run needs; a `witness` hunt supplies its proxy's. */
export interface MeasuredObjective {
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  readonly target: number;
  readonly verify: VerifierSource;
  readonly floor: Floor | undefined;
  /** Evaluated as a side condition on every candidate, never optimised. */
  readonly witness: VerifierSource | null;
}

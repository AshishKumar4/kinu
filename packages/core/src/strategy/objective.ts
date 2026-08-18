/**
 * What is measured, who measures it, and where the number is kept.
 *
 * Specified by docs/EXPLORATION-SPEC.md sections 2-5. Declarations only — no
 * strategy registers these, no DDL creates the records table, and nothing calls
 * a verifier yet. The types exist so the spec is compiled rather than prose, and
 * so the Lean stage has concrete field names to model.
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
 * `@proteus/core` cannot import `@proteus/test-utils` — the dependency arrow runs
 * the other way — so the canonical declaration has to be here and test-utils has
 * to be re-pointed at it when this is wired. That re-pointing is a WIRING step,
 * deliberately not taken in this commit, and it is recorded here rather than in a
 * changelog because the second shape is the thing that drifts.
 */

import type { ExecOutcome } from '../execution/exec-result';
import type { VFS } from '../types/primitives';
import type { JsonValue } from '../utils/json';

/**
 * What a verifier is given.
 *
 * Two members, both readonly, and the absences are the specification: no model
 * (a judged outcome is one somebody can argue with), no network (a measurement
 * that depends on a third party is not reproducible), no trajectory (a verifier
 * that can read how the answer was reached can be persuaded by the reasoning
 * rather than the result).
 */
export interface MeasurementContext {
  readonly vfs: VFS;
  readonly exec: (command: string) => Promise<ExecOutcome>;
}

/** Which way is better. There is no default: a number without a direction is not
 *  an objective, and guessing "higher is better" silently inverts every cost. */
export type ObjectiveDirection = 'minimise' | 'maximise';

/**
 * How a raw measurement is mapped onto the [0,1] the search climbs.
 *
 * `log` because algorithmic improvement is multiplicative: n² to n^1.5 is real,
 * partial, climbable progress that a linear scale scores as almost nothing
 * (hard-tasks/cost-model.ts:417-420). `linear` for quantities that genuinely add
 * — an error norm, a byte count, a percentage.
 */
export type ObjectiveScale = 'linear' | 'log';

/**
 * A measured verdict on one candidate.
 *
 * `value` is RAW, in the objective's own unit. It is deliberately not normalised:
 * the number the search climbs and the number the records store keeps are
 * different numbers, and conflating them makes two runs with different baselines
 * incomparable forever. Normalisation happens once, in the harness, from the
 * measured baseline and the declared target.
 */
export interface MeasuredValue {
  readonly kind: 'measured';
  /** Finite. In `ScalarObjective.unit`. */
  readonly value: number;
  /** What was measured, naming the ground truth it was measured against.
   *  Required for the same reason eval-outcome.ts:72-78 requires it: a stored
   *  number that does not say what it measured is a number whose meaning lives
   *  in its author's memory. */
  readonly detail: string;
  /** Raw quantities the value was derived from, so a ratio stays re-derivable.
   *  A ratio scored against a constant nobody kept is a ratio nobody can check. */
  readonly measured?: Readonly<Record<string, number>>;
}

/**
 * The candidate produced no usable answer.
 *
 * A legitimate outcome, and the ONLY way to say "this candidate is worthless".
 * Absent, unparseable, threw, over budget, wrong shape, wrong answer — all of it
 * lands here, exactly as hard-tasks/cost-model.ts:214-216 already routes it.
 * Scored at the direction's worst, recorded WITH the reason, never silently.
 */
export interface Unmeasurable {
  readonly kind: 'unmeasurable';
  /** Why there is no number. Required — an unexplained zero is indistinguishable
   *  from a broken verifier, which is the distinction this whole file exists for. */
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number>>;
}

/**
 * Everything a verifier may return.
 *
 * Note what is NOT a member: there is no way to report "the verifier itself
 * broke". That is not an oversight, it is the mechanism. A broken instrument
 * throws, and a throw is never converted into an `Unmeasurable` — see
 * {@link VerifierFault}.
 */
export type Measurement = MeasuredValue | Unmeasurable;

/** A task's ground truth, as code. Async because measuring means running
 *  something. */
export type Verifier = (ctx: MeasurementContext) => Promise<Measurement>;

/**
 * A verifier declared as DATA, which is what makes {@link ObjectiveIdentity}'s
 * digest definable at all.
 *
 * WHY A CLOSURE IS NOT ENOUGH, and why this is a type-system fact rather than a
 * preference. The digest primitive this reuses — `argumentDigest` in
 * safety/argument-digest.ts — takes `JsonValue`, so a digest is only definable
 * over JSON. `Function.prototype.toString()` returns a function's BODY and not its
 * captured environment, so two closures with identical source and different
 * captures produce an IDENTICAL digest and DIFFERENT behaviour. Under §5.1 that
 * silently compares incomparable runs; under §4.4's retroactive-publication rule it
 * silently re-admits a measurement taken by a different verifier. Both are
 * undetectable after the fact, which is the worst class of failure this spec has.
 *
 * WHY THE THREAT MODEL IS ALREADY SOLVED HERE. safety/argument-digest.ts exists so
 * that "an Approval authorizes ONE described invocation, identified by a Digest
 * over the exact arguments. The resume path recomputes the digest of what is about
 * to execute and rejects a mismatch." Substitute the nouns: a record is validated
 * against ONE described verifier, and re-evaluation after a floor correction
 * recomputes the digest and rejects a mismatch. Same gap, same defence, same reason
 * to use SHA-256 rather than a fast non-cryptographic hash.
 *
 * NOT A HARDSHIP, and the corpus is the proof: `RatioProblem`
 * (hard-tasks/cost-model.ts:269-287) is already fully data — `params`, `reference`,
 * `body`, `targetOps`, `lowerBoundOps`, every field JSON-serialisable, not one
 * closure. The whole hard-task corpus is already expressible this way.
 */
export interface VerifierSpec {
  /** A registered verifier kind. Resolving it to a callable is the registry's job;
   *  the digest never depends on the resolution. */
  readonly kind: string;
  /** Everything that kind needs, as JSON. Digested with `stableStringify`, so key
   *  order cannot change the identity. */
  readonly spec: JsonValue;
}

/**
 * How an objective supplies its verifier.
 *
 * A bare closure stays legal, because one-off local work should not require
 * registering a kind — but a closure-backed objective has NO DIGEST and is
 * therefore NOT PUBLISHABLE, and the run says so at CALL time rather than
 * discovering it at settle. That keeps the escape hatch open without making the
 * records store's guarantee a fiction.
 */
export type VerifierSource = VerifierSpec | Verifier;

/**
 * The instrument broke.
 *
 * Produced by the HARNESS from a verifier that threw, rejected, or returned
 * something outside {@link Measurement} — never by the verifier itself, which
 * has no way to say this. A fault fails the RUN: no node is scored, no number is
 * published, nothing is written to the records store. That asymmetry is the same
 * one hard-tasks/cost-model.ts:211-216 already draws, where a failing REFERENCE
 * throws and takes the harness down while a failing CANDIDATE comes back as a
 * scored zero.
 *
 * `reason` is `'unavailable'` rather than `'bad_input'` on purpose: a fault is not
 * a decision anything made, and CODE_IS_REFUSAL (obs/error.ts:98-111) classifies
 * it accordingly.
 */
export interface VerifierFault {
  readonly reason: 'unavailable';
  /** Names what the verifier did instead of measuring, and quotes what it
   *  returned when it returned anything. */
  readonly error: string;
}

/**
 * An information-theoretic or physical bound no correct solution may cross.
 *
 * A floor exists so a cheat is DETECTABLE: a candidate below the floor cannot
 * have derived its answer through the measured channel. It is a PROOF, and a
 * floor that is not a proof is worse than no floor at all — see
 * {@link FloorBreach} and docs/EXPLORATION-SPEC.md section 4.3.
 */
export interface Floor {
  /** The bound, in the objective's unit, on the same side as `direction` makes
   *  impossible. For a `minimise` objective, no correct candidate may measure
   *  BELOW this. */
  readonly value: number;
  /** The argument. Prose, required, and required to be an argument rather than a
   *  citation: "the textbook worst case" is not a per-instance certificate, and
   *  substituting one for the other is precisely the majority-vote defect. */
  readonly proof: string;
  /**
   * How the bound was established.
   *
   * `certificate` — the fewest operations any correct algorithm must spend on
   * THIS instance to be able to justify its answer. The only kind safe to use as
   * a floor.
   * `adversary` — a worst-case lower bound. UNSAFE as a floor: a fortunate input
   * lets a correct algorithm finish below it, so an adversary bound used as a
   * floor scores a lucky honest run as a cheat (hard-tasks/tasks.ts:29-39).
   * `physical` — a conservation law or a hardware limit.
   */
  readonly kind: 'certificate' | 'adversary' | 'physical';
  /**
   * The measured cost of the best honest solution known at the time the floor was
   * written, in the same unit.
   *
   * REQUIRED, and it is the mechanical half of the floor's proof. It makes
   * {@link floorMargin} computable, so a floor sitting a hair below the best
   * known algorithm is VISIBLE at declaration time instead of latent until
   * somebody improves the algorithm and gets called a fraud for it.
   */
  readonly bestKnownHonest: number;
}

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
 * perform — the exact class of mistake §4.3's floor was. It is also the predicate
 * §4.5 C1 and the Lean model are stated over.
 */
export function floorMargin(floor: Floor, direction: ObjectiveDirection): number {
  const best = floor.bestKnownHonest;
  if (best === 0) return floor.value === 0 ? 0 : Number.NEGATIVE_INFINITY;
  const room = direction === 'minimise' ? best - floor.value : floor.value - best;
  return room / Math.abs(best);
}

/**
 * A candidate measured past the floor.
 *
 * NOT a verdict on the candidate. Two hypotheses fit this observation — the
 * candidate bypassed the measured channel, or the floor is wrong — and a result
 * consistent with two hypotheses confirms neither. So both are named, the
 * measurement is RETAINED, and the run reports this as its own outcome rather
 * than folding it into a zero. The previous behaviour (score 0, "the measurement
 * channel was bypassed", hard-tasks/cost-model.ts:452-459) picks one hypothesis
 * silently, which is what let a wrong floor stand.
 */
export interface FloorBreach {
  readonly floor: Floor;
  /** Kept in full. A discarded measurement cannot adjudicate the two hypotheses. */
  readonly measured: MeasuredValue;
  /** `bestKnownHonest`-relative room the floor claimed. */
  readonly margin: number;
  /**
   * The two readings, carried as data so the human adjudicating sees both.
   *
   * Fixed at exactly two because exactly two fit, and they demand OPPOSITE
   * responses: `floor_wrong` means re-derive the bound (our majority-vote floor
   * counted one token per `equals` call when a call touches two), while
   * `verifier_gameable` means the candidate found a gap in the measured channel.
   * A breach cannot distinguish them, so nothing downstream may pick one.
   */
  readonly hypotheses: readonly ['floor_wrong', 'verifier_gameable'];
}

/**
 * Whether the records store will accept a write for an objective.
 *
 * A breach voids the FLOOR's guarantee, not the search: the run CONTINUES,
 * because the verifier is still scoring candidates and halting would discard
 * sound work over an unsound bound — and the bound is the thing under suspicion.
 * But publication STOPS, because a leaderboard entry validated against a bound we
 * now know may be wrong is worse than no entry: it is a number someone will
 * quote. This is the one place the design prefers losing data to laundering it.
 *
 * Stated as a REACHABILITY property rather than a guard, which is what makes it
 * checkable: a write requires `'open'`, so a breach makes publication unreachable.
 * That is Lean invariant S7 in docs/EXPLORATION-SPEC.md §10.1.
 */
export type PublicationState =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'sealed';
      /** The breach that sealed it. Every later measurement in this run carries
       *  the caveat rather than inheriting a guarantee that no longer holds. */
      readonly breach: FloorBreach;
      /** Cleared only by a recorded re-derivation. Not by a retry, not by a later
       *  candidate scoring inside the bound — neither is evidence about which
       *  hypothesis was true, and treating the second as exoneration would let one
       *  lucky measurement restore a guarantee nobody re-proved. */
      readonly clearedBy: FloorRederivation | null;
    };

/**
 * A human's replacement for a breached floor.
 *
 * REQUIRED to clear a seal, and required to carry the same burden the original
 * floor did — because a seal cleared by an action nobody can audit reintroduces
 * "a floor is a proof or it is nothing" at the RECOVERY step, which is exactly the
 * failure §4 exists to prevent. This closes a hole in the continuation rule that
 * the rule's own author found rather than the audit.
 */
export interface FloorRederivation {
  /** The replacement floor, carrying its own `proof`, `kind` and
   *  `bestKnownHonest`. A re-derivation that cannot state its proof is not one. */
  readonly floor: Floor;
  /** Why the previous bound was wrong, or why it was right and the verifier was
   *  gameable — i.e. which of `FloorBreach.hypotheses` the human adjudicated, and
   *  on what evidence. */
  readonly adjudication: string;
  readonly at: number;
};

/** A checkable certificate: a witness plus the predicate it must satisfy. */
export interface WitnessObjective {
  readonly kind: 'witness';
  /** What a solution looks like, for the record and for the prompt. */
  readonly witness: string;
  /**
   * Does this witness satisfy the predicate?
   *
   * Returns a {@link Measurement} whose `value` is 1 for a satisfying witness
   * and 0 otherwise, so one harness path handles both kinds. The binary shape
   * is the POINT, not a limitation being hidden: FunSearch names "a 'rich'
   * scoring feedback quantifying the improvements (as opposed to a binary
   * signal)" as a scope condition and rules theorem proving out for exactly this
   * reason, which is our own eval-outcome.ts:24-27 finding published by DeepMind.
   */
  readonly check: VerifierSource;
  /**
   * A scalar the search may climb while the witness stays unfound.
   *
   * Without one, a witness objective handed to a tree is the provable degenerate
   * case: equal values everywhere means the argmax is driven entirely by the
   * exploration term and the tree is a breadth-first enumerator. WITH one, the
   * search optimises the proxy and the witness check runs as a side condition —
   * which is the only honest framing of an unbounded counterexample hunt.
   */
  readonly proxy?: ScalarObjective;
}

/** A measured cost or quality with a direction. The shape a search can climb. */
export interface ScalarObjective {
  readonly kind: 'scalar';
  /** What is measured. Names the row in the records store. */
  readonly metric: string;
  /** The unit, spelled out. `'oracle calls'`, `'ms'`, `'bytes'`, `'accuracy'`.
   *  Required: a number without a unit is not comparable to a number from
   *  yesterday, and comparing across runs is the records store's only job. */
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /**
   * Where the normalised score saturates — a declared "good enough".
   *
   * NOT a baseline. The baseline is MEASURED by the harness before any candidate
   * exists and cannot be supplied by the caller at all, so there is no field for
   * it here. A target at or beyond the measured baseline leaves no range to score
   * on and refuses the run, which is hard-tasks/cost-model.ts:434-440
   * generalised.
   */
  readonly target: number;
  readonly verify: VerifierSource;
  readonly floor?: Floor;
}

/**
 * Several scalars measured together, so a Pareto front is expressible.
 *
 * WITHOUT this, `advance:'pareto'` is unreachable from the surface — one `verify`
 * cannot carry six metrics — while the coverage matrix claims GEPA is expressible.
 * That was a real defect, found by measurement rather than by review: asked for a
 * frontier over six eval metrics, a model reported *"the six specific eval metrics
 * are not provided; the search would need a way to compute each metric for a
 * candidate"* (`AxisErgonomics`, `multi-metric-prompt`). It also broke this spec's
 * own coverage obligation, which requires every axis value to appear in at least
 * one fixture entry.
 *
 * Two independent routes arrived at this field, which is the strongest evidence it
 * is real: the design doc had already noted that AlphaEvolve is FunSearch with a
 * richer evaluator returning a score **dict** — this is that dict.
 *
 * Each component keeps its own unit, direction, scale, target and floor, because a
 * front over metrics that share a direction by assumption is a front over a
 * quantity nobody declared.
 */
export interface VectorObjective {
  readonly kind: 'vector';
  /** At least two. A front over one dimension is an argmax, and `advance:'pareto'`
   *  over a single component is refused for that reason. */
  readonly components: readonly ScalarObjective[];
}

export type Objective = ScalarObjective | WitnessObjective | VectorObjective;

/**
 * What makes two runs comparable.
 *
 * Deliberately narrow. It is the metric and the instrument, and NOTHING about the
 * artifact under work: changing the code and re-running the same benchmark is the
 * SAME objective, which is the entire point of keeping records across runs.
 *
 * NOT in the identity, each for a stated reason:
 * - the floor. A fraud check, not part of what is measured. Two runs with
 *   different floors measure the same thing. It lives in provenance.
 * - the target. It only affects normalisation, and the store keeps RAW values, so
 *   two runs with different targets remain directly comparable.
 * - the search configuration. That is provenance too, and treating it as identity
 *   would mean a better result found by a different preset could never displace
 *   an incumbent — which is backwards.
 */
export interface ObjectiveIdentity {
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  /**
   * A digest of the verifier's own source.
   *
   * A DIGEST rather than a caller-supplied name, because a name is a claim the
   * caller can get wrong, and getting it wrong silently compares incomparable
   * runs. When a verifier changes its digest changes, the identity changes, and
   * old records are not displaced by new ones — both live, with the digest
   * visible, and nothing is quietly overwritten by a differently-instrumented
   * measurement.
   */
  readonly verifierDigest: string;
}

/**
 * Is `candidate` better than `incumbent` in this direction?
 *
 * STRICTLY better — a tie does not displace. A tie carries no signal, and
 * `ORDER BY value DESC` over equal values is row order; mcts/convergence.ts:56-93
 * is the live precedent for refusing to read a winner out of a tie.
 *
 * A named function rather than an inline comparison for three reasons the rule
 * admits: it is the definition monotone displacement (§5.2) is stated over, the
 * Lean invariant S2 (§10.1) quantifies over it by name, and its three intended
 * call sites — displacement, eviction, and a cell's best — must move in lockstep
 * or the store stops being monotone in one of them.
 */
export function isBetter(
  candidate: number, incumbent: number, direction: ObjectiveDirection,
): boolean {
  return direction === 'minimise' ? candidate < incumbent : candidate > incumbent;
}

/**
 * One member of the records store — the leaderboard row.
 *
 * Cell membership is `(objectiveId, descriptor)`; identity within a cell is
 * `artifactDigest`, so a cell holds a bounded POPULATION rather than a single
 * incumbent. That is FunSearch's program database and MAP-Elites' grid, and it is
 * the shape `carry:'elites'` needs: a single incumbent per objective is
 * best-of-N-with-carry, which is FunSearch's own "W/O Evolution" arm and one of
 * its two worst curves at matched program count.
 */
export interface ExplorationRecord {
  /** Digest over {@link ObjectiveIdentity}. The comparability key. */
  readonly objectiveId: string;
  /** The archive cell, for `advance:'archive'`.
   *
   *  NULL means this objective has NO descriptor partition — not "the unnamed
   *  cell". Absent is not zero and it is not empty-string either, which is why
   *  this is nullable with no default all the way down to the DDL (the pattern
   *  heads/schema.ts:63-75 states and heads/journal.ts:51-59 decodes). */
  readonly descriptor: string | null;
  /** Content digest of the artifact. Identity within the cell, so re-recording
   *  the same artifact updates rather than duplicates. */
  readonly artifactDigest: string;
  /** The artifact itself — the program, the witness, the prompt. */
  readonly artifact: string;
  /** RAW measured value in the objective's unit. Never the normalised score. */
  readonly value: number;
  /** `MeasuredValue.detail` as recorded. */
  readonly detail: string;
  readonly measured: Readonly<Record<string, number>> | null;
  /** The preset that produced it, or `'custom'`. */
  readonly preset: string;
  /** `label` when the configuration was composed. NULL for an unmodified preset
   *  run — and under the decision in docs/EXPLORATION-SPEC.md section 6.4, a
   *  named preset is never modified, so NULL here means exactly "a tested path". */
  readonly label: string | null;
  /** `search_nodes.root_id` of the run that found it, so the record points back
   *  at its tree. Not `mcts_search_runs.root_id`: that ledger deletes settled
   *  rows after 24h (mcts/search-store.ts:98,109-110) and would make week-old
   *  records dangle. read-models/fork-runs.ts:243-245 already keys this way. */
  readonly rootId: string;
  /**
   * WHICH FLOOR this record was published under, as a digest over that `Floor`.
   *
   * Not merely the floor's value: the whole bound, so a later correction can tell
   * which entries were admitted under the wrong one. Without this, correcting a
   * floor makes every prior entry's validity UNKNOWABLE rather than merely stale —
   * you would know the bound changed and not which numbers had trusted it.
   *
   * NULL when the objective declared no floor, which is not the same claim as
   * "published under a floor of zero".
   */
  readonly floorDigest: string | null;
  /** The bound's value and argument as they stood, so a reader need not resolve the
   *  digest to see what was claimed. NULL together with {@link floorDigest}. */
  readonly floorValue: number | null;
  readonly floorProof: string | null;
  /** What it cost. Both nullable because absent is not zero: a run whose spend
   *  was never reported spent an unknown amount, not nothing (usage.ts, and
   *  strategy/types.ts:106-110 for the same field on a fork). */
  readonly costUsd: number | null;
  readonly costTokens: number | null;
  readonly firstRecordedAt: number;
  /** How many times this cell's best has moved since this row was written.
   *  A counter, not a history: the trajectory is reconstructible from the trees. */
  readonly displacements: number;
}

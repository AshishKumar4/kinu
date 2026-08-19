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
  /**
   * Per-instance scores, for an {@link InstancedObjective}. REQUIRED for one and
   * meaningless for the others.
   *
   * `value` is then the AGGREGATE and this is the vector the front is computed
   * over — the same pair `gepa_candidates` already persists as `aggregate` beside
   * `scores_json` (evolution/gepa/persistence.ts:78-80). Absent, not empty, when
   * the objective declares no instances: an empty map would claim every instance
   * scored zero.
   */
  readonly perInstance?: Readonly<Record<string, number>>;
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
 * captures produce an IDENTICAL digest and DIFFERENT behaviour. Under *Comparability*
 * that silently compares incomparable runs; under the retroactive-publication rule in
 * *The publication seal* it silently re-admits a measurement taken by a different
 * verifier. Both are undetectable after the fact, which is the worst class of failure
 * this specification has.
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
  /**
   * A verifier kind, drawn from a CLOSED set the registry declares.
   *
   * Closed, not a free string, and the reason is *The closed verifier registry*'s own
   * argument one level up: **a `kind` nobody registered is a fabricated script wearing
   * a type.** An open string would let a caller invent `'exec-ratio'` exactly as a
   * model invented `scripts/simulate_conversion.py`, and that section's one real
   * guard — a fabricated name cannot resolve — would become advisory again. So an
   * unregistered kind is a CALL-TIME `bad_input` naming the registered kinds.
   *
   * Consequence for *Comparability* that follows from closing it: **the registry is
   * part of the objective's identity.** Two runs whose `kind` resolves to different
   * implementations are not comparable, and `argumentDigest({kind, spec})` does not
   * capture that on its own. Found by `FixtureZero` while forcing the JSON boundary.
   */
  readonly kind: string;
  /**
   * Everything that kind needs, as JSON. Model it on `RatioProblem` and keep every
   * field: a spec that drops `lowerBoundOps` leaves the floor nowhere to live, which
   * is what *The floor* requires the field for, and leaves *Floor margin*'s C1/C2
   * checks with no input.
   *
   * WHICH FORM THE DIGEST IS TAKEN OVER, which *Comparability* had left unnamed.
   * `stableStringify` fixes key ORDER and says nothing about key SPELLING — and
   * `objective`'s wire form is snake_case (*Wire form*) while `RatioProblem`'s fields
   * are camelCase. If a naming convention reached inside `spec`, something would
   * transform it between wire and registry, and `verifierDigest` would differ
   * **depending on which side of that transform it was computed on**: two runs of the
   * identical instrument, incomparable, with nothing detecting it. That is
   * *Comparability*'s own failure mode reached through a naming convention. Found by
   * `FixtureZero`.
   *
   * Both halves are needed, and the CANONICAL FORM IS THE WIRE FORM — every digest in
   * this specification is computed on the wire form, after normalisation, once. It is
   * the only form **both the caller and the registry provably see**.
   *
   * For `spec` the two coincide, which is what makes it safe: **`spec` is OPAQUE to the
   * objective's naming convention** — the convention governs the fields this
   * specification declares (`objective`, `metric`, `unit`, `best_known_honest`), not the
   * interior of a payload whose schema the registered kind owns, so `spec` is not a
   * camelCase island in a snake_case namespace but outside that namespace entirely —
   * **and the harness MUST NOT transform `spec`.** With no transform there are not two
   * sides, so "wire form" and "as received" are the same bytes and there is nothing for
   * two honest implementations to disagree about.
   *
   * This completes *Comparability*'s one rule rather than sitting beside it: an
   * identity that names an implementation must digest what the name resolves to,
   * **and must say in which form**.
   */
  readonly spec: JsonValue;
}

/**
 * How an objective supplies its verifier — and the two arms belong to DIFFERENT
 * SURFACES, which an earlier revision left as one union serving two channels.
 *
 * `VerifierSpec` is the ONLY arm reachable from the tool surface. `agents.swarm` is a
 * valibot-validated JSON action, so **the closure arm is unauthorable there, not
 * merely undigestible** — a model cannot send a function at all. Since *Accepted and
 * ignored* makes `objective` REQUIRED on `optimise`, `VerifierSpec` is the only
 * inhabitable arm on the flagship preset.
 *
 * The closure arm exists for IN-PROCESS callers only: tests, the hard-task corpus,
 * core code. It stays legal because one-off local work should not require registering
 * a kind, and a closure-backed objective is NOT PUBLISHABLE — said at CALL time, not
 * discovered at settle.
 *
 * AND THE CLOSURE ARM IS UNGUARDED, WHICH IS THE STRONGER REASON. *The closed
 * verifier registry*'s one real guard is that a fabricated instrument cannot
 * resolve — but **a closure cannot fail to resolve**, so on that arm the guard does
 * not exist. That is why the arm is confined to callers who wrote the closure
 * themselves rather than merely marked unpublishable. Found by `FixtureZero`.
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
 * {@link FloorBreach} and *The floor*.
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
 * Whether a PUBLICATION is permitted for an objective.
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
 * That is Lean invariant S7, in *The Lean invariants*.
 *
 * **This governs SEVERAL surfaces, not this file's records store.** It lives here
 * because the records store is where the seal was first stated, and stating it over
 * one table was a hole, and *The publication seal* carries it as the reason the
 * surface set is wide: `carry:'artifacts'` routed through `experience_library` and
 * called that publication "separate and unchanged", so a breached run could publish
 * cross-workspace while the leaderboard was sealed. The governed set is
 * {@link PUBLICATION_SURFACES} and the gate is {@link admitsPublication} — do not
 * re-derive "it is about the table".
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
 * Every surface through which a search's output can reach a run other than the one
 * that produced it. The seal is stated over THIS SET, not over one table.
 *
 * A write is a PUBLICATION when it makes a candidate's ARTIFACT, or a VALUE
 * measured against the sealed objective, available to a run other than the one that
 * produced it. Both halves are load-bearing: the artifact is what gets reused and
 * the value is what gets quoted.
 *
 * Stating the seal over one table made it a true theorem about a false property —
 * the Lean statement quantified over records-store actions and the laundering
 * channel was not one of them. The members below come from a writer census rather
 * than from the spec's own inventory, which is why there are six and not one:
 *
 * - `records` — the one new table, shared by *The records store* and this seal;
 *   {@link ExplorationRecord} is its row and `recordExploration`
 *   (`strategy/records.ts`) is its writer.
 * - `experience_library` — `experience/library.ts` `publish()`. CROSS-WORKSPACE,
 *   the widest blast radius in the set, and `carry:'artifacts'` routes here.
 * - `craft` — `craft/discovery.ts` `maybeStoreCraftedTool`, called from
 *   `mcts/convergence.ts` and admitted by `winner.value > craftExtractionThreshold`.
 *   Its admission gate is the very value a breach makes suspect.
 * - `memory` — `memory/MEMORY.md` plus `lessons` and `agent_facts`. Vector-indexed,
 *   so it re-enters later turns' context rather than waiting to be read.
 * - `task_history` — `recordTaskOutcome` in `mcts/convergence.ts`. Feeds scaffold
 *   error-rate monitoring, so a laundered score steers evolution.
 * - `scaffold_versions` — `scaffold/modify.ts`, reachable when the artifact IS a
 *   prompt or scaffold (`unit:'generator'`).
 *
 * `craft`, and `memory`'s lessons and facts, are `EXPERIENCE_KINDS` members
 * (`experience/types.ts`), so each is additionally a TWO-HOP egress into
 * `experience_library` via `experience/publishable.ts`. Sealing the library alone
 * would leave the winner's own code walking out through `crafted_tools`.
 *
 * Adding a publication surface without adding it here is a specification
 * violation, and `contract-publication-seal.test.ts` holds both directions: a
 * writer census of the settle path's egress against this set, and set equality of
 * the gate's refused set with it. There is no second table to compare against —
 * *The publication seal* names this constant as the governed set rather than
 * restating its members.
 */
export const PUBLICATION_SURFACES = [
  'records', 'experience_library', 'craft', 'memory', 'task_history',
  'scaffold_versions',
] as const;

export type PublicationSurface = (typeof PUBLICATION_SURFACES)[number];

/**
 * Why a publication was refused, carrying the breach so the caller can disclose it.
 *
 * A refusal is a VALUE rather than a throw, because the caller's next move is to
 * report the suppression *The publication seal* requires, and a thrown seal would be
 * indistinguishable from a store that broke.
 */
export type PublicationVerdict =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'refused';
      readonly surface: PublicationSurface;
      readonly breach: FloorBreach;
    };

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

/** The `carry` values whose whole purpose is publication. `'none'` and
 *  `'reflections'` write nothing a later run reads, so a seal cannot void them —
 *  which is why the suppression disclosure is stated over this subset rather than
 *  over the axis. A containment test pins it against `SWARM_CARRIES`. */
export const PUBLISHING_CARRIES = ['elites', 'artifacts'] as const;

export type PublishingCarry = (typeof PUBLISHING_CARRIES)[number];

/**
 * What a settle report MUST state when the seal voided the run's `carry`.
 *
 * Nine of the 27 matrix techniques use `carry:'elites'` and two use `'artifacts'`.
 * Under a seal both become a no-op and the run spends its whole remaining budget
 * carrying nothing. **The run still does not halt** — the calling turn is the
 * primary consumer and the verifier still works — so silence is the defect, not the
 * spend.
 *
 * Disclosure as DATA, never a rendered string, for the reason behind *Raw units*:
 * every consumer reads fields and nothing downstream couples to how it is rendered.
 */
export interface CarrySuppression {
  /** The configured value that was voided. Naming it beats "publication stopped",
   *  which tells a reader nothing about what the run was trying to do. */
  readonly carry: PublishingCarry;
  readonly breach: FloorBreach;
  /** Every enumerated surface the carry would have written and did not. */
  readonly refused: readonly PublicationSurface[];
  /**
   * DISTINCT cells whose best the run reached and could not record. Counted once
   * per cell, however many times that cell's best moved and however many surfaces
   * refused it.
   *
   * The load-bearing field, and the reason is the monotone invariant in *The records
   * store*: a sealed run that found a better elite and could not write it means the
   * NEXT run's carry starts from a worse elite than the search actually reached. The
   * seal degrades FUTURE runs, not only this record, and that is invisible without a
   * number.
   *
   * **The cardinality follows from what the number is FOR, and it is deliberately
   * not the count of refused publications.** Future damage is one fact per cell —
   * the next run starts from a worse best in cell C, or it does not — so a cell
   * whose best improved three times mid-run still costs the next run exactly one
   * thing, and counting three would overstate the harm. Lean's
   * `suppression_counts_every_refusal` counts refused publication ATTEMPTS instead,
   * which is the right quantity for proving the disclosure cannot under-report and
   * the wrong one for reporting damage. The two numbers differ on purpose.
   */
  readonly suppressedCells: number;
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

/**
 * A human's replacement for a breached floor.
 *
 * REQUIRED to clear a seal, and required to carry the same burden the original
 * floor did — because a seal cleared by an action nobody can audit reintroduces
 * "a floor is a proof or it is nothing" at the RECOVERY step, which is exactly the
 * failure *The floor* exists to prevent. This closes a hole in the continuation rule
 * that the rule's own author found rather than the audit.
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
 * ONE metric measured over MANY INSTANCES, so a per-instance Pareto front is
 * expressible. This is GEPA's front, and it is NOT {@link VectorObjective}'s.
 *
 * THE CONFLATION THIS EXISTS TO FIX. An earlier revision made `advance:'pareto'`
 * require a `VectorObjective` and refuse a scalar — which refused GEPA's own
 * configuration, i.e. the sole technique that earns the axis value. GEPA's front is
 * over TASK INSTANCES under ONE metric: arXiv:2507.19457 Algorithm 2 line 4 is
 * `s*[i] <- max_k S_P[k][i]` with `i` indexing instances, and *The objective*
 * defines a single metric. Our own implementation says the same thing and is the
 * first-hand proof:
 * `gepa_pareto_membership` is keyed `(run_id, instance_id, candidate_id)` with ONE
 * `score` (evolution/gepa/persistence.ts:89-95), `scores_json` is
 * `Map<instanceId, number>` (:23), and `computeParetoFront(pool, instanceIds)`
 * comments "For each instance, find the max score" (gepa/pareto.ts:39).
 *
 * The spec had the right reading elsewhere and disagreed with itself: *What the
 * engine refuses outright* already said `advance:'pareto'` needs a gradient ACROSS
 * INSTANCES and cited SEIDR's lexicase result, lexicase being the canonical
 * per-instance operator. Found by `SpecAudit`/`SpecEvidence`, severity `wrong`.
 */
export interface InstancedObjective {
  readonly kind: 'instanced';
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  readonly target: number;
  /** At least two. The front's axes ARE these — one metric, compared per instance,
   *  which is why they share `metric`/`unit`/`direction` rather than each carrying
   *  their own. A front over one instance is an argmax. */
  readonly instances: readonly string[];
  /** Returns a {@link MeasuredValue} whose `perInstance` is populated for every
   *  declared instance and whose `value` is the aggregate — the same pair
   *  `gepa_candidates` stores as `scores_json` beside `aggregate` (:78-80). */
  readonly verify: VerifierSource;
  readonly floor?: Floor;
}

/**
 * Several DIFFERENT metrics measured together — a per-metric front.
 *
 * This is AlphaEvolve's score **dict**, which the design doc had already named as
 * the only thing separating AlphaEvolve from FunSearch, and it is the shape a caller
 * asking for "the frontier over our six eval metrics" wants
 * (`AxisErgonomics`, `multi-metric-prompt`: *"the six specific eval metrics are not
 * provided; the search would need a way to compute each metric for a candidate"*).
 *
 * Each component keeps its OWN unit, direction, scale, target and floor — which is
 * exactly what distinguishes it from {@link InstancedObjective}, whose axes share one
 * metric. A front over metrics that share a direction by assumption is a front over a
 * quantity nobody declared.
 */
export interface VectorObjective {
  readonly kind: 'vector';
  /** At least two. A front over one dimension is an argmax. */
  readonly components: readonly ScalarObjective[];
}

export type Objective =
  | ScalarObjective
  | InstancedObjective
  | VectorObjective
  | WitnessObjective;

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
   *  run — and *Presets* states that a named preset is never modified, so NULL here
   *  means exactly "a tested path". */
  readonly label: string | null;
  /** `search_nodes.root_id` of the run that found it, so the record points back
   *  at its tree. Not `mcts_search_runs.root_id`: that ledger deletes settled
   *  rows after 24h (mcts/search-store.ts:98,109-110) and would make week-old
   *  records dangle. read-models/fork-runs.ts:243-245 already keys this way. */
  readonly rootId: string;
  /**
   * Digest over the FULLY RESOLVED configuration — the seven axes, every
   * axis-parameter, and every cap actually in force.
   *
   * One column rather than one per field, so it cannot go stale as fields are added.
   * It exists because an un-parameterised run otherwise leaves no record of the shape
   * it got, and **an ABSENT default is worse than a wrong one**: a wrong default is
   * visible in the record and arguable, whereas an absent one means the shape is
   * decided by whatever the implementation happens to do and the record cannot report
   * a number the spec never named.
   */
  readonly configDigest: string;
  /** Denormalised beside {@link configDigest} for reading, the same way
   *  {@link floorValue} sits beside {@link floorDigest}: a leaderboard row should not
   *  have to resolve a digest to say how deep and how wide the search was. */
  readonly depth: number;
  readonly branches: number;
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

/**
 * The shape of a configured search: the axes, six presets, one escape hatch —
 * and what a call resolves to, whether that resolution is legal, and what a run
 * reports.
 *
 * Specified by docs/EXPLORATION.md — "The six axes", "One spelling per axis",
 * "Presets", "Validity over the resolved configuration", "Settle is derived" and
 * "Arbitration".
 *
 * The axes are derived from a 27-technique coverage matrix rather than chosen; the
 * matrix, not this file, is the argument for how many there are.
 *
 * WHAT A PRESET IS. A preset fixes the search. The caller supplies the objective.
 * Those are the two halves of a call and they never mix: `config` is axes only,
 * and a named preset does not accept it at all, which is the rule *Presets* states.
 *
 * WHY THE TABLE, THE RESOLVER AND THE PREDICATE ARE ONE MODULE. Legality is checked
 * over the RESOLVED configuration — *Validity over the resolved configuration* — so
 * the predicate is meaningless without the resolution and the resolution is
 * meaningless without the preset table of *Presets*. Written apart, the table became
 * prose nothing read: a preset was called a "named point" for four
 * revisions with no point written down, and the predicate had no input for a NAMED
 * preset at all. {@link SWARM_PRESET_POINTS} is therefore the fixture and the
 * resolver at once, which is deliberate — two spellings of the preset points would
 * drift exactly as *One spelling per axis* describes.
 */

import { KinuError, refusalOf } from '../obs/error';
import { argumentDigest } from '../safety/argument-digest';
import { isJsonObject, type JsonValue } from '../utils/json';
import { VERIFIER_KIND_DOC, VERIFIER_KINDS, floorMargin } from './objective';
import { DEFAULT_CONFIG } from '../config';
import type {
  CarrySuppression, Floor, MeasuredValue, Objective, ObjectiveDirection, ParetoEvidence,
  PublicationState, VerifierKind, VerifierSpec,
} from './objective';
import {
  NAMED_SWARM_PRESETS,
  type NamedSwarmPreset,
  type SwarmPreset,
} from './swarm-presets';
export {
  NAMED_SWARM_PRESETS,
  SWARM_PRESETS,
  type NamedSwarmPreset,
  type SwarmPreset,
} from './swarm-presets';
import type { SwarmProfileSnapshot } from '../profiles/snapshot';
import type { ExplorationRecordsReport } from './records';

/**
 * What one node PRODUCES.
 *
 * `answer` is the AGENT node — a tool loop with its own turns and its own
 * transcript (*A node is an agent*). `thought` is the degenerate point *The six
 * axes* names: one model call, no tools, no observation of an environment because
 * it has no way to touch one. It is the CHEAP TIER rather than a defect, and
 * Tree-of-Thoughts is that point plus a selector.
 *
 * `generator` is gone, and it is gone for the reason `decorrelate` went: it named
 * a distinction NOTHING IMPLEMENTED. It was documented as "the generator that
 * produces candidates" against `answer`'s "one candidate", but the whole surface
 * branches on this axis exactly once — `swarm-run.ts`'s `unit.kind !== 'thought'`
 * — and no prompt, no expansion, no node host and no settle path ever read the
 * value again. Every `generator` run WAS an `answer` run with a different word in
 * its argument digest. A public axis value that changes no behaviour is a promise
 * the engine does not keep, so the axis is the two values it actually has; a
 * caller who writes the third is told so by name (`CUT_GENERATOR` in
 * `tools/swarm-input.ts`) rather than silently handed `answer`.
 *
 * `trajectory` is gone and `step` with it. `trajectory` named the shape this axis
 * now HAS at its agent value, so keeping it would be two spellings of one
 * thing — and the parameter it carried (does this node start from the caller's
 * conversation) is the {@link SWARM_CONTEXTS} question, asked once for the whole
 * surface instead of twice with two names. `step` never executed at all.
 */
export const SWARM_UNITS = ['answer', 'thought'] as const;
export type SwarmUnit = (typeof SWARM_UNITS)[number];

/**
 * What a child STARTS FROM — *Inherited context* — and the one axis that spans the
 * caller-to-root edge and every parent-to-child edge with a single spelling.
 *
 * `fork` — the child inherits the parent's context VERBATIM, plus the parent's
 * reported results, plus its own focus. Verbatim is a decision about CACHING and
 * not about fidelity: an unmodified prefix is a prefix a provider can cache, so
 * every sibling of one parent shares one cacheable prefix, and rewriting the
 * history to hand each child a summary breaks that prefix for all of them at once.
 *
 * `fresh` — the last two and nothing else. Not "start blank": a fresh child is
 * SEEDED with what its parent reported, which is a third thing from both inheriting
 * everything and starting from nothing, and it is the one *Inherited context* names
 * explicitly.
 *
 * The only difference between the two values is the inherited conversation, which
 * is what makes them two values of one axis rather than two mechanisms.
 *
 * IT MAY NARROW DOWN THE TREE AND NEVER WIDEN. A search resolved to `fresh`
 * refuses a `fork` child and says so, rather than quietly honouring one of two
 * conflicting policies — the same asymmetry as an inner mission cap only ever
 * being tighter than its outer one (`agents-tool.ts`'s cap doc), and the arbiter's
 * fifth arm.
 */
export const SWARM_CONTEXTS = ['fork', 'fresh'] as const;
export type BranchContext = (typeof SWARM_CONTEXTS)[number];

/**

 * How children are produced.
 *
 * `aggregate` is fan-in — k parents consumed by one child — and it is precisely
 * what makes a graph a DAG rather than a tree. Graph-of-Thoughts' `Aggregate`
 * vertex and Mixture-of-Agents' layers are both this value.
 *
 * `mutate` was CUT. It asked what a child starts from — the parent's own answer
 * rather than the workspace as found — and that is the {@link SWARM_CONTEXTS}
 * question, asked once for the caller-to-root edge and every branch edge
 * together. Two axes asking one question is the second spelling *One spelling per
 * axis* exists to prevent, and `context` is the one that also binds the root.
 */
export const SWARM_EXPANDS = ['sample', 'aggregate'] as const;
export type SwarmExpand = (typeof SWARM_EXPANDS)[number];

/**
 * How a node is valued.
 *
 * TWO VALUES WERE CUT AND THEY WENT DIFFERENT WAYS. `agree` was `judge` with the
 * population as the judge, and the ensemble it needed already lives on the judge
 * arm as `samples` — so it was a second spelling of a value this axis already
 * had. `novelty` was never a grader at all: it is an archive's ADMISSION rule,
 * and it re-homed onto {@link SwarmAdvanceSetting}'s `archive` arm, where the
 * parameter cannot exist unless the archive that owns it does.
 */
export const SWARM_SCORES = ['verify', 'judge', 'none'] as const;
export type SwarmScore = (typeof SWARM_SCORES)[number];

/**
 * Where the next unit of budget goes.
 *
 * `beam` was CUT, and unlike the others it TOOK SOMETHING WITH IT rather than
 * collapsing onto an equivalent. Best-first plus a level barrier is a SCHEDULE
 * and not a selector — the selection rule is identical, the difference is only
 * that a whole level is expanded before the next is entered. What is gone is
 * that level-synchronised order and the `beamWidth` that ranked it; there is no
 * composition that reproduces it, and a caller who wanted level-synchrony now
 * gets best-first's frontier order instead. The barrier itself survives for a
 * different owner: shared compaction and comparative sibling judging both need
 * one, so it is a property of a level rather than of a selector.
 */
export const SWARM_ADVANCES = [
  'uct', 'best-first', 'pareto', 'archive', 'none',
] as const;
export type SwarmAdvance = (typeof SWARM_ADVANCES)[number];

/** What survives across iterations. `elites` and `artifacts` are what the records
 *  store persists; the store IS where this axis lands. */
export const SWARM_CARRIES = ['none', 'reflections', 'elites', 'artifacts'] as const;
export type SwarmCarry = (typeof SWARM_CARRIES)[number];

/**
 * How a run reports its answer.
 *
 * DERIVED from `score` and `advance`, never supplied. That is what keeps it from
 * being an eighth axis: a caller who could set it independently could ask for a
 * scalar winner out of an archive run, which is not a thing that exists.
 */
export type SwarmSettle = 'best' | 'archive' | 'front' | 'merge';

/**
 * An axis value together with the parameters that belong to THAT value.
 *
 * WHY TAGGED RATHER THAN FREE FIELDS BESIDE THE AXIS. `judgeSamples` was a required
 * field on the config, which made the preset table of *Presets* — normatively
 * `resolve(preset) -> SwarmConfig` — **unconstructible for every row**, because a
 * preset that does not score by judge has nothing to put there. Proven by the
 * compiler, not by reading (`FixtureZero`, TS2741).
 *
 * The three ways out were not equal, and only one makes the invalid state
 * UNREPRESENTABLE rather than merely refused:
 *  - optional `judgeSamples?` — then the refusal under *Validity over the resolved
 *    configuration* is stated over an ABSENT input, and absent-is-not-zero is this
 *    document's founding rule. It manufactures the very shape the audit just removed:
 *    a gate that cannot see its own input.
 *  - `judgeSamples` inheriting the live default of 3 — then every preset that does
 *    not score by judge ships below the marginalisation bar and the record cannot say
 *    whether 3 was chosen or inherited, which is the absent-default defect one level
 *    up.
 *  - TAGGING it onto `judge` — the parameter cannot exist unless the value that owns
 *    it does, so there is no absent case to reason about at all.
 *
 * This is the same move as {@link Measurement} having no `fault` member and as
 * `subordinates/depth.ts` making a child's depth unstateable: the number a config
 * would have to lie about is one it never supplies.
 */
export type SwarmScoreSetting =
  | { readonly kind: 'verify' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'judge';
      /** Ensemble size. REQUIRED here and unrepresentable elsewhere, so the
       *  marginalisation refusal always has its input — *Validity over the resolved
       *  configuration*. */
      readonly samples: number;
    };

/**
 * Where the next unit of budget goes, together with the parameter that belongs to
 * exactly one of those places.
 *
 * THIS IS WHERE `novelty` LIVES NOW, and the move is the same one {@link
 * SwarmScoreSetting} records for `judgeSamples`. `novelty` sat on `score` as
 * though it graded a node, and it does not: it decides whether a candidate is
 * ADMITTED to an archive cell, which is a property of the archive and of nothing
 * else. While it was a score, the shipped refusal *"an archive with score:X has no
 * novelty rejection test"* had to exist, because the two were independently
 * settable and the invalid pair was reachable. Tagged onto the arm that owns it,
 * an archive without a rejection test cannot be WRITTEN DOWN — the refusal is not
 * relaxed, it is dissolved, which is strictly stronger than being enforced.
 *
 * IT COSTS SOMETHING AND THE COST IS REAL. A preset that resolves to `archive`
 * must state its τ, because *Presets* forbids a preset implicitly declaring
 * one — the 0.6 behind this axis is Rainbow Teaming's measured filter offered
 * as evidence that a rejection test is needed, not a threshold this
 * specification declares. The preset table now pays that cost in the open:
 * `research`, `audit` and `redteam` each declare their admission threshold
 * (advance archive ≥0.4) and all three resolve. They spent a season refusing
 * as UNDECLARED rows until the owner ruled the refusal was the defect and the
 * declarations landed. Inventing a number here is still the one thing this
 * file may not do — the table declares it, or the row does not resolve.
 */
export type SwarmAdvanceSetting =
  | { readonly kind: 'uct' }
  | { readonly kind: 'best-first' }
  | { readonly kind: 'pareto' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'archive';
      /**
       * The novelty floor a candidate must clear to be admitted to its cell.
       * REQUIRED here and unrepresentable elsewhere: an archive that accepted
       * everything collapses onto one prompt across every cell while still
       * reporting coverage — measured at self-BLEU 0.42 → 0.79 when the filter
       * was dropped.
       */
      readonly novelty: number;
    };

export type SwarmCarrySetting =
  | { readonly kind: 'none' }
  | { readonly kind: 'elites' }
  | { readonly kind: 'reflections'; readonly threshold: number }
  | { readonly kind: 'artifacts'; readonly threshold: number };

/**
 * The `unit` axis, UNTAGGED — and the note recording why it stopped being tagged.
 *
 * It carried `inherit` on a `trajectory` value, on the argument that only an agent
 * node has a conversation to start from. Both halves of that argument have since
 * become false in the same commit: every node except `thought` is now an agent, so
 * the parameter would belong to two of three values rather than one, and the
 * question it asked is the {@link SWARM_CONTEXTS} axis, which asks it once for the
 * caller-to-root edge and every branch edge together. *One spelling per axis*: *"the
 * caller-to-root edge and every branch edge are the same question and MUST have the
 * same spelling"* — two fields, two names, one question, with a docstring whose only
 * job was telling a reader they were different.
 *
 * A tagged shape kept for a parameter that moved would be the second spelling
 * *One spelling per axis* exists to prevent, so the variant is a plain union: the
 * remaining tagged axes are {@link SwarmScoreSetting} and {@link SwarmCarrySetting},
 * which still carry parameters no other value of theirs can hold.
 */
export type SwarmUnitSetting =
  | { readonly kind: 'answer' }
  | { readonly kind: 'thought' };

/**
 * The rule the types above instantiate, and its ONE honest exception.
 *
 * **Where a parameter belongs to exactly one axis value, it lives ON that value.**
 * Applied exhaustively: `samples` to `score:'judge'` and the admission thresholds to
 * `carry:'reflections'`/`'artifacts'`. `unit` carried one and no longer does, for the
 * reason recorded on {@link SwarmUnitSetting}: a parameter belonging to a whole
 * SURFACE rather than to one value is an axis, and {@link SWARM_CONTEXTS} is it.
 *
 * **Where a parameter belongs to a REGION of values it cannot be tagged, and then its
 * applicability condition must be CHECKED rather than assumed.** `pruneThreshold` and
 * `minVisitsForPrune` span every tree selector; `explorationWeight` is `uct`-only but
 * sits beside them so the pruning region reads as one group. Stating the exception is
 * the point — a rule applied to one axis and quietly dropped for another is the
 * "predicate stated but not exhaustively applied" defect *Exhaustive over an axis*
 * exists to close.
 */

/**
 * The resolved configuration a run actually executes.
 *
 * Validity is checked HERE, on the resolved composition, never on the preset name
 * — so a `custom` composition and a preset resolve through one predicate and
 * there is one definition of legal.
 */
export interface SwarmConfig {
  /**
   * What one node produces, and therefore whether it is an agent at all. See
   * {@link SwarmUnitSetting} — `answer` runs a tool loop, `thought` is one model
   * call. That distinction is the ONE thing this axis decides.
   */
  readonly unit: SwarmUnitSetting;
  /**
   * What a child starts from, for the whole search: the caller-to-root edge and the
   * default every branch narrows below. *Inherited context*, and
   * {@link SWARM_CONTEXTS} for why one axis carries both edges.
   */
  readonly context: BranchContext;
  readonly expand: SwarmExpand;
  /**
   * How a node is valued. A TAGGED value rather than a bare string, because
   * `score:'judge'` carries a parameter and the other two do not.
   *
   * `SWARM_SCORES` remains the axis's value set — the tags ARE the values, so the
   * coverage matrix and `settleOf` read `score.kind`.
   */
  readonly score: SwarmScoreSetting;
  /** Where the next unit of budget goes, tagged for the same reason as
   *  {@link score}: `archive` carries the novelty rejection test and the other
   *  four carry nothing. See {@link SwarmAdvanceSetting}. */
  readonly advance: SwarmAdvanceSetting;
  /** What survives, tagged for the same reason as {@link score}: two of the four
   *  values carry an admission threshold and two do not. */
  readonly carry: SwarmCarrySetting;
  /**
   * UCT's exploration constant. Applies ONLY to `advance:'uct'` and is otherwise
   * ignored — see the region note below for why this one is not tagged.
   */
  readonly explorationWeight?: number;
  /**
   * Pruning policy. Applies to the REGION of tree selectors (`uct`, `best-first`)
   * rather than to one axis value, which is why it cannot be tagged
   * onto a value the way {@link score} is. **Its applicability condition must
   * therefore be CHECKED rather than assumed**: supplying either under
   * `advance:'archive'`/`'pareto'`/`'none'` is a refusal, not a silent no-op, because
   * a parameter that is accepted and ignored is a lie about what a run did —
   * *Accepted and ignored*.
   */
  readonly pruneThreshold?: number;
  readonly minVisitsForPrune?: number;
  /**
   * NOTE what is deliberately NOT here: `branches`, `depth` and `models`. All three
   * are per-run choices rather than technique identity — ToT at branches=3 and ToT at
   * branches=8 are the same TECHNIQUE, and so is ToT routed across a cheap and a
   * strong model — so none of them spans the coverage matrix. They live on
   * {@link SwarmInput} where EVERY preset can set them.
   *
   * Each was moved after being measured missing. Width: with `branches` in `config`,
   * a named preset (which takes no `config`) could not say "eight candidates", and
   * models reported that absence unprompted. Model routing: with `models` in
   * `config`, no named preset could do capability-and-cost routing at all — the one
   * use of model variety that measured correct 3/3.
   */
}

/**
 * ONE NODE'S EXPLICIT ASSIGNMENT: the question it is asked, and the brief it is
 * asked it under.
 *
 * The SHAPE the search is written over; `tools/swarm-input.ts` owns the wire schema
 * that admits it and is annotated with this type, exactly as `Objective` and
 * `SwarmConfig` are. Two fields and not three: `context` is a run-level axis because
 * it is what makes siblings comparable, and `prompt` IS the brief — the engine
 * carries it in the branch `rationale` the expansion path already reads, so a node's
 * assignment lands in the two journal columns it has always landed in.
 */
export interface SwarmNodeAssignment {
  readonly task: string;
  readonly prompt: string;
}


/**
 * A call.
 *
 * `config` and `from` appear only with `preset:'custom'`. That is the decision
 * *Presets* records and it is load-bearing three ways: it keeps one spelling per
 * resolved configuration (two spellings drift — identity/schema.ts:98-106 already
 * carries a second `crafted_tools` DDL that disagrees with the canonical one), it
 * keeps a named preset unrefusable (validity runs on the resolved composition, so
 * a preset that accepted `config` could be refused, and a refusable preset is not
 * a tested path), and it keeps `preset` a reliable provenance key in the records
 * store, which is the only reason the store can compare anything.
 */
export interface SwarmInput {
  readonly preset: SwarmPreset;
  /** Prose. What the work is. Never where the measured quantity goes. */
  readonly task: string;
  /**
   * What is measured, which direction is better, and in what unit.
   *
   * Required for `optimise`, and for any `custom` composition whose resolved
   * `score` is `'verify'`. Refused as `bad_input` when absent, with the error
   * naming the presets that need none.
   */
  readonly objective?: Objective;
  /**
   * The coverage key `advance:'archive'` bins its elites by, required under that value
   * and refused under every other.
   *
   * WHAT IT MUST NAME, now that an archive runs: a quantity the objective's own
   * INSTRUMENT reports — a member of `MeasuredValue.measured` — because the cell a
   * candidate lands in is witnessed by the same measurement that produced its value.
   * *Measured baseline* forbids a candidate supplying its own number and *The archive*
   * refuses a judged descriptor, which leaves the instrument as the only thing entitled
   * to say where an answer belongs. A key naming nothing the instrument reports is
   * refused as soon as the baseline measurement says what it does report.
   *
   * That bounds it to a quantity an instrument COUNTS. The categorical keys named for
   * the archive presets — an ATT&CK tactic, a finding class — need a registered
   * verifier kind that reports one, and until one does, a key that can only say
   * "distinct idea" is a task with no coverage objective and that task wants `ideate`.
   */
  readonly key?: string;
  /**
   * The axes, REQUIRED with `custom` and prohibited otherwise.
   *
   * PARTIAL, because it is the OVERRIDE half of a composition: with `from` it
   * states only what differs from that row, and with no `from` there is no row to
   * inherit from, so it must name all seven axes — refused naming the ones it
   * missed rather than resolved to whatever a default would have been.
   */
  readonly config?: Partial<SwarmConfig>;
  /**
   * A named preset used purely as a starting point, so a caller need not spell
   * seven axes. It does NOT make this a preset run — the record still says
   * `custom`, which is the whole point of having both fields.
   */
  readonly from?: NamedSwarmPreset;
  /** REQUIRED whenever `config` is present. Provenance: a composed shape recorded
   *  repeatedly under one label is the evidence for a sixth preset, and that
   *  mechanism only works if composed runs are distinguishable from preset runs. */
  readonly label?: string;
  /**
   * What this search is called — a SHORT handle the reader of the exploration
   * surface meets instead of a truncated task paragraph. Optional on every
   * call. It is display identity, not provenance: it never enters the validity
   * table or a record's config digest, and a run without one is named by
   * derivation from its task rather than left anonymous.
   */
  readonly name?: string;
  /**
   * How many candidates are produced per expansion. A RESOURCE CAP, available on
   * every preset including the named ones.
   *
   * Here rather than in {@link SwarmConfig} because width does not span the
   * coverage matrix, and because its absence was measured: with it in `config`,
   * `preset:'optimise'` had no way to express "eight candidates" and models said
   * so unprompted across several vendors.
   */
  readonly branches?: number;
  /**
   * How deep the search may go. A RESOURCE CAP, on every preset.
   *
   * Distinct from the two other depth counters in this repo and never
   * interchangeable with them: `DEFAULT_HEAD_BUDGET.maxDepth` (3) bounds recursive
   * head splitting and `DELEGATION_MAX_DEPTH` (4) bounds the subordinate tree.
   * This one bounds a search TREE, whose live default of 20 (config.ts:92) is
   * above every system in the literature (ToT <=3, LATS 7, Koh 5).
   */
  readonly depth?: number;
  /**
   * THE FIRST LEVEL, NODE BY NODE: what each one is asked, and the brief it is
   * asked it under. Mutually exclusive with {@link branches}, which is the
   * COUNT-based mode where the engine hands out its own diversity angles.
   *
   * WHY IT IS HERE. Every other per-node assignment in this engine arrives as a
   * parent's proposal, and at level 1 the parent is the ROOT — the workspace as
   * found, which no model wrote and which therefore proposes nothing. So every
   * sibling of the first level received `task` verbatim and differed only by a
   * canned angle, and no axis could say otherwise: the six are run-scoped single
   * values and `branches` is an integer. This field is the root's proposal,
   * written by the caller.
   *
   * `nodes.length` IS the branch count, so declaring both is refused rather than
   * resolved by precedence — two numbers for one width is exactly the drift the
   * caps table exists to prevent. Every `task` must be distinct: a search whose
   * nodes were explicitly assigned the same question is paying N times for one
   * answer, and the caller who wanted that wanted `branches`.
   */
  readonly nodes?: readonly SwarmNodeAssignment[];
  /**
   * Per-node model routing, for CAPABILITY AND COST ROUTING — a cheap model for
   * recon, a strong one for synthesis. Available on EVERY preset, and OPTIONAL:
   * absent, every node runs the one model the call resolved to, which is the
   * unchanged default.
   *
   * NOT for diversity. Self-MoA (2502.00674) re-ran Mixture-of-Agents' own
   * ablation over the same six models and found the HOMOGENEOUS ensemble beat the
   * mixed one 65.7 vs 59.1 with the proposer count and topology held fixed (six
   * proposals, one aggregator; the paper claims no cost parity), quality
   * dominating diversity by up to 3.2×. A model zoo is measured WORSE than
   * repeated sampling from the best model when the purpose is diversity; the
   * run's diversity is bought with sibling angles and always has been. Cost
   * routing is understood 3/3 across vendors, so the field earns its place for
   * that alone.
   *
   * ASSIGNMENT IS ROUND-ROBIN OVER THE EXPANSION CHILDREN, by slot: the child at
   * index `i` of its wave runs `models[i % models.length]`. Two properties fall
   * out of that rule and both are why it is stated here rather than left to the
   * implementation. It is DETERMINISTIC — the same call routes the same slot the
   * same way across every re-entry, because the slot is durable — and it needs no
   * relation to the width: a list of one names every node's model, and a list
   * longer than the wave is truncated by the modulo rather than refused, so a
   * caller tuning one shared list across presets of different widths never meets
   * a composition rule. A fan-in's vertex is one child of one, so it runs the
   * first spec — the merge node is graded like any other candidate, and the spec
   * it runs is decided by its slot rather than by what it is.
   *
   * MUTUALLY EXCLUSIVE WITH `tier`: `tier` is the one RUN-level routing input
   * and `models` routes per node, so a call naming both has stated two different
   * routing decisions for one search and is refused rather than resolved by
   * precedence.
   *
   * RESOLVED THROUGH THE ONE SEAM the actor already routes a delegation's tier
   * through (`AgentsForkDeps.resolveModel`), so there is no second resolver and
   * no provider drift. An unresolvable spec is refused as `bad_input` naming
   * the spec, BEFORE any node runs — the refusal this field's first life lacked,
   * which is the whole of what its removal bought and what its return must keep.
   */
  readonly models?: readonly string[];
}

/**
 * A refusal.
 *
 * Returned as a VALUE, never thrown, so the model can branch on it and the
 * read-model can classify it without guessing — the convention
 * agents-tool.ts:482-489 already holds. `reason` is an `ErrorCode`
 * (obs/error.ts:71-83); the text says WHY and what to do instead, so the axes
 * teach their boundary rather than inviting a blind retry.
 */
export interface SwarmRefusal {
  readonly reason: 'bad_input';
  readonly error: string;
}

/**
 * How a run of this shape reports its answer.
 *
 * Total over (`score`, `advance`) by construction, which is the property that
 * makes `settle` derived rather than an axis. Written as a function so the
 * exhaustiveness is a compile-time fact and a new `advance` value cannot silently
 * fall through to `'best'`.
 */
export function settleOf(config: SwarmConfig): SwarmSettle {
  if (config.advance.kind === 'archive') return 'archive';
  if (config.advance.kind === 'pareto') return 'front';
  if (config.score.kind === 'none' && config.advance.kind === 'none') return 'merge';
  return 'best';
}

/* ── Resolution: the preset table IS the resolver ─────────────────────────── */

/**
 * One preset's declared point: its seven axes, plus the two caps it DEFAULTS.
 *
 * `depth` and `branches` sit here rather than inside {@link SwarmConfig} because
 * they are defaults for caps a caller may override rather than axis values — *The
 * six axes* is the enumeration and neither is in it — and because with them in
 * `config` no named preset could have set either one.
 */
export interface SwarmPresetPoint {
  readonly config: SwarmConfig;
  readonly depth: number;
  readonly branches: number;
  /**
   * What this preset is FOR, in one clause — the only half of its doctrine a
   * renderer cannot derive.
   *
   * It sits ON THE ROW because the alternative is what this table already paid for
   * once: doctrine written beside the table drifted from it, `prove` became
   * selectable while being named in none of the four hand-written copies, and three
   * rows went on being described as working after they had stopped resolving. The
   * MECHANICAL half of every sentence — the width, the depth, the selector, where
   * survivors go, and what naming an `objective` changes — is derived from the axes
   * beside it by {@link SWARM_PRESET_DOCTRINE}, so a row that changes shape changes
   * its own description in the same edit.
   *
   * Written WITHOUT the preset's own name, which the renderer prefixes: a row that
   * spelled its name in prose could be renamed in the vocabulary and go on
   * introducing itself as the old one.
   */
  readonly doctrine: string;
}

/**
 * A row of the preset table. Every row is a POINT.
 *
 * THERE USED TO BE A SECOND ARM. A row could be `{undeclared}` — a preset naming a
 * tagged axis value whose parameter the table declined to state — and
 * {@link resolveSwarm} refused that preset quoting the missing declaration. Three
 * rows sat in it and the refusal was honest, but *Presets* requires a named preset to
 * be UNREFUSABLE, and a preset that cannot be constructed is not a preset. The arm
 * also poisoned the one escape hatch its own refusal text recommended: `custom` with
 * `from` naming an undeclared row inherited the refusal, so the way out named by the
 * error did not work.
 *
 * The three parameters are now declared, each converted or adopted from a number this
 * repository already holds rather than chosen here — see the rows. With no row left to
 * refuse, the arm is REMOVED rather than left empty and guarded: an unconstructible
 * row can no longer be written down, which is strictly stronger than refusing one, and
 * it is the same move that put `novelty` onto the archive arm.
 */
export type SwarmPresetRow = SwarmPresetPoint;

/**
 * The tuple table *Presets* requires, normatively `resolve(preset) → SwarmConfig`
 * and the ONLY definition of it. A named preset resolves to exactly its row; `custom`
 * resolves to `config`, optionally seeded from `from`'s row. There is deliberately
 * no `custom` row: `config` IS the override and `from` names the base, and a second
 * row would be the second spelling *One spelling per axis* exists to prevent.
 *
 * EVERY ROW IS DECLARED. Three of them — `research`, `audit`, `redteam` — used to be
 * `{undeclared}`, each naming a tagged arm whose parameter the table did not state,
 * and each therefore refused. That refusal was accurate and the preset was still
 * useless: the shapes all three describe were reachable through `custom` on the same
 * axes on the same day, so the table was declining to name a tuple the engine already
 * ran. Naming it is not inventing it.
 *
 * NEITHER NUMBER IS CHOSEN HERE, and that is the whole reason they may now be written:
 *
 *  - `novelty: 0.4` is Rainbow Teaming's τ=0.6 CONVERTED. τ is a similarity ceiling
 *    and this axis is a distance floor, and {@link archiveRegionRefusal} already
 *    states the conversion in the text it refuses with — "a filter quoted as a
 *    similarity ceiling is one MINUS that number here". 0.6 written into this column
 *    unconverted would be a stricter archive than the evidence describes, which is the
 *    error that text exists to catch.
 *  - `threshold: 0.8` is `craftExtractionThreshold`, and that number is itself DERIVED
 *    rather than picked: it is the pass band's midpoint, PASS_FLOOR 0.60 + ½·PASS_SPAN
 *    0.40, reachable only by executed code carrying an at-or-above-median judge and
 *    unreachable by any prose branch, which caps at 0.75. It is already this
 *    repository's bar for publishing an artifact derived from a search winner, and a
 *    coverage finding is the same kind of object answering the same question. Two bars
 *    for one question is how they come to disagree.
 *
 * `prove`'s own threshold stays 1 and stays derived from its own instrument: its
 * checker accepts or it does not, so an artifact is kept exactly when it accepted.
 */
export const SWARM_PRESET_POINTS = {
  ideate: {
    config: {
      // The row states `fresh`. A flat ideation wave has no parent conversation to
      // inherit — the root's parent is the caller, and `context` binds the branch
      // edge, of which this preset has none.
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'none' }, advance: { kind: 'none' }, carry: { kind: 'none' },
    },
    // Depth is one BY CONSTRUCTION rather than by choice: `advance:'none'` means there is no
    // selection step, so there is no second level to reach.
    depth: 1,
    branches: 5,
    doctrine: 'returns a set of distinct approaches, unranked. Reach for it when the thing you '
      + 'want is not measurable: it has no value signal by design and refuses an `objective`.',
  },
  /**
   * The three COVERAGE rows. They are archive runs and they differ on two things
   * only: what their `key` means to a caller — an information-gathering dimension, a
   * finding class, a tactic — and where their survivors go.
   *
   * `fresh` rather than `fork`: a probe of a new coverage cell wants the parent's
   * RESULTS, not its transcript.
   *
   * `verify` rather than `judge`, and this is where the shipped engine overrode the
   * shape these rows were first drawn in. A cell is keyed by the objective's identity
   * and its population ordered by the objective's direction, so a judged archive has
   * nothing to bin under and nothing to rank by — {@link archiveRegionRefusal} refuses
   * the pair, and `swarm-run.ts` confirms it end to end: a judged candidate carries no
   * measurement, so the writer skips it and the run reports `records: null`. A COVERAGE
   * GRID therefore needs a measurable objective.
   *
   * WHAT IT NO LONGER MEANS is that the preset needs one to be CALLABLE. A row scoring
   * by `verify` resolves to {@link unmeasuredPoint} when the call named no `objective`,
   * which drops the archive along with the instrument and leaves a judged sweep — so
   * `{preset, task}` runs, and naming an objective is what buys the grid rather than
   * what buys a non-refusal. That split is the whole of the ergonomics fix: the shape
   * these rows describe still requires an instrument, and the CALL does not.
   *
   * Depth 1 BY CONSTRUCTION, the same way `ideate`'s is: an archive bins at the settle
   * barrier, so within one run there is nothing to select a second level from. The
   * illumination loop runs ACROSS runs, and `carry` is what makes the next one start
   * from this one's occupants.
   */
  research: {
    config: {
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'archive', novelty: 0.4 },
      // `artifacts` and not `elites`, which is the one axis separating these rows from
      // `redteam`: a research finding is FOR publication, and that is what this arm
      // buys — a cross-workspace write the elites arm does not make.
      carry: { kind: 'artifacts', threshold: 0.8 },
    },
    depth: 1,
    branches: 4,
    // Where survivors GO is derived from `carry` below, so it is deliberately not said
    // here as well: the two halves overlapping is how a row comes to contradict itself.
    doctrine: 'covers a space instead of climbing it, over a subject dimension you choose.',
  },
  audit: {
    config: {
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'archive', novelty: 0.4 },
      carry: { kind: 'artifacts', threshold: 0.8 },
    },
    depth: 1,
    branches: 4,
    doctrine: 'is the same coverage shape over a finding CLASS rather than a subject, so ten '
      + 'variants of one finding stay one finding.',
  },
  redteam: {
    config: {
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'archive', novelty: 0.4 },
      // `elites`, DELIBERATELY not `artifacts`. The artifacts arm publishes
      // cross-workspace, and an exploit corpus is the one search output that must not
      // leave the workspace that asked for it. What this run produces is the best
      // member of each tactic cell, which is what `elites` keeps.
      carry: { kind: 'elites' },
    },
    depth: 1,
    branches: 4,
    doctrine: 'is the same coverage shape over a TACTIC.',
  },
  optimise: {
    config: {
      // `fork`: a forked conversation carries the ancestor chain's measurements
      // transitively, which is what a run climbing a value needs its children to
      // have seen.
      unit: { kind: 'answer' }, context: 'fork',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'elites' },
    },
    // Deep because it has a verifier — the one value signal the literature says
    // earns a tree — and still inside the 3-7 band every cited system runs rather
    // than at the shipped default of 20.
    depth: 5,
    branches: 3,
    doctrine: 'climbs one number you can measure — a cost, a runtime, a count.',
  },
  prove: {
    config: {
      // `answer`: an agent node, so a proof candidate is produced by something
      // that can run its own checker between steps. `generator` used to sit here
      // to say that in a second word, and it was the same node — see
      // {@link SWARM_UNITS} for why the word is gone rather than the intent.
      unit: { kind: 'answer' }, context: 'fork',
      expand: 'sample',
      // The checker IS the score. `verify` requires an `objective`, which is where
      // the caller names the checker — a `prove` call without one is refused by the
      // same rule every other verifier composition is.
      score: { kind: 'verify' },
      // Best-first rather than `uct`: an exact signal has no noise to re-widen
      // against, so the exploration term buys nothing and re-selection would spend
      // budget re-deriving a step the checker already accepted.
      advance: { kind: 'best-first' },
      // 1 because the checker accepted it. See the table note: this is the derived
      // threshold, not a chosen one.
      carry: { kind: 'artifacts', threshold: 1 },
    },
    // The top of the same 3-7 band `optimise` sits inside. A proof is the one
    // search whose value signal is exact rather than noisy, so depth costs less
    // here than anywhere else in the table: a wrong branch is refuted by the
    // checker instead of being carried down by a plausible score.
    depth: 7,
    branches: 3,
    doctrine: 'drives a checker that accepts a candidate or does not.',
  },
} as const satisfies Record<NamedSwarmPreset, SwarmPresetRow>;

/**
 * The judge ensemble an unmeasured sweep runs at.
 *
 * `DEFAULT_CONFIG.mcts.judgeSamples`, READ rather than transcribed: it is already
 * this repository's judged-ensemble size, and a second number answering the same
 * question is how two of them come to disagree.
 *
 * The marginalisation floor of 20 is not being dodged here.
 * {@link judgeMarginalisationRefusal} is stated over TREE selectors because what the
 * measurement is about is a tree AMPLIFYING scorer noise; an unmeasured sweep has no
 * selection step, so there is no amplification to marginalise against, and
 * `swarm-run.ts` holds a flat judged run to an ensemble of 1 for that same reason.
 */
export const UNMEASURED_JUDGE_SAMPLES = DEFAULT_CONFIG.mcts.judgeSamples;

/**
 * The point a NAMED preset resolves to when the call named no `objective`.
 *
 * WHY A SECOND POINT EXISTS. Five of the six rows score by `verify`, `verify` means
 * an instrument, and {@link swarmValidity} refuses a verifying composition that named
 * none — so `{preset, task}`, the call this surface exists to make trivial, was a
 * refusal on every row but `ideate`. A live incident measured what that costs: a model
 * spent five of its ten steps learning, one refusal per round trip, that its first call
 * was never going to run.
 *
 * WHY NOT A DEFAULT OBJECTIVE. An objective cannot be defaulted. `metric`, `unit`,
 * `direction` and `target` are facts about the caller's task, and `verify` needs a
 * `spec` whose fields ARE that task's data. What can be defaulted is the SCORER, so a
 * call that named no instrument gets the one scorer that needs none.
 *
 * THREE AXES MOVE, AND EVERY ONE OF THEM READS A MEASUREMENT:
 *  - `score` → `judge`, the only scorer that runs without an instrument.
 *  - `advance` → `none`. An archive bins each candidate into the cell its INSTRUMENT
 *    witnessed, and a judged candidate carries no measurement at all, so a judged
 *    archive writes zero rows and would report coverage over a store it never wrote —
 *    {@link archiveRegionRefusal} refuses that exact pair. The tree selectors go for a
 *    different reason: a judged tree is legal only at an ensemble of 20, and that is a
 *    scorer nobody asked for on a bare call.
 *  - `carry` → `none`. A record is keyed by the objective's identity, so a run that
 *    measured none has nothing to key one by and `elites`/`artifacts` would be accepted
 *    and ignored — the one thing *Accepted and ignored* refuses.
 * `depth` follows `advance` to 1, because `advance:'none'` has no selection step and a
 * deeper cap is refused rather than silently flattened.
 *
 * The six axes are named EXPLICITLY rather than spread over the row, which drops the
 * tree-only parameters (`explorationWeight`, `pruneThreshold`, `minVisitsForPrune`) by
 * construction — under `advance:'none'` each of them is a refusal — and makes a new
 * axis a compile error here rather than a silently inherited one.
 *
 * DERIVED FROM THE ROW, not declared per preset, so a preset added to the table cannot
 * forget its unmeasured shape. A row that does not score by `verify` needs no fallback
 * and is returned unchanged.
 */
export function unmeasuredPoint(row: SwarmPresetPoint): SwarmPresetPoint {
  if (row.config.score.kind !== 'verify') return row;
  return {
    ...row,
    config: {
      unit: row.config.unit,
      context: row.config.context,
      expand: row.config.expand,
      score: { kind: 'judge', samples: UNMEASURED_JUDGE_SAMPLES },
      advance: { kind: 'none' },
      carry: { kind: 'none' },
    },
    depth: 1,
  };
}

/** How a MEASURED run of each `advance` reads, in one clause. Annotated `Record` over
 *  the axis rather than inferred, so a new `advance` value must state its phrase
 *  instead of rendering as another value's. */
const ADVANCE_DOCTRINE = {
  none: (row) => `a flat measured wave of ${String(row.branches)}`,
  uct: (row) => `a depth-${String(row.depth)} UCT tree`,
  'best-first': (row) => `a depth-${String(row.depth)} best-first tree`,
  archive: () => 'a one-level coverage grid keyed by `key`, one elite per cell',
  pareto: () => 'a Pareto front over an `instanced` or `vector` objective',
} satisfies Record<SwarmAdvance, (row: SwarmPresetPoint) => string>;

/** What each `carry` leaves for the next run, in one clause. */
const CARRY_DOCTRINE = {
  none: '',
  reflections: ', reflections seeding the next run',
  elites: ', its best kept in this workspace to seed the next run',
  artifacts: ', its best published for a later run to read',
} satisfies Record<SwarmCarry, string>;

/**
 * What each preset IS, what `{preset, task}` alone runs, and what naming an
 * `objective` upgrades it to.
 *
 * ONE enumeration, rendered by every surface a model can learn the preset set from —
 * the `preset` property, the missing-`preset` refusal, and the `agents.swarm` codemode
 * declaration. Four hand-written copies of it is how `prove` came to be reachable in
 * the enum and named in none of them, while three presets that had stopped resolving
 * went on being described as working.
 *
 * IT LIVES BESIDE THE TABLE NOW, and that is the whole point. It used to sit in
 * tools/registry.ts, one import-free module away from the rows it described, and the
 * distance was the defect: the prose said `optimise` "requires `objective`" while the
 * table decided whether it did, so the two could disagree and did. Only the clause a
 * renderer cannot derive is written by hand, on the row itself
 * ({@link SwarmPresetPoint.doctrine}); every number and every shape word below is read
 * from the axes.
 */
export const SWARM_PRESET_DOCTRINE: readonly string[] = [
  // THE RULE, STATED ONCE. It used to be five copies — one per verifying row — of the
  // same sentence about what a bare call does, which is 550 characters of boilerplate
  // in text that renders into three model-facing surfaces. Saying it here and letting
  // each row print only `Sweep N` costs one line and says strictly more.
  'Every preset is callable as `preset` + `task` alone, and nothing else is required. '
    + 'With no `objective` a preset runs a JUDGED SWEEP at its own width: N candidates in '
    + 'parallel, ranked by a judge ensemble, none selected down a tree and none published. '
    + '"Sweep N" below is that width.',
  ...NAMED_SWARM_PRESETS.map((preset) => {
    const row = SWARM_PRESET_POINTS[preset];
    // A row that does not score by `verify` has no measured/unmeasured split to
    // explain, and `ideate`'s own clause already says it refuses an objective.
    if (row.config.score.kind !== 'verify') return `${preset} ${row.doctrine}`;
    const measured = ADVANCE_DOCTRINE[row.config.advance.kind](row)
      + CARRY_DOCTRINE[row.config.carry.kind];
    return `${preset} ${row.doctrine} Sweep ${String(row.branches)}; with an \`objective\`, ${measured}.`;
  }),
  'An `objective` is worth naming when the thing you want can be measured by RUNNING '
    + `something: \`verify\` takes one of the registered instruments (${VERIFIER_KINDS.join(', ')}) `
    + 'and hands it a whole `spec` in one call. Omit it and the sweep is a real ranked result, '
    + 'not a refusal.',
  'custom states all six axes in `config` under a `label`, optionally seeded from `from`. '
    + 'Reach for it when no preset names the shape you want.',
];

/**
 * The `advance` values that select down a TREE, i.e. the region the tree refusals
 * under *Validity over the resolved configuration* are stated over and the region
 * `pruneThreshold` applies to.
 *
 * Derived by exclusion from {@link SWARM_ADVANCES} rather than listed, so a new
 * `advance` value cannot join the axis and quietly fall outside every tree rule.
 */
export const SWARM_TREE_ADVANCES = SWARM_ADVANCES.filter(
  (advance) => advance !== 'archive' && advance !== 'none',
);

export function isTreeAdvance(advance: SwarmAdvance): boolean {
  return SWARM_TREE_ADVANCES.some((tree) => tree === advance);
}

/**
 * The smallest judge ensemble a tree may be scored by.
 *
 * Koh Table 4 at fixed node expansions: an unmarginalised strong judge (28.5%) is
 * beaten by a marginalised weaker one (30.0%), and SC(1)→SC(20) is worth +8.5.
 * Marginalisation buys more than judge strength does, and the shipped default of 3
 * sits below the smallest arm the paper measured.
 */
export const JUDGE_MARGINALISATION_MIN = 20;

/**
 * The per-evaluation LLM-call pool a swarm funds so an ensemble of `samples` is the
 * ensemble that actually runs.
 *
 * WHY THIS EXISTS AT ALL. `judgeCallBudget` splits ONE pool between the generated
 * check suite and the ensemble, so an ensemble is bounded by what the pool leaves:
 * `min(samples, pool − 1)` on a code-bearing candidate. The swarm's judged path used
 * to hand it `DEFAULT_CONFIG.mcts.maxEvalLLMCalls` — 4, the MCTS ENGINE's dial, sized
 * for that engine's own `judgeSamples: 3` default — so every judged swarm realised 3
 * however many {@link JUDGE_MARGINALISATION_MIN} demanded. A run admitted at 20 and
 * executed at 3 is the accepted-and-ignored shape in its purest form, and it was
 * DISCLOSED rather than fixed: `swarm.judge_ensemble_clamped` said so on the way past.
 *
 * The floor is not what moved. It is a claim about ensemble size, measured, and
 * lowering it to meet a borrowed dial is the one move forbidden here. What moved is
 * the funding: the pool is now DERIVED from the request the validity table already
 * admitted, so the two numbers cannot disagree.
 *
 * `samples + 1` and not a larger figure: the one extra call is exactly the check
 * suite `judgeCallBudget` documents, bought on a code-bearing candidate and left
 * unspent on a prose one. Nothing here is a spend ceiling — the mission budget is,
 * and it is checked where spend is checked.
 */
export function judgeCallPool(samples: number): number {
  return samples + 1;
}

/** Where a resolved cap's number came from. A cap the CALLER set and a cap
 *  INHERITED from a preset row are different facts about a run, and no record can
 *  say which unless the resolution does. */
export type SwarmCapOrigin = 'call' | 'preset';

export interface ResolvedCap {
  readonly value: number;
  readonly origin: SwarmCapOrigin;
}

/**
 * The two caps, resolved.
 *
 * `null` means NEITHER the call nor a preset row stated one, which is reachable
 * only through `custom` with no `from` — the table declares rows for the named
 * presets and nothing for a composition that named no base. Null rather than a
 * number, because an invented default is a shape the record cannot report
 * honestly, and `SwarmInput.depth` has no stated default of its own.
 */
export interface ResolvedSwarmCaps {
  readonly branches: ResolvedCap | null;
  readonly depth: ResolvedCap | null;
}

/**
 * A call, resolved: the configuration validity is checked over, the caps in force,
 * and the objective's arguments carried alongside.
 *
 * The arguments are HERE rather than left on the input because the refusals under
 * *Validity over the resolved configuration* are stated over them — `pareto` reads
 * the objective's kind, the archive rules read `key`, C1 reads the floor — and a
 * predicate that cannot see its own input is the defect this specification exists to
 * refuse, the same one *The closed verifier registry* closes by requiring a `spec` to
 * carry every field the floor needs.
 */
export interface ResolvedSwarm {
  readonly preset: SwarmPreset;
  /** The base a composition was seeded from, or null. Provenance: `from` does not
   *  make this a preset run and the record still says `custom`. */
  readonly from: NamedSwarmPreset | null;
  readonly label: string | null;
  /** The caller's name for the run, or null — the display half of {@link SwarmInput.name}. */
  readonly name: string | null;
  readonly config: SwarmConfig;
  /** Derived, never supplied — {@link settleOf} over the resolved axes. */
  readonly settle: SwarmSettle;
  readonly caps: ResolvedSwarmCaps;
  readonly task: string;
  readonly objective: Objective | null;
  readonly key: string | null;
  /**
   * The caller's explicit first-level assignments, or null for the count-based mode
   * where the engine hands out diversity angles. `caps.branches` is `nodes.length`
   * when this is present, so the two can never disagree about width.
   */
  readonly nodes: readonly SwarmNodeAssignment[] | null;
  /**
   * The caller's per-node model specs, or null for the unrouted default where every
   * node runs the one model the call resolved to. Round-robin over the expansion
   * children by slot — see {@link SwarmInput.models} for the assignment rule — and
   * digested into the record's `configDigest` so two runs that differ only in their
   * routing never collide.
   */
  readonly models: readonly string[] | null;
}

/** A validity refusal, built through the one projection every other refusal in the
 *  tree is rendered by, so a cause chain reads the same here as anywhere else. See
 *  *Refusals*. */
function badInput(error: string): SwarmRefusal {
  return { reason: 'bad_input', error: refusalOf(new KinuError('bad_input', error)).error };
}

/**
 * The axes a resolved configuration must name.
 *
 * `satisfies` holds every member to a real key of {@link SwarmConfig}, so a typo cannot
 * enter the list — but the compiler cannot force the converse, that a NEW required axis
 * joins it. What holds that direction is behavioural and lives in the fixture: the
 * refusal below names every axis a composition is missing, and a `custom` call with an
 * empty `config` therefore has to come back naming all of them. An axis added to the
 * interface and forgotten here makes that assertion fail rather than making the
 * resolver quietly accept an incomplete tuple.
 *
 * THE COUNT IS SIX, and it agrees with *The six axes* now. `context` joined because
 * inherited context needs one spelling for the caller-to-root edge and the branch
 * edge together — *One spelling per axis*; `observe` and `decorrelate` left in the same
 * change, and neither is a deferral. `observe` collapsed value by value onto things
 * that already exist — `none` is what a `thought` node IS, `own` is what holding tools
 * MEANS now that every other unit is a real agent, and `ancestors` is what
 * `context:'fork'` supplies by construction. `decorrelate` shipped with all three of
 * its values behaving identically: sibling angles were handed out under every one of
 * them INCLUDING `blind`, which names the opposite, so no caller was ever choosing
 * anything. Diversification is now unconditional, which removes the ability to turn
 * angles OFF and keeps the ability that was working.
 *
 * What is genuinely missing is a convergence DETECTOR at the level barrier — the
 * thing `decorrelate` was reached for and never did. It is a separate obligation
 * and it is deliberately not smuggled in here as a fourth value of a dead axis.
 */
const AXES = [
  'unit', 'context', 'expand', 'score', 'advance', 'carry',
] as const satisfies readonly (keyof SwarmConfig)[];

/** Whether a merged override names every axis. A type guard rather than a check
 *  plus an assertion: the narrowing IS the result, so nothing downstream has to be
 *  told what was just proved. */
function namesEveryAxis(merged: Partial<SwarmConfig>): merged is SwarmConfig {
  return AXES.every((axis) => merged[axis] !== undefined);
}

/** The two caps, optional on every preset, resolved call-first then row. */
function resolveCap(
  supplied: number | undefined, row: number | undefined,
): ResolvedCap | null {
  if (supplied !== undefined) return { value: supplied, origin: 'call' };
  if (row !== undefined) return { value: row, origin: 'preset' };
  return null;
}

/**
 * The requiredness rules from *Accepted and ignored* and *Presets* that are
 * properties of the CALL rather than of the resolved shape, so they run before there
 * is a resolution to check.
 *
 * Split from {@link swarmValidity} on purpose: `config` on a named preset cannot be
 * stated over the resolved configuration at all, because accepting it is what would
 * have produced the resolution. The rules stated over resolved values — objective
 * required iff resolved `score` is `verify`, key iff resolved `advance` is
 * `archive` — live in the predicate, where their input exists.
 */
function requiredFieldRefusal(input: SwarmInput): SwarmRefusal | null {
  const composed = input.preset === 'custom';
  // THE TWO WIDTH MODES ARE EXCLUSIVE, and this is refused rather than resolved by
  // precedence: `nodes.length` IS the width, so a call that also states `branches`
  // has named the same number twice and one of the two is going to be ignored. The
  // caller is told which mode they are in instead.
  if (input.nodes && input.branches !== undefined) {
    return badInput('`nodes` assigns the first level node by node, so its length is the branch count — '
      + `you named ${String(input.nodes.length)} node(s) and \`branches: ${String(input.branches)}\` as `
      + 'well, and one of the two would be ignored. Drop `branches` to keep your own assignments, or '
      + 'drop `nodes` to let the engine hand out that many diversity angles.');
  }
  // EVERY ASSIGNED TASK DISTINCT. The count-based mode differentiates its siblings
  // with angles; this mode differentiates them by what the caller wrote, so two
  // nodes carrying one question is N answers bought for one question — the exact
  // duplication the field exists to remove, restated by the caller.
  const assigned = input.nodes;
  if (assigned) {
    const seen = new Set<string>();
    for (const node of assigned) {
      const task = node.task.trim();
      if (seen.has(task)) {
        return badInput('`nodes` gives every node its own question, and two of yours are the same: '
          + `${JSON.stringify(task.slice(0, 80))}. A search that asks one question twice pays twice for `
          + 'one answer. Make the tasks distinct, or use `branches` and let the engine vary the angle.');
      }
      seen.add(task);
    }
  }
  // A SPEC LIST, WHERE ONE WAS SUPPLIED, IS NON-EMPTY AND EVERY ENTRY IS. The
  // wire schema holds the shape (length and string-ness); THIS holds the semantics
  // the resolution depends on, because an empty spec routes nowhere and a blank one
  // names no model — both are routing decisions the run would have to silently
  // substitute a default for, which is the *Accepted and ignored* lie.
  for (const [index, spec] of (input.models ?? []).entries()) {
    if (spec.trim().length === 0) {
      return badInput(`\`models\` entry ${String(index + 1)} is empty, and an empty string names no `
        + 'model to route this node to — the run would silently fall back to a default the call never '
        + 'chose. Name a spec the resolver recognises, such as a `<provider>/<modelId>` route.');
    }
  }
  if (composed) {
    if (!input.config) {
      return badInput('`custom` is the statement that no preset is the base, so it needs the axes '
        + 'spelled out: supply `config`. Seed it from a tested path with `from` and override only '
        + `what differs, or name all ${String(AXES.length)} axes. A named preset needs no \`config\` at all.`);
    }
    if (!input.label?.trim()) {
      return badInput('a composed configuration needs `label`: a shape recorded repeatedly under one '
        + 'label is the evidence for a sixth preset, and that only works if composed runs are '
        + 'distinguishable from preset runs in the record.');
    }
  } else {
    if (input.config) {
      return badInput(`preset "${input.preset}" is a tested path and takes no \`config\` — validity runs on `
        + 'the resolved composition, so a preset that accepted axes could be refused, and a refusable '
        + `preset is not a tested path. Use preset:"custom" with from:"${input.preset}" and a \`label\`, `
        + 'which records the run as the composition it is.');
    }
    if (input.from) {
      return badInput('`from` names the base for a composition, so it belongs to preset:"custom" only. '
        + `preset "${input.preset}" already IS its configuration.`);
    }
    if (input.label) {
      return badInput('`label` is provenance for a composed configuration and is required exactly when '
        + `\`config\` is present. preset "${input.preset}" is recorded under its own name.`);
    }
    if (input.preset === 'ideate' && input.objective) {
      return badInput('`ideate` is flat and has no value signal by design; an objective here would be '
        + 'measured and then ignored, which is a silent lie about what the run did. Use '
        + 'preset:"optimise" to measure something, or drop `objective`.');
    }
    // NEITHER `key` NOR `objective` IS CHECKED HERE, and for one reason. Both are
    // rules about the RESOLVED configuration — `key` about `advance:'archive'`,
    // `objective` about `score:'verify'` — and both live in {@link swarmValidity},
    // where `custom` gets the same verdict for the same reason. `objective` used to be
    // required here by preset NAME, on `optimise` alone. That was one rule about one
    // name while it was the only verifying preset; with `prove` and the three coverage
    // rows all scoring by `verify` it would have become five names spelling a rule the
    // validity table already states once.
  }
  return null;
}

/**
 * `resolve(preset) → SwarmConfig`, and the refusals that stop a call before there
 * is anything to resolve.
 *
 * Validity is stated over the RESOLVED configuration — *Validity over the resolved
 * configuration* — so this is the function that gives the predicate an input at all.
 * It is deliberately total over `SwarmPreset`: every row is a point, so a named preset
 * always resolves and a composition seeded with `from` always has a base to inherit.
 */
export function resolveSwarm(input: SwarmInput): ResolvedSwarm | SwarmRefusal {
  const required = requiredFieldRefusal(input);
  if (required) return required;

  const baseName: NamedSwarmPreset | null = input.preset === 'custom'
    ? input.from ?? null
    : input.preset;
  // Every row is a point, so this is a lookup and not a decision. It used to be a
  // decision, and the arm it chose between REFUSED — which reached `custom` too, so a
  // composition seeded from an undeclared row was refused for its base's gap rather
  // than judged on the axes the caller stated. See {@link SwarmPresetRow}.
  const row: SwarmPresetPoint | null = baseName ? SWARM_PRESET_POINTS[baseName] : null;
  // A NAMED preset that was handed no `objective` resolves to its UNMEASURED point:
  // `verify` needs an instrument and the call named none, so the row's judged fallback
  // is what it actually gets. See {@link unmeasuredPoint} for why this is a scorer
  // substitution and not a defaulted objective.
  //
  // `custom` is excluded DELIBERATELY and not by oversight. A composition states its
  // own axes — `config` is required on it — so a caller who composed `score:'verify'`
  // asked for an instrument in as many words, and substituting a judge under them
  // would be the surface deciding something they had already decided. `from` names a
  // base to inherit, not a preset to be treated as one.
  const base: SwarmPresetPoint | null = row !== null
    && input.preset !== 'custom' && input.objective === undefined
    ? unmeasuredPoint(row)
    : row;

  const merged = { ...base?.config, ...input.config };
  if (!namesEveryAxis(merged)) {
    const missing = AXES.filter((axis) => merged[axis] === undefined);
    return badInput(`a resolved configuration names all ${String(AXES.length)} axes and this one is `
      + `missing ${missing.join(', ')}. `
      + (base
        ? `\`config\` overrides \`from\`'s row, so state only what differs from "${String(baseName)}".`
        : 'With no `from` there is no row to inherit from, so `config` must name every axis — or name a '
          + 'base with `from` and override the rest.'));
  }
  const config = merged;

  return {
    preset: input.preset,
    from: input.preset === 'custom' ? input.from ?? null : null,
    label: input.label?.trim() ?? null,
    name: input.name?.trim() || null,
    config,
    settle: settleOf(config),
    caps: {
      // `nodes.length` IS the width when the caller assigned the level itself, and it
      // arrives here as a `call` cap for the same reason an explicit `branches` does:
      // the caller stated it. Stating both is already refused above, so there is no
      // precedence rule here to get backwards.
      branches: resolveCap(input.nodes?.length ?? input.branches, base?.branches),
      depth: resolveCap(input.depth, base?.depth),
    },
    task: input.task,
    objective: input.objective ?? null,
    key: input.key ?? null,
    nodes: input.nodes ?? null,
    models: input.models ?? null,
  };
}

/**
 * The digest a record carries in place of a column per axis — {@link
 * ExplorationRecord}'s `configDigest`, and the one definition of it.
 *
 * ONE column rather than one per field, so it cannot go stale as axes are added; and
 * computed HERE, beside the resolution, because the thing being digested is what the
 * resolution produced. Its reason for existing is the absent-default defect: an
 * un-parameterised run otherwise leaves no record of the shape it got, and an ABSENT
 * default is worse than a wrong one — a wrong default is visible in the record and
 * arguable, whereas an absent one means the shape was decided by whatever the
 * implementation happened to do and the record cannot report a number the
 * specification never named.
 *
 * EVERY TAGGED PARAMETER IS IN IT, spelled out per arm rather than spread. A digest
 * over the axis names alone would make a judged run at 3 samples and one at 20
 * indistinguishable in the record, which is precisely the shape those parameters were
 * tagged onto their values to prevent. The optional region parameters are digested as
 * `null` when unset, because absent and zero are different configurations.
 *
 * The caps are digested by VALUE and not by origin: a cap the caller set and a cap
 * inherited from a preset row are the same shape in force, and folding the provenance
 * in would make two identically-shaped runs incomparable.
 */
export function configDigestOf(resolved: ResolvedSwarm): string {
  const { config, caps } = resolved;
  return argumentDigest({
    unit: config.unit.kind,
    context: config.context,
    expand: config.expand,
    score: config.score.kind === 'judge'
      ? { kind: config.score.kind, samples: config.score.samples }
      : { kind: config.score.kind },
    advance: config.advance.kind === 'archive'
      ? { kind: config.advance.kind, novelty: config.advance.novelty }
      : { kind: config.advance.kind },
    carry: config.carry.kind === 'reflections' || config.carry.kind === 'artifacts'
      ? { kind: config.carry.kind, threshold: config.carry.threshold }
      : { kind: config.carry.kind },
    explorationWeight: config.explorationWeight ?? null,
    pruneThreshold: config.pruneThreshold ?? null,
    minVisitsForPrune: config.minVisitsForPrune ?? null,
    settle: resolved.settle,
    depth: caps.depth?.value ?? null,
    branches: caps.branches?.value ?? null,
    // THE ROUTING, beside the caps it sits with on the input: two runs that differ
    // only in which model each node ran on are different runs in every way a record
    // can be asked about — spend, provenance, comparability — and a digest that
    // folded it out would make them one. `null` for the unrouted default, because
    // an absent list and a list naming the run's own model are different facts about
    // what the caller asked for, even where both run the same model.
    models: resolved.models === null ? null : [...resolved.models],
  });
}

/* ── Validity, over the resolved configuration ────────────────────────────── */

/** Every floor a resolved objective declares, with the direction it is stated
 *  against — a `vector` objective carries one per component and a `witness` carries
 *  its proxy's, so C1 cannot be written over a single field. */
function floorsOf(objective: Objective): readonly { floor: Floor; direction: ObjectiveDirection }[] {
  if (objective.kind === 'vector') return objective.components.flatMap(floorsOf);
  if (objective.kind === 'witness') return objective.proxy ? floorsOf(objective.proxy) : [];
  return objective.floor ? [{ floor: objective.floor, direction: objective.direction }] : [];
}

/**
 * Every instrument a resolved objective NAMES, written as data.
 *
 * Walks the same three composite shapes {@link floorsOf} does, and for the same
 * reason: a `vector` declares one per component and a `witness` declares its own check
 * plus its proxy's, so a membership rule cannot be written over a single field.
 *
 * The CLOSURE arm is skipped rather than refused. A closure cannot fail to resolve, so
 * there is no registry question to ask of it — and it is unauthorable from the tool
 * surface anyway, which is where a fabricated name would come from.
 */
function verifierSpecsOf(objective: Objective): readonly VerifierSpec[] {
  if (objective.kind === 'vector') return objective.components.flatMap(verifierSpecsOf);
  const named = objective.kind === 'witness'
    ? [objective.check, ...(objective.proxy ? [objective.proxy.verify] : [])]
    : [objective.verify];
  // Narrowed on the DOMAIN and not on the representation: a `VerifierSpec` is the arm
  // that declares a `kind`, and the closure arm declares nothing.
  return named.filter((source): source is VerifierSpec => 'kind' in source);
}

/**
 * The keys a kind's `spec` must carry and this one did not.
 *
 * A PRESENCE check and deliberately not a second copy of the kind's schema:
 * `verifier-registry.ts` owns the types, the ranges and the cross-field rules, and
 * duplicating them here would be the two-spellings defect this file argues against
 * everywhere else. What this catches is the shape the incident actually produced — a
 * `spec` sent partial, or sent as `{}` because the wire schema only asks for JSON —
 * which used to pass validity, start a run, and come back as a bound instrument's
 * complaint one round trip later.
 *
 * A non-object `spec` is reported as missing EVERY field rather than as a type error,
 * because the correction is the same either way and one message beats two.
 */
function missingSpecFields(kind: VerifierKind, spec: JsonValue): readonly string[] {
  const fields = VERIFIER_KIND_DOC[kind].specFields;
  if (!isJsonObject(spec)) return fields;
  return fields.filter((field) => !Object.hasOwn(spec, field));
}
/**
 * The complete call that needs no instrument, named in a refusal that just rejected
 * one.
 *
 * Every arm that refuses a verifier ends with this, because a refusal that names only
 * the field it rejected teaches one field per round trip — and the transcript that
 * motivated it spent five steps that way before learning the instrument could not have
 * run in that workspace at all. A NAMED preset has a working call one deletion away, so
 * the sentence prints it; `custom` composed its own axes and has to change the one it
 * composed.
 */
function instrumentFreeAlternative(resolved: ResolvedSwarm): string {
  if (resolved.preset === 'custom') {
    return 'If nothing here can be measured by running code, set score:{kind:"none"} in `config` '
      + 'and take an unranked flat run, or name a preset and drop `config` entirely.';
  }
  const row = SWARM_PRESET_POINTS[resolved.preset];
  return 'If nothing here can be measured by running code, DROP `objective` and this same call '
    + `works as it stands: {action:"swarm", preset:"${resolved.preset}", task:"…"} runs a judged `
    + `sweep of ${String(row.branches)}, ranked, with no instrument and no other field required.`;
}

/**
 * The marginalisation floor under *Validity over the resolved configuration*, as ONE
 * refusal two entry points share.
 *
 * It was stated only inside {@link swarmValidity}, which the tool surface calls and
 * `runSwarm` does not — `swarm-run.ts`'s own region check is *"also the in-process
 * entry point"*. So an in-process caller could run a judged tree below the floor and
 * get a search whose scorer the measurement says is not worth building: at fixed node
 * expansions a marginalised weaker judge beats an unmarginalised stronger one, 30.0%
 * against 28.5%. Extracted rather than copied, because a refusal written twice is a
 * refusal that will be raised in one place and relaxed in the other.
 *
 * Stated over the CONFIG rather than the resolution, which is all it reads — the two
 * callers hold different shapes and neither has to build the other's.
 */
export function judgeMarginalisationRefusal(config: SwarmConfig): SwarmRefusal | null {
  if (!isTreeAdvance(config.advance.kind)) return null;
  if (config.score.kind !== 'judge') return null;
  if (config.score.samples >= JUDGE_MARGINALISATION_MIN) return null;
  return badInput(`a judged scalar is a noisy scorer and a tree amplifies scorer noise, so score:"judge" `
    + `down a tree needs samples ≥ ${String(JUDGE_MARGINALISATION_MIN)} and this composition has `
    + `${String(config.score.samples)}: at fixed node expansions a marginalised WEAKER judge beats an `
    + 'unmarginalised stronger one, 30.0% against 28.5%. Raise `samples`, and note the binding cap is '
    + '`maxEvalLLMCalls` rather than the request — a code-bearing branch realises '
    + 'min(samples, maxEvalLLMCalls − 1), so raising this alone silently does nothing.');
}

/**
 * The `advance:'archive'` region rules, as ONE refusal both entry points share.
 *
 * Extracted for {@link judgeMarginalisationRefusal}'s reason and not by analogy with it:
 * `swarm-run.ts`'s own region check is *"also the in-process entry point"*, so a rule
 * stated only here would let an in-process caller run a shape the tool surface refuses,
 * and a rule written twice is a rule that gets raised in one place and relaxed in the
 * other.
 *
 * Each arm names the one thing the composition lacks and the one move that supplies it.
 */
export function archiveRegionRefusal(
  config: SwarmConfig, caps: ResolvedSwarmCaps,
): SwarmRefusal | null {
  if (config.advance.kind !== 'archive') return null;
  if (config.score.kind !== 'verify') {
    // A cell is keyed by the objective's IDENTITY — the metric and the instrument — and
    // a cell's population is ordered by the objective's own direction. A judged or
    // unscored run measures neither, so its candidates have nothing to be binned under
    // and nothing to be ranked by: the archive would have no store at all rather than
    // an empty one.
    return badInput(`an archive keys every cell by the objective's identity and orders each cell by the `
      + `objective's own direction, and score:"${config.score.kind}" measures neither — so nothing this `
      + 'run produced could be binned or ranked, and the coverage it reported would be over a store it '
      + 'never wrote. Use score:"verify" with an `objective`, or advance:"none" for a flat run.');
  }
  const { novelty } = config.advance;
  if (!(novelty >= 0 && novelty <= 1)) {
    // The unit, made unambiguous where getting it wrong is invisible. This parameter is a
    // DISTANCE floor a candidate must clear, and every published filter this axis was
    // argued from is stated as a SIMILARITY ceiling — so a threshold transcribed from one
    // of those, unconverted, is a stricter archive than the evidence describes, and a
    // similarity above 1 is an archive no candidate can ever enter.
    return badInput(`\`novelty\` is the DISTANCE a candidate must put between itself and every occupant of `
      + `its cell, in [0,1] where 0 admits everything and 1 admits only an answer sharing no vocabulary `
      + `at all — and this composition states ${String(novelty)}, which no distance can satisfy or fail. `
      + 'Note the direction before transcribing one: a filter quoted as a similarity ceiling is one MINUS '
      + 'that number here. State a threshold inside [0,1].');
  }
  if (caps.depth && caps.depth.value > 1) {
    // An archive selects by CELL, and its cells are written at the settle barrier — so
    // within one run there is nothing to select from, and a second level would be
    // expanded by whatever frontier order happened to be substituted for the one the
    // caller asked for. Refused rather than silently flattened, exactly as
    // advance:"none" is: the illumination loop runs ACROSS runs, where `carry:'elites'`
    // seeds the next run from this one's occupants.
    return badInput(`advance:"archive" bins its candidates into cells at the settle barrier, so during the `
      + `run there is no archive to select a second level FROM and depth ${String(caps.depth.value)} `
      + 'cannot be run — it is refused rather than silently flattened, because a cap accepted and ignored '
      + 'is a lie about what the run did. Pass depth:1 and carry:"elites", which is what makes the next '
      + "run start from this one's occupants.");
  }
  return null;
}

/**
 * The validity table of *Validity over the resolved configuration*, executable.
 * Returns the FIRST refusal in table order, or null.
 *
 * One refusal rather than a list, and one imperative per refusal, which is the
 * measured result *Refusals* states: a refusal naming two ways out was corrected to
 * the wrong one.
 * Stated over the resolved configuration and never over the preset name, so a
 * composition and a preset run through one definition of legal.
 */
export function swarmValidity(resolved: ResolvedSwarm): SwarmRefusal | null {
  const { config, objective, caps } = resolved;
  const advance = config.advance.kind;
  const tree = isTreeAdvance(advance);

  if (tree && config.score.kind === 'none') {
    return badInput(`advance:"${advance}" selects on value and score:"none" supplies none, so this `
      + 'composition is a breadth-first enumerator whose winner is row order: at zero signal a 42-node '
      + 'tree agrees with the genuinely best node 0% of the time. Give it a signal — score:"verify" with '
      + 'an `objective`, or score:"judge" with enough `samples` — or use advance:"none" and get honest '
      + 'parallel sampling.');
  }
  const marginalisation = judgeMarginalisationRefusal(config);
  if (marginalisation) return marginalisation;
  // A witness with no proxy scores 1 for a solution and 0 for everything else, so
  // until the first success the value signal is constant.
  if (tree && objective?.kind === 'witness' && objective.proxy === undefined) {
    return badInput('a disproof or a certificate is a binary signal and a tree cannot climb one: until the '
      + 'first success every candidate scores the same and the search is a breadth-first enumerator. Add '
      + '`proxy` naming a scalar that improves as you approach — largest n verified, instances covered — '
      + 'or use advance:"none" and accept that this is parallel sampling, which for a witness hunt is '
      + 'honest and often correct.');
  }
  if (advance === 'pareto') {
    if (!objective) {
      return badInput('advance:"pareto" reports a frontier, and a frontier needs several axes to be a '
        + 'frontier at all: supply an `objective` of kind "instanced" (one metric across ≥2 instances) or '
        + '"vector" (≥2 metrics, each with its own unit and direction).');
    }
    if (objective.kind !== 'instanced' && objective.kind !== 'vector') {
      return badInput(`advance:"pareto" with an objective of kind "${objective.kind}" gives a front of size one, `
        + 'which is an argmax reported as a frontier. Use kind:"instanced" for one metric across ≥2 '
        + 'instances (GEPA\'s front), or kind:"vector" for ≥2 metrics each keeping its own unit and '
        + 'direction (a score dict).');
    }
  }
  if (config.score.kind === 'verify' && !objective) {
    // ONLY `custom` REACHES THIS NOW. A named preset handed no `objective` resolves to
    // its unmeasured point and scores by judge, so the composition that arrives here is
    // one a caller SPELLED — which is why the way out named below is `config`, a field
    // this caller has already used, and not the `score:"none"` the old text offered
    // every preset. That offer was unreachable on five of the six: a named preset takes
    // no `config`, so the one move its refusal recommended was refused by the next rule.
    return badInput('score:"verify" measures something and this composition did not say what. Supply '
      + '`objective` with a `metric`, a `unit`, a `direction`, a `target`, and `verify` as '
      + `{kind, spec} naming one of the registered instruments: ${VERIFIER_KINDS.join(', ')}. `
      + 'Or set score:{kind:"none"} in `config` for a flat run with no value signal — and note '
      + 'that a NAMED preset needs neither: it falls back to a judged sweep on its own.');
  }
  // THE CHECKER IS NAMED AT CALL TIME, which is what `VerifierSpec.kind` already claims
  // ("an unregistered kind is a CALL-TIME `bad_input` naming the registered kinds") and
  // what nothing enforced: the registry was consulted at the top of `runSwarm`, so a
  // fabricated kind was a refusal a caller only met once the run had begun.
  //
  // BOTH ARMS BELOW NAME A COMPLETE CALL rather than the field they rejected, and that
  // is the whole lesson of the incident. A refusal naming a field teaches one field per
  // round trip; the caller in that transcript spent five steps collecting them and the
  // fifth told it the instrument could never have run there at all. So each arm ends
  // with a call that WORKS — which for a named preset is the same call minus
  // `objective`, because the row's judged sweep needs nothing.
  if (objective) {
    for (const spec of verifierSpecsOf(objective)) {
      const registered = VERIFIER_KINDS.find((kind) => kind === spec.kind);
      if (registered === undefined) {
        return badInput(`no verifier kind "${spec.kind}" is registered, so score:"verify" names an `
          + 'instrument that cannot run and this composition would measure nothing. `kind` must be one '
          + `of: ${VERIFIER_KINDS.join(', ')}. ${instrumentFreeAlternative(resolved)}`);
      }
      const missing = missingSpecFields(registered, spec.spec);
      if (missing.length > 0) {
        const doc = VERIFIER_KIND_DOC[registered];
        // "sent none of them" rather than re-listing every field it needs: the two lists
        // are identical when the spec is empty, and printing one twice reads as two
        // different requirements.
        const shortfall = missing.length === doc.specFields.length
          ? 'this one sent none of them'
          : `this one is missing ${missing.join(', ')}`;
        return badInput(`verify.kind:"${registered}" ${doc.summary}, and its \`spec\` is the whole `
          + `problem statement rather than a pointer at one: it needs ${doc.specFields.join(', ')}, and `
          + `${shortfall}. Send every field in one call — they are checked together, so adding them one `
          + `at a time costs a round trip each. ${instrumentFreeAlternative(resolved)}`);
      }
    }
  }
  if (advance === 'archive' && !resolved.key) {
    // WHAT THE KEY HAS TO NAME MOVED when the archive started running: the cell is
    // witnessed by the instrument that measured the candidate, so the key names one of the
    // quantities that instrument reports. The old text asked for something a
    // `ToolCallRecord` could witness, which was a constraint on the caller with no
    // mechanism behind it — *The archive* says *How a descriptor is produced is
    // unspecified*.
    return badInput('an archive needs a descriptor to bin elites into, and the descriptor is WITNESSED '
      + 'by the objective\'s own instrument rather than claimed by a node: supply `key`, naming one of '
      + 'the quantities that verifier reports beside its value. A key that can only say "distinct idea" '
      + 'is a task with no coverage objective — that task wants preset:"ideate".');
  }
  if (resolved.key && advance !== 'archive') {
    return badInput(`\`key\` is the descriptor an archive bins elites into, and advance:"${advance}" `
      + 'keeps no archive, so this run would accept a coverage key and report no coverage — which is a '
      + 'silent lie about what it did rather than a harmless extra. Drop `key`, or use '
      + 'advance:"archive" if coverage is what you want.');
  }
  const archive = archiveRegionRefusal(config, caps);
  if (archive) return archive;
  for (const { floor, direction } of objective ? floorsOf(objective) : []) {
    const margin = floorMargin(floor, direction);
    if (margin < 0) {
      return badInput(`this floor of ${String(floor.value)} already exceeds the best honest cost anyone has `
        + `measured (${String(floor.bestKnownHonest)}), so it is refuted at declaration: margin `
        + `${margin.toFixed(4)}. A floor is a proof or it is nothing, and a floor above the best known `
        + 'algorithm scores a correct run as a cheat. Re-derive the bound, or raise `bestKnownHonest` to '
        + 'the cost actually measured.');
    }
  }
  if (advance === 'none' && caps.depth && caps.depth.value > 1) {
    return badInput(`advance:"none" has no selection step, so there is no second level to reach and `
      + `depth ${String(caps.depth.value)} cannot be run — it is refused rather than silently flattened, `
      + 'because a cap accepted and ignored is a lie about what the run did. Pass depth:1, or choose a '
      + 'tree selector such as advance:"uct".');
  }
  if (!tree && (config.pruneThreshold !== undefined || config.minVisitsForPrune !== undefined)) {
    const named = [
      ...(config.pruneThreshold !== undefined ? ['`pruneThreshold`'] : []),
      ...(config.minVisitsForPrune !== undefined ? ['`minVisitsForPrune`'] : []),
    ].join(' and ');
    return badInput(`${named} is pruning policy for a tree selector, and advance:"${advance}" does not `
      + `prune — it would be accepted and ignored, which is why it is refused. Drop ${named}, or use one of `
      + `${SWARM_TREE_ADVANCES.join('/')}.`);
  }
  return null;
}

/**
 * A node's request to expand at itself.
 *
 * A node does NOT spawn children. It PROPOSES, and `advance` arbitrates, because
 * a node cannot see the three policies its spawn would fight: where the next unit
 * of budget was going, how much budget is left, and the depth cap. A proposal is
 * therefore an INPUT to selection and never a bypass of it.
 *
 * This is a BRANCH INSIDE THE SEARCH — same budget, same objective, same records
 * store. A caller who wants a new budget and a new objective wants a nested
 * `swarm`, which is a different call with its own depth cap. The two read alike
 * in English ("explore this further") and must not read alike in the docstring.
 */
export interface BranchProposal {
  /** Why this thread deserves the budget. Prose, and it is the only thing the
   *  node knows that the engine does not. */
  readonly rationale: string;
  /**
   * 2-4 narrower sub-questions, each naming what it starts from.
   *
   * `context` is PER BRANCH (the proposal shape *Arbitration* names) and defensible
   * precisely because the NODE knows which of its threads is worth inheriting a whole
   * conversation for while the engine does not. It is validated against the search's
   * own `context` rather than overriding it: a run resolved `fresh` refuses a `fork`
   * child and says so, instead of quietly honouring one of two conflicting policies. A
   * node may NARROW, never widen.
   */
  readonly branches: readonly {
    readonly task: string;
    readonly rationale: string;
    readonly context: BranchContext;
  }[];
}

/**
 * The width band a proposal is arbitrated against — *Arbitration*. A proposal names
 * 2-4 narrower sub-questions.
 *
 * Enforced by the arbiter rather than by the type, so an out-of-range request
 * produces a reason-coded refusal instead of being unrepresentable and therefore
 * unexplainable — `Arbitration.lean:65-69` states exactly this choice, and it is
 * the difference between a node that learns its width was wrong and one that
 * silently gets something else.
 *
 * A band on the PROPOSAL and never on the search's own `branches`: width is a cap
 * the caller sets (`ideate` runs 5), so applying this to an engine-driven
 * expansion would refuse a legal preset.
 */
export const BRANCH_PROPOSAL_WIDTH = { min: 2, max: 4 } as const;

/**
 * The five reasons arbitration can refuse, as stable tokens.
 *
 * Exactly `Arbitration.lean`'s `Refusal` constructors, in that file's order, so
 * the executable arbiter and the proven one can be read against each other. They
 * are TOKENS as well as prose because the prose is for the node and the token is
 * for the log: `every_refusal_is_reachable` proves none of the five is a reason
 * the arbiter can never give, and a query over the event stream is how that stays
 * true of the shipped engine.
 */
export const BRANCH_REFUSAL_POLICIES = [
  'does-not-expand-at-node', 'width-out-of-range', 'depth-exhausted',
  'budget-exhausted', 'context-conflict',
] as const;
export type BranchRefusalPolicy = (typeof BRANCH_REFUSAL_POLICIES)[number];

/**
 * What the arbiter decided, before the engine has created anything.
 *
 * Distinct from {@link BranchVerdict}, which is what the NODE is handed: a verdict
 * carries the ids of children that now exist, and only the engine that recorded
 * them can say what those are. Keeping the decision separate is what keeps this
 * function total, pure and free of identity — it decides, it does not mint.
 */
export type BranchArbitration =
  | { readonly kind: 'accepted'; readonly width: number }
  | {
    readonly kind: 'refused';
    readonly policy: BranchRefusalPolicy;
    readonly error: string;
  };

/** What a proposal is arbitrated against: the caps in force, the search's own
 *  policies, and the state of the budget at the moment the request is answered. */
export interface BranchArbitrationInput {
  readonly config: SwarmConfig;
  readonly caps: ResolvedSwarmCaps;
  /**
   * The depth of the proposing node, READ FROM THE ENGINE'S OWN ROW.
   *
   * Deliberately not a field of {@link BranchProposal}: a node never states its
   * own depth, so the number it would have to lie about is one it never supplies
   * (`subordinates/depth.ts`, and the same move as {@link SwarmScoreSetting}
   * having no untagged parameters).
   */
  readonly atDepth: number;
  /** Budget still available to the search, in units of one child. */
  readonly remainingChildren: number;
  readonly proposal: BranchProposal;
}

/**
 * **The arbiter.** A total function of the caps, the search's own policies and the
 * proposal — the single scheduler *Arbitration* names, which a proposal is an input to.
 *
 * A faithful port of `lean/Kinu/Exploration/Arbitration.lean`'s `arbitrate`,
 * including its ORDER: the theorems there are projections of one acceptance
 * region (`accepted_iff`), so a reordering here would leave the proven arbiter and
 * the shipped one agreeing on which proposals pass while disagreeing on what the
 * node is TOLD, which is the half *Refusals* records as load-bearing. The five arms
 * discharge, in order, `archive_refuses_at_node`, `accepted_width_in_range`,
 * `accepted_children_within_depth` (S3), `accepted_within_budget` (S8) and
 * `accepted_respects_context` (*Inherited context*).
 *
 * Every refusal names the POLICY and the STATE that made it refuse, because a node
 * that cannot tell refusal from being ignored will simply propose again. Absent
 * caps are refused rather than defaulted: a search whose depth nothing states
 * cannot grant depth, and saying so is not the same as saying the budget ran out.
 *
 * THE FIFTH ARM MOVED AXIS, and Lean moved with it. It used to be stated over
 * sibling-blindness coupled to parent-inheritance, on the reading that what a
 * sibling is SHOWN and what a child STARTS FROM were one question. They are two,
 * only one of them survived as an axis, and it is the one that was always doing the
 * work: {@link SWARM_CONTEXTS} decides what a child starts from. *The six axes* states
 * the rule over the second one — *"a search resolved to the non-inheriting value
 * refuses an inheriting child"* — so the arm compares `context` with `context`, and
 * the theorem is `accepted_respects_context`. Re-pointing that theorem in
 * `lean/Kinu/Exploration/Arbitration.lean` is the cost of the cut, paid here
 * rather than deferred, because a proven theorem about a field that no
 * longer exists is worse than no theorem.
 */
export function arbitrateBranch(input: BranchArbitrationInput): BranchArbitration {
  const { config, caps, atDepth, remainingChildren, proposal } = input;
  const width = proposal.branches.length;
  const refused = (policy: BranchRefusalPolicy, error: string): BranchArbitration =>
    ({ kind: 'refused', policy, error });

  if (!isTreeAdvance(config.advance.kind)) {
    return refused('does-not-expand-at-node',
      `advance:"${config.advance.kind}" does not expand at a node, so this branch cannot be granted here: `
      + `${config.advance.kind === 'none'
        ? 'a flat run has no selection step, so there is no second level for a branch to land on'
        : `an ${config.advance.kind} run reports a store rather than descending a tree`}`
      + `. The request is refused rather than dropped. A branch inside THIS search needs one of `
      + `${SWARM_TREE_ADVANCES.join('/')}; a new search with its own budget and its own objective is `
      + 'a nested `agents.swarm` call, which is a different thing and capped on a different counter.');
  }
  if (width < BRANCH_PROPOSAL_WIDTH.min || width > BRANCH_PROPOSAL_WIDTH.max) {
    return refused('width-out-of-range',
      `a branch proposal names ${String(BRANCH_PROPOSAL_WIDTH.min)}-${String(BRANCH_PROPOSAL_WIDTH.max)} `
      + `narrower sub-questions and this one names ${String(width)}. Propose between `
      + `${String(BRANCH_PROPOSAL_WIDTH.min)} and ${String(BRANCH_PROPOSAL_WIDTH.max)}.`);
  }
  if (!caps.depth) {
    return refused('depth-exhausted',
      'nothing states how deep this search may go — neither the call nor a preset row behind it — so '
      + 'there is no cap a branch could be granted inside. This is an absent depth rather than an '
      + 'exhausted one.');
  }
  if (caps.depth.value <= atDepth) {
    return refused('depth-exhausted',
      `depth exhausted at depth ${String(atDepth)}: this node sits at the cap of `
      + `${String(caps.depth.value)}, so its children would be depth ${String(atDepth + 1)}. The cap is `
      + 'the search\'s own `depth` and is not raisable from inside the search.');
  }
  if (remainingChildren < width) {
    return refused('budget-exhausted',
      `budget exhausted at depth ${String(atDepth)}: ${String(width)} children were asked for and `
      + `${String(remainingChildren)} remain in this search's expansion budget. The budget is the `
      + 'search\'s, shared by every node, and a proposal cannot mint children it cannot pay for.');
  }
  const widening = proposal.branches.filter((branch) => branch.context === 'fork');
  if (config.context === 'fresh' && widening.length > 0) {
    return refused('context-conflict',
      `this search is resolved context:"fresh", which starts every child from its parent's REPORTED `
      + `results rather than its conversation, and ${String(widening.length)} of these `
      + `${String(width)} branches ask for context:"fork". A node may narrow the search's inheritance `
      + 'and never widen it, so this is refused rather than one of two conflicting policies being '
      + 'honoured quietly. Propose the same branches with context:"fresh" — they still receive your '
      + 'report, your candidate and their own focus, which is everything except your transcript.');
  }
  return { kind: 'accepted', width };
}

/**
 * What arbitration returned.
 *
 * A refused proposal names the policy that refused it and the state that made it
 * refuse ("budget exhausted at depth 3", "advance:'archive' does not expand at a
 * node"). Never dropped silently: silence is the failure mode this codebase spent
 * the night removing, and a node that cannot tell refusal from being ignored will
 * simply propose again.
 */
export type BranchVerdict =
  | { readonly kind: 'accepted'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: 'denied'; readonly error: string };

/* ── The result half: what a settled run reports ──────────────────────────── */

/**
 * Whether the run's own ANSWER may be published, and under what.
 *
 * The seal is stated over the STORE — *The publication seal*, where
 * {@link PublicationState} plus `admitsPublication` govern the six enumerated
 * surfaces — and it deliberately does NOT seal the settle report,
 * because the calling turn is the search's primary consumer and the verifier still
 * works. That left the marker itself uncarryable: a run under a suspended floor
 * still hands back an answer, and nothing on that answer said so. This is the field
 * that says it.
 *
 * The state is CARRIED rather than reduced to a boolean, so the consumer that has to
 * disclose the breach has the breach, and `admitsPublication` stays the one place a
 * seal is interpreted. A `sealed` state with a recorded re-derivation publishes
 * again — that edge belongs to the gate, not to a second copy of it here.
 */
export interface SwarmPublicationMarker {
  readonly state: PublicationState;
  /** Why the answer is not publishable, in one sentence, for a reader who has the
   *  answer in front of them and not the specification. Null when it is. */
  readonly caveat: string | null;
}

/**
 * One candidate as the settle report carries it.
 *
 * `value` is the RAW measurement in the objective's own unit and `score` is the
 * normalised number the search climbed — both, because they are different numbers
 * and a report that carried only the second could not be compared with yesterday's
 * run. Absent rather than zero when the candidate produced no usable answer: an
 * unexplained zero is indistinguishable from a broken instrument.
 */
export interface SwarmCandidate {
  readonly id: string;
  readonly artifact: string;
  readonly measured: MeasuredValue | null;
  /** Complete raw evidence over the declared Pareto axes. Null outside a Pareto run
   * and when the instrument could not supply comparable evidence. */
  readonly pareto: ParetoEvidence | null;
  /** Why the INSTRUMENT produced no number for an answer this node did produce. */
  readonly unmeasurable: string | null;
  /**
   * Why this node produced no answer at all — its status, its step count and its wall
   * clock — and null when it ran to completion.
   *
   * SEPARATE FROM {@link unmeasurable} because they are opposite facts and a ranking
   * that confuses them ranks on the clock. An unmeasurable candidate is an answer the
   * instrument could not turn into a number; an incomplete one is a node that was
   * aborted, ran out of steps or errored, so the string the instrument would have been
   * handed is a status line rather than an answer. Both leave `score` null and both are
   * out of selection; only this one says the run was cut short, and without it a swarm
   * whose whole wave was stopped by its caller's deadline reports the verifier's
   * complaint about the status line and nothing about the deadline.
   */
  readonly incomplete: string | null;
  readonly score: number | null;
  /** Whether this candidate satisfied the witness side-condition. Null when
   * this run has no witness predicate or the candidate was not measured. */
  readonly witnessFound: boolean | null;
}

/**
 * The ensemble a judged run REQUESTED and the one it ran.
 *
 * Two numbers because they differ on shipped defaults and the difference is the whole
 * point: `maxEvalLLMCalls` is the WHOLE per-evaluation call budget and a code-bearing
 * branch spends one of those calls on its generated check suite, so the ensemble is
 * `min(samples, maxEvalLLMCalls − 1)` and a caller asking for 20 is answered by 3.
 * That used to happen with no field anywhere carrying the 3.
 */
export interface JudgeEnsembleReport {
  /** What `score:'judge'` asked for. Never a default: `samples` is tagged onto the
   *  judge arm, so a judged run always states it. */
  readonly requested: number;
  /**
   * The BINDING realisation — the smallest ensemble any candidate of this run
   * actually sampled.
   *
   * The smallest rather than the largest, and rather than a recomputation of the
   * clamp. Every code-bearing candidate in one run shares one call budget and so
   * realises the same number, while a prose candidate spends no call on a check suite
   * and realises one more; the smaller is therefore the clamp as it bound, which is
   * the quantity a reader asking "did I get what I asked for" wants. Recomputing it
   * from the knobs is what `read-models/fork-params.ts` must do for a persisted run it
   * cannot observe — this run can observe it, and an observation beats a re-derivation.
   *
   * NULL when no candidate reached the ensemble at all: an evaluation that
   * short-circuited on source that never parsed spent zero judge calls, and "never
   * asked" is not the same fact as "asked for fewer than requested".
   */
  readonly realised: number | null;
}

/**
 * What `expand:'aggregate'` DID — the fan-in disclosure, as data.
 *
 * Here rather than in an event stream because every one of these fields answers a
 * question the axis makes it possible to get wrong quietly. A fan-in that consumed
 * three of four parents, or one whose merge landed a dependent before its dependency,
 * or one that dropped a level because a parent produced nothing, all still return an
 * answer — and a reader with only that answer cannot tell which of them happened.
 *
 * Null on an `expand:'sample'` run, which fans in nothing. Null is "this run has no
 * fan-in", not "a fan-in that did nothing".
 */
export interface SwarmFanInReport {
  /** How many level barriers fanned in. A level with fewer than two consumable
   *  parents is not one of them: a fan-in over one parent is `sample` under another
   *  name and the engine will not relabel it. */
  readonly levels: number;
  /** The merge order the DAG's edges produced, across every fan-in, in the order the
   *  merges were attempted. A dependency-respecting order is exactly the claim this
   *  field makes checkable. */
  readonly order: readonly string[];
  /** How many of those merges landed. */
  readonly merged: number;
  /** The aggregate vertices the fan-ins produced: one per disagreement between two
   *  parents, spawned through the merge-node policy *Merge-back* names and graded like
   *  any other candidate. Empty where every fan-in's parents agreed — there is nothing
   *  to aggregate about two identical answers, and burning a graded node on one would
   *  decide nothing. */
  readonly vertices: readonly string[];
  /** Level members a fan-in could not consume because they produced no usable answer.
   *  Counted rather than silently skipped: an aggregate vertex's claim is that it
   *  consumed its parents, and a missing one makes that claim false. */
  readonly unusableParents: number;
  /** Parents a fan-in consumed AFTER the tree had retired them from selection.
   *
   *  The other half of the pruned-parent decision, and the half that would otherwise be
   *  invisible: pruning says where the next unit of budget goes, not whether measured
   *  work reaches the origin, so a retired parent keeps its edge and its dependent
   *  proceeds from that parent's last good state. Stating the count is what makes that a
   *  decision rather than an omission. */
  readonly prunedParents: number;
  // NO "DEPENDENTS REFUSED" COUNT, and the absence is the design rather than a gap.
  // *Dependency order* refuses a member whose dependency has not merged, and a fan-in
  // offers a member set closed over exactly those, against a ledger of the ones that
  // already landed — so a dependent is held behind its dependency by the ORDER instead
  // of being refused for want of one. A field that can never be non-zero would report a
  // mechanism this engine does not use. `order.length` against `merged` is what a reader
  // compares.
}

/**
 * What a run RE-ENTERED, or null when it started its own search.
 *
 * DISCLOSED RATHER THAN INVISIBLE, and that is the whole reason the field exists: a
 * resumed run that reports exactly like a fresh one hides the eviction from the
 * operator — the incident that produced this machinery settled a job `completed — took
 * 18m` with nothing anywhere saying the search had died and been restarted twice. An
 * 18-minute wall clock over four expansions is a question a reader has to be able to
 * ask.
 */
export interface SwarmResumeReport {
  /** The root this run adopted. The same id its first attempt wrote, which is the
   *  property the whole path is for: one request, one tree. */
  readonly rootId: string;
  /**
   * Nodes an earlier attempt settled and this one did not re-pay for.
   *
   * `expansions` on the report above counts the WHOLE search; this is the part of it
   * that predates this attempt, so `expansions - inheritedExpansions` is what this
   * activation actually bought.
   */
  readonly inheritedExpansions: number;
  /** Expansion budget left when this run re-entered — derived from the tree, so it
   *  never re-pays for a settled node. */
  readonly remainingBudget: number;
  /** Tokens the earlier attempts reported, as their per-node records hold them. Null
   *  where none of them reported any. `tokens` above is THIS attempt's spend and
   *  deliberately not the sum: it is what this activation's ledger was charged, and
   *  adding a figure nobody charged here to it would make the two disagree. */
  readonly inheritedTokens: number | null;
  /** Nodes this attempt RE-RAN under their own ids: spawned by an earlier attempt,
   *  never recorded in the tree, and re-entered rather than retired or replaced. Zero
   *  on a re-entry that lost nothing mid-level. They are inside
   *  `inheritedExpansions` — the search paid for them once — so a re-run costs no
   *  budget and creates no node. */
  readonly resumedNodes: number;
  /** Ledger rows for the same task this re-entry superseded — empty unless two
   *  identical-task attempts were both left `running`. */
  readonly superseded: readonly string[];
  /** How many times this search has now been re-driven, counting this one. Reads
   *  straight off the lease the re-entry claimed, which `reclaim` bumps once per
   *  attempt, so it cannot drift from the fencing it is derived from. */
  readonly attempt: number;
}

/**
 * The settle report: what the run REACHED, what it spent, and what it
 * did not find — with the last one stated as a fact about the search rather than
 * about the world.
 *
 * The whole point of it is the distinction a report is most tempted to
 * collapse: *"did not find"* is not *"does not exist"*, and a search that conflates
 * them is the same defect as a floor nobody proved. So `witnessFound` is a verdict
 * about this run, `stop` says why the run ended, and neither field can be rendered
 * as an existence claim because neither carries one.
 */
export interface SwarmSettleReport {
  /** Derived from the resolved axes, never chosen. */
  readonly settle: SwarmSettle;
  /** *Floor margin* C3: computed and surfaced at declaration, never thresholded,
   *  because the failure being designed against was a thin margin nobody had looked at.
   *  NULL when the objective declared no floor — not zero, which claims a floor sitting
   *  exactly at the best known honest cost. */
  readonly floorMargin: number | null;
  /** The measured baseline, in the objective's unit. *Measured baseline*: measured
   *  before any candidate exists, never supplied by a caller. NULL when the run
   *  measured nothing (no objective, or the shape does not measure). */
  readonly baseline: number | null;
  /**
   * Whether the witness was FOUND by this run. Null when the objective is not a
   * witness hunt.
   *
   * `false` means this search did not find one under this budget. It does not mean
   * none exists, and the report carries no field that could say so.
   */
  readonly witnessFound: boolean | null;
  /**
   * The carry disclosure *The publication seal* requires, as DATA rather than prose, or
   * null when the carry was not suppressed. Null is "not suppressed" and is a different
   * claim from a suppression of zero cells.
   */
  readonly carrySuppressed: CarrySuppression | null;
  /**
   * *The records store*, as this run touched it, or null when the run had no
   * OBJECTIVE IDENTITY to key a record by.
   *
   * Null is a claim about comparability and not about the store: a record is keyed by
   * {@link ObjectiveIdentity} together with the floor digest, and a run that measured
   * no objective — `score:'judge'`, `score:'none'` — has no identity, so there is
   * nothing it could have written and nothing it could have read. That is a different
   * fact from a measured run that wrote zero rows, which reports zeroes.
   */
  readonly records: ExplorationRecordsReport | null;
  /**
   * What the judge ensemble was ASKED for and what it actually ran, or null for a run
   * that scored by anything other than a judge.
   *
   * On the surface's own defaults the request is answered by three, and this field
   * exists so that stays SAID. `judgeSamples` and `maxEvalLLMCalls` are not
   * independent knobs — a code-bearing branch realises min(samples, maxEvalLLMCalls −
   * 1) — and the clamp binding in silence is the defect `judgeCallBudget` was
   * extracted to end.
   */
  readonly judgeEnsemble: JudgeEnsembleReport | null;
  /** Why the run ended. `budget` is the honest answer where a marginal-gain
   *  threshold trips early — the report says the gain decayed rather than implying
   *  the space is exhausted. */
  readonly stop: 'settled' | 'budget' | 'aborted';
  /** What it cost, absent rather than zero when nothing was reported: an unmeasured
   *  run is not a free one. */
  readonly expansions: number;
  readonly tokens: number | null;
  readonly durationMs: number;
  /** What `expand:'aggregate'` fanned in, or null on a run that fans in nothing. */
  readonly fanIn: SwarmFanInReport | null;
  /** What this run re-entered, or null when it is the search's first attempt. */
  readonly resumed: SwarmResumeReport | null;
}

/**
 * What `agents.swarm` returns for a run that started.
 *
 * A run that did not start returns a refusal instead, and the two are different
 * shapes on purpose: a caller branching on `reason` is asking a different question
 * from one reading a report.
 */
export interface SwarmResult {
  readonly preset: SwarmPreset;
  /** The composition's provenance label, or null for a preset run — which under
   *  *Presets* means exactly "a tested path". */
  readonly label: string | null;
  /** The axes actually in force, so a reader need not re-derive them from the
   *  preset name — and so a record can digest what ran rather than what was asked
   *  for. */
  readonly config: SwarmConfig;
  readonly caps: ResolvedSwarmCaps;
  readonly report: SwarmSettleReport;
  readonly publication: SwarmPublicationMarker;
  /** The answer, under whatever `settle` the axes derived. Null when every
   *  candidate was unmeasurable — refusing to read a winner out of no signal. */
  readonly best: SwarmCandidate | null;
  readonly candidates: readonly SwarmCandidate[];
  /** The nondominated candidates, in deterministic candidate order. Null when this
   * run did not use `advance:"pareto"`. */
  readonly frontier: readonly SwarmCandidate[] | null;
  readonly profile?: SwarmProfileSnapshot;
}

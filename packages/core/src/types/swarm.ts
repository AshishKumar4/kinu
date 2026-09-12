/** The swarm-search contract, declared at the platform layer: the tools-layer
 *  input schemas and the delegation surface share the preset vocabulary, the
 *  axis settings and the call shape without importing the strategy engine. */

import type { Objective } from './objective';

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
 * `inherit` — the child inherits the parent's context VERBATIM, plus the parent's
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
export const SWARM_CONTEXTS = ['inherit', 'fresh'] as const;

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
 * The `unit` axis, UNTAGGED — and the note recording why it carries no parameter.
 *
 * `unit` distinguishes an agent answer from a toolless thought. Inheritance
 * belongs to `SWARM_CONTEXTS`, which governs the caller-to-root edge and every
 * branch edge, so `unit` carries no inheritance parameter. *One
 * spelling per axis*: *"the caller-to-root edge and every branch edge are the same
 * question and MUST have the same spelling"* — two fields, two names, one question,
 * with a docstring whose only job is telling a reader they are different.
 *
 * A tagged shape kept for a parameter that belongs to a whole axis would be the second
 * spelling *One spelling per axis* exists to prevent, so the variant is a plain union:
 * the tagged axes are {@link SwarmScoreSetting} and {@link SwarmCarrySetting}, which
 * carry parameters no other value of theirs can hold.
 */
export type SwarmUnitSetting =
  | { readonly kind: 'answer' }
  | { readonly kind: 'thought' };

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

/** Closed swarm preset vocabulary. Kept independent of the search engine so
 * profile schemas and prompt surfaces do not import engine policy. */
export const SWARM_PRESETS = [
  'ideate',
  'research',
  'audit',
  'redteam',
  'optimise',
  'prove',
  'custom',
] as const;

export type SwarmPreset = (typeof SWARM_PRESETS)[number];

export const NAMED_SWARM_PRESETS = SWARM_PRESETS.filter(
  (preset): preset is Exclude<SwarmPreset, 'custom'> => preset !== 'custom',
);

export type NamedSwarmPreset = (typeof NAMED_SWARM_PRESETS)[number];

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
  /** Requested search depth, overriding the selected preset. This bounds the
   * search tree, separately from subordinate lineage and a head's inherited
   * split budget. */
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
   * through (`AgentsSwarmDeps.resolveModel`), so there is no second resolver and
   * no provider drift. An unresolvable spec is refused as `bad_input` naming
   * the spec, BEFORE any node runs — the refusal this field's first life lacked,
   * which is the whole of what its removal bought and what its return must keep.
   */
  readonly models?: readonly string[];
}

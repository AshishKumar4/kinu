/**
 * The shape of a configured search: the axes, five presets, one escape hatch —
 * and what a call resolves to, whether that resolution is legal, and what a run
 * reports.
 *
 * Specified by docs/EXPLORATION-SPEC.md sections 6-9. The axes are derived from a
 * 27-technique coverage matrix rather than chosen; the matrix, not this file, is the
 * argument for how many there are.
 *
 * WHAT A PRESET IS. A preset fixes the search. The caller supplies the objective.
 * Those are the two halves of a call and they never mix: `config` is axes only,
 * and a named preset does not accept it at all (section 6.4 records the decision
 * and its four reasons).
 *
 * WHY THE TABLE, THE RESOLVER AND THE PREDICATE ARE ONE MODULE. §6.5 checks validity
 * over the RESOLVED configuration, so the predicate is meaningless without the
 * resolution and the resolution is meaningless without §6.3's table. Written apart,
 * the table became prose nothing read: a preset was called a "named point" for four
 * revisions with no point written down, and the predicate had no input for a NAMED
 * preset at all. {@link SWARM_PRESET_POINTS} is therefore the fixture and the
 * resolver at once, which is deliberate — two spellings of the preset points would
 * drift exactly as §6.4's reason 1 describes.
 */

import { ProteusError, refusalOf } from '../obs/error';
import { floorMargin } from './objective';
import type {
  CarrySuppression, Floor, MeasuredValue, Objective, ObjectiveDirection, PublicationState,
} from './objective';

/**
 * What one node PRODUCES.
 *
 * `answer` and `generator` are AGENT nodes — a tool loop with its own turns and its
 * own transcript (§8.1) — and they differ in what the loop is asked for: one
 * candidate, or the generator that produces candidates (`objective.ts` reaches
 * `scaffold_versions` when the artifact IS a prompt or a scaffold). `thought` is
 * §8.9's degenerate point: one model call, no tools, no observation of an
 * environment because it has no way to touch one. It is the CHEAP TIER rather than
 * a defect, and Tree-of-Thoughts is that point plus a selector.
 *
 * `trajectory` is gone and `step` with it. `trajectory` named the shape this axis
 * now HAS at two of its three values, so keeping it would be two spellings of one
 * thing — and the parameter it carried (does this node start from the caller's
 * conversation) is the {@link SWARM_CONTEXTS} question, asked once for the whole
 * surface instead of twice with two names. `step` never executed at all.
 */
export const SWARM_UNITS = ['answer', 'generator', 'thought'] as const;
export type SwarmUnit = (typeof SWARM_UNITS)[number];

/**
 * What a child STARTS FROM — §8.4, and the one axis that spans the caller-to-root
 * edge and every parent-to-child edge with a single spelling.
 *
 * `fork` — the child inherits the parent's context VERBATIM, plus the parent's
 * reported results, plus its own focus. Verbatim is a decision about CACHING and
 * not about fidelity: an unmodified prefix is a prefix a provider can cache, so
 * every sibling of one parent shares one cacheable prefix, and rewriting the
 * history to hand each child a summary breaks that prefix for all of them at once.
 *
 * `fresh` — the last two and nothing else. Not "start blank": a fresh child is
 * SEEDED with what its parent reported, which is a third thing from both inheriting
 * everything and starting from nothing, and it is the one §8.4 names explicitly.
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
 * together. Two axes asking one question is the second spelling §6.4's first
 * reason exists to prevent, and `context` is the one that also binds the root.
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
 * field on the config, which made §6.3's preset table — normatively
 * `resolve(preset) -> SwarmConfig` — **unconstructible for all five rows**, because
 * four presets do not score by judge and have nothing to put there. Proven by the
 * compiler, not by reading (`FixtureZero`, TS2741).
 *
 * The three ways out were not equal, and only one makes the invalid state
 * UNREPRESENTABLE rather than merely refused:
 *  - optional `judgeSamples?` — then §6.5's refusal is stated over an ABSENT input,
 *    and absent-is-not-zero is this document's founding rule. It manufactures the
 *    very shape the audit just removed: a gate that cannot see its own input.
 *  - `judgeSamples` inheriting the live default of 3 — then four of five presets ship
 *    below the marginalisation bar and the record cannot say whether 3 was chosen or
 *    inherited, which is the absent-default defect one level up.
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
      /** Ensemble size. REQUIRED here and unrepresentable elsewhere, so §6.5's
       *  marginalisation refusal always has its input. */
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
 * IT COSTS SOMETHING AND THE COST IS REAL. §6.3 never stated a τ for any preset —
 * its 0.6 is Rainbow Teaming's measured filter offered as evidence that a
 * rejection test is needed, not a threshold this specification declares — so every
 * preset that resolves to `archive` now has a required parameter the table does
 * not supply, and `redteam` joins `research` and `audit` as an UNDECLARED row.
 * That is three of the archive presets refusing to resolve where one of them used
 * to. Inventing the number here is the one thing this file may not do.
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
 * caller-to-root edge and every branch edge together. §8.4: *"the caller-to-root
 * edge is the same question and MUST have the same spelling"* — two fields, two
 * names, one question, with a docstring whose only job was telling a reader they
 * were different.
 *
 * A tagged shape kept for a parameter that moved would be the second spelling
 * §6.4's first reason exists to prevent, so the variant is a plain union: the
 * remaining tagged axes are {@link SwarmScoreSetting} and {@link SwarmCarrySetting},
 * which still carry parameters no other value of theirs can hold.
 */
export type SwarmUnitSetting =
  | { readonly kind: 'answer' }
  | { readonly kind: 'generator' }
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
 * "predicate stated but not exhaustively applied" defect §6.1 exists to close.
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
   * {@link SwarmUnitSetting} — `answer` and `generator` run a tool loop, `thought`
   * is one model call.
   */
  readonly unit: SwarmUnitSetting;
  /**
   * What a child starts from, for the whole search: the caller-to-root edge and the
   * default every branch narrows below. §8.4, and {@link SWARM_CONTEXTS} for why
   * one axis carries both edges.
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
   * a parameter that is accepted and ignored is the §2.5 lie about what a run did.
   */
  readonly pruneThreshold?: number;
  readonly minVisitsForPrune?: number;
  /**
   * NOTE what is deliberately NOT here: `branches`, `depth` and `models`. All three
   * are per-run choices rather than technique identity — ToT at branches=3 and ToT
   * at branches=8 are the same TECHNIQUE, and so is ToT routed across a cheap and a
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
 * The six tested paths, plus the honest declaration that none of them fits.
 *
 * `custom` is not a seventh preset. It is the statement that no preset is the
 * base, which matters because the matrix holds the techniques while the presets
 * pin six points: Reflexion, Graph-of-Thoughts, Mixture-of-Agents, GEPA,
 * Promptbreeder and ADAS are none of them, and naming one as the base for a
 * composition that overrode four of six axes would be a lie about provenance in
 * the run record.
 *
 * `prove` is the sixth and it is the second row with a checker. It exists because
 * a mathematical proof or a formal claim is the one search whose value signal is
 * EXACT — a checker accepts or it does not — and every other preset either has no
 * verifier or has a noisy one, so a proof run composed out of them would have been
 * `optimise` with its depth and its thresholds argued from scratch every time.
 */
export const SWARM_PRESETS = [
  'ideate', 'research', 'audit', 'redteam', 'optimise', 'prove', 'custom',
] as const;
export type SwarmPreset = (typeof SWARM_PRESETS)[number];

/**
 * The named presets, i.e. everything a `from` may point at, and the picklist the tool
 * surface offers for it.
 *
 * Derived by exclusion rather than listed, so a sixth preset joins `from` by joining
 * {@link SWARM_PRESETS} — and `custom` cannot appear here, which is the type saying
 * what §6.4 says in prose: a composition cannot be seeded from "no preset is the
 * base".
 */
export const NAMED_SWARM_PRESETS = SWARM_PRESETS.filter(
  (preset): preset is Exclude<SwarmPreset, 'custom'> => preset !== 'custom',
);

export type NamedSwarmPreset = (typeof NAMED_SWARM_PRESETS)[number];

/**
 * A call.
 *
 * `config` and `from` appear only with `preset:'custom'`. That is the decision in
 * section 6.4 and it is load-bearing three ways: it keeps one spelling per
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
   * The coverage key for the archive presets (`research`, `audit`, `redteam`).
   *
   * Must name something a ToolCallRecord can witness. A key that can only say
   * "distinct idea" is a task with no coverage objective, and that task wants
   * `ideate`.
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
   * Per-node model variation, for CAPABILITY AND COST ROUTING — a cheap model for
   * recon, a strong one for synthesis. Available on EVERY preset.
   *
   * NOT for diversity. Self-MoA (2502.00674) re-ran Mixture-of-Agents' own ablation
   * over the same six models and found the HOMOGENEOUS ensemble beat the mixed one
   * 65.7 vs 59.1 with the proposer count and topology held fixed (six proposals, one
   * aggregator; the paper claims no cost parity), quality dominating diversity by up
   * to 3.2×.
   * A model zoo is measured WORSE than repeated sampling from the best model when
   * the purpose is diversity. Diversity is not this field's job and never was.
   *
   * Cost routing is understood 3/3 across vendors, so the field earns its place.
   *
   * THIS FIELD USED TO CARRY A REFUSAL AND NO LONGER DOES. `models.length > 1` was
   * refused under `decorrelate:'none'`, on the argument that a zoo was then the
   * run's only source of candidate diversity. That axis is gone and sibling angles
   * are unconditional, so the premise cannot hold: a zoo is never the only source
   * any more. The measurement above still stands and is still the reason to reach
   * for `models` for routing rather than for variety — it is advice now, which is
   * what it can honestly be once the composition it warned about is unreachable.
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

/* ── Resolution: §6.3's table IS the resolver ─────────────────────────────── */

/**
 * One preset's declared point: its seven axes, plus the two caps it DEFAULTS.
 *
 * `depth` and `branches` sit here rather than inside {@link SwarmConfig} because
 * they are defaults for caps a caller may override rather than axis values — the
 * §6.1 verdict — and because with them in `config` no named preset could have set
 * either one.
 */
export interface SwarmPresetPoint {
  readonly config: SwarmConfig;
  readonly depth: number;
  readonly branches: number;
}

/**
 * A preset whose §6.3 row cannot be CONSTRUCTED as printed, naming exactly what
 * the document has not stated.
 *
 * Not a placeholder and not a deferral: {@link resolveSwarm} REFUSES this preset
 * and quotes this sentence. Supplying the number here would make this file the
 * source of truth for a quantity the specification never set — the absent-default
 * defect `ExplorationRecord.configDigest` is written against, committed by the
 * implementation instead of by the document, and undetectable afterwards because
 * the record would carry a shape nobody declared.
 */
export interface SwarmPresetUndeclared {
  readonly undeclared: string;
}

export type SwarmPresetRow = SwarmPresetPoint | SwarmPresetUndeclared;

/** Whether §6.3 declares this row completely enough to resolve. */
export function isPresetPoint(row: SwarmPresetRow): row is SwarmPresetPoint {
  return 'config' in row;
}

/**
 * §6.3's tuple table, which is normatively `resolve(preset) → SwarmConfig` and the
 * ONLY definition of it. A named preset resolves to exactly its row; `custom`
 * resolves to `config`, optionally seeded from `from`'s row. There is deliberately
 * no `custom` row: `config` IS the override and `from` names the base, and a second
 * row would be the second spelling §6.4's first reason exists to prevent.
 *
 * THREE ROWS ARE UNDECLARED AND ALL THREE ARE THE SAME GAP — a tagged arm whose
 * parameter §6.3 never states. `research` and `audit` were already here for
 * `carry:'artifacts'`. `redteam` JOINED THEM in this change, and that is a cost
 * rather than a tidy-up: it used to resolve. Its `advance:'archive'` now requires
 * the novelty rejection test that re-homed off `score` (see
 * {@link SwarmAdvanceSetting}), and §6.5's τ=0.6 is Rainbow Teaming's measured
 * filter offered as evidence that a rejection test is NEEDED — it is not a
 * threshold this specification declares for a preset. So there is nothing to put
 * there, and this table says so instead of inventing it.
 *
 * `prove` is declared rather than undeclared even though it too takes an
 * `artifacts` threshold, and the difference is not special pleading: it is the one
 * preset whose admission rule is DERIVED rather than chosen. Its checker accepts
 * or it does not, so an artifact is kept exactly when the checker accepted it, and
 * the normalised threshold for that is 1. `research` and `audit` have no checker
 * and therefore no derivation — which is precisely why their number would have to
 * be invented.
 */
export const SWARM_PRESET_POINTS = {
  ideate: {
    config: {
      // §6.3's row: `fresh`. A flat ideation wave has no parent conversation to
      // inherit — the root's parent is the caller, and `context` binds the branch
      // edge, of which this preset has none.
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'none' }, advance: { kind: 'none' }, carry: { kind: 'none' },
    },
    // Depth is one BY CONSTRUCTION rather than by choice: `advance:'none'` means there is no
    // selection step, so there is no second level to reach (§8.3).
    depth: 1,
    branches: 5,
  },
  research: {
    undeclared: "§6.3 gives `research` carry:'artifacts', whose admission threshold the "
      + 'table does not state. §6.5\'s τ=0.6 is Rainbow Teaming\'s measured filter, not this '
      + "preset's declared threshold, so the row cannot be constructed as printed",
  },
  audit: {
    undeclared: "§6.3 gives `audit` carry:'artifacts', whose admission threshold the table "
      + 'does not state — the same absence as `research`, whose tuple §6.6 property 3 '
      + 'declares this one collides with',
  },
  redteam: {
    undeclared: "§6.3 gives `redteam` advance:'archive', whose novelty rejection test is now a "
      + 'parameter of that arm rather than a `score` value, and the table states no threshold '
      + 'for it. This row USED TO RESOLVE: it resolved while an archive without a rejection '
      + "test was merely refused, and it stops resolving now that it is unconstructible. τ=0.6 "
      + 'is Rainbow Teaming\'s measured filter, not this preset\'s declared threshold',
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
  },
  prove: {
    config: {
      // `generator`: a proof is produced by something that can run its own checker
      // between steps, not by a single answer handed back.
      unit: { kind: 'generator' }, context: 'fork',
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
  },
} as const satisfies Record<NamedSwarmPreset, SwarmPresetRow>;

/**
 * The `advance` values that select down a TREE, i.e. the region §6.5's refusals
 * about trees are stated over and the region `pruneThreshold` applies to.
 *
 * Derived by exclusion from {@link SWARM_ADVANCES} rather than listed, so a new
 * `advance` value cannot join the axis and quietly fall outside every tree rule.
 */
export const SWARM_TREE_ADVANCES = SWARM_ADVANCES.filter(
  (advance) => advance !== 'archive' && advance !== 'pareto' && advance !== 'none',
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
 * only through `custom` with no `from` — §6.3 declares rows for the five named
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
 * The arguments are HERE rather than left on the input because §6.5's refusals are
 * stated over them — `pareto` reads the objective's kind, the archive rules read
 * `key`, C1 reads the floor — and a predicate that cannot see
 * its own input is the §3.8 defect this specification exists to refuse.
 */
export interface ResolvedSwarm {
  readonly preset: SwarmPreset;
  /** The base a composition was seeded from, or null. Provenance: `from` does not
   *  make this a preset run and the record still says `custom`. */
  readonly from: NamedSwarmPreset | null;
  readonly label: string | null;
  readonly config: SwarmConfig;
  /** Derived, never supplied — {@link settleOf} over the resolved axes. */
  readonly settle: SwarmSettle;
  readonly caps: ResolvedSwarmCaps;
  readonly task: string;
  readonly objective: Objective | null;
  readonly key: string | null;
  readonly models: readonly string[] | null;
}

/** §6.5's refusal, built through the one projection every other refusal in the
 *  tree is rendered by, so a cause chain reads the same here as anywhere else. */
function badInput(error: string): SwarmRefusal {
  return { reason: 'bad_input', error: refusalOf(new ProteusError('bad_input', error)).error };
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
 * THE COUNT IS SIX, and it agrees with §6.1 now. `context` joined because §8.4's
 * inheritance needs one spelling for the caller-to-root edge and the branch edge
 * together; `observe` and `decorrelate` left in the same change, and neither is a
 * deferral. `observe` collapsed value by value onto things that already exist —
 * `none` is what a `thought` node IS, `own` is what holding tools MEANS now that
 * every other unit is a real agent, and `ancestors` is what `context:'fork'`
 * supplies by construction. `decorrelate` shipped with all three of its values
 * behaving identically: sibling angles were handed out under every one of them
 * INCLUDING `blind`, which names the opposite, so no caller was ever choosing
 * anything. Diversification is now unconditional, which removes the ability to
 * turn angles OFF and keeps the ability that was working.
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

/** The caps §2.5 makes optional on every preset, resolved call-first then row. */
function resolveCap(
  supplied: number | undefined, row: number | undefined,
): ResolvedCap | null {
  if (supplied !== undefined) return { value: supplied, origin: 'call' };
  if (row !== undefined) return { value: row, origin: 'preset' };
  return null;
}

/**
 * The §2.5 / §6.4 requiredness rules that are properties of the CALL rather than
 * of the resolved shape, so they run before there is a resolution to check.
 *
 * Split from {@link swarmValidity} on purpose: `config` on a named preset cannot be
 * stated over the resolved configuration at all, because accepting it is what would
 * have produced the resolution. The rules stated over resolved values — objective
 * required iff resolved `score` is `verify`, key iff resolved `advance` is
 * `archive` — live in the predicate, where their input exists.
 */
function requiredFieldRefusal(input: SwarmInput): SwarmRefusal | null {
  const composed = input.preset === 'custom';
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
    // `key` is NOT checked here. §2.5 prohibits it on `ideate` and on `optimise` and
    // requires it on the three archive presets, which is one rule about the resolved
    // `advance` rather than four about preset names — so it lives in
    // {@link swarmValidity} beside the archive rule, where `custom` gets the same
    // verdict for the same reason.
    if (input.preset === 'optimise' && !input.objective) {
      return badInput('`optimise` measures something and this call did not say what. Supply `objective` '
        + 'with a `metric`, a `unit`, a `direction` and a `target`. `ideate` needs none; '
        + 'research/audit/redteam need a coverage `key` instead.');
    }
  }
  return null;
}

/**
 * `resolve(preset) → SwarmConfig`, and the refusals that stop a call before there
 * is anything to resolve.
 *
 * §6.5 states validity over the RESOLVED configuration, so this is the function
 * that gives the predicate an input at all. It is deliberately total over
 * `SwarmPreset`: an undeclared row is refused with the missing declaration quoted,
 * never resolved to something plausible.
 */
export function resolveSwarm(input: SwarmInput): ResolvedSwarm | SwarmRefusal {
  const required = requiredFieldRefusal(input);
  if (required) return required;

  const baseName: NamedSwarmPreset | null = input.preset === 'custom'
    ? input.from ?? null
    : input.preset;
  let base: SwarmPresetPoint | null = null;
  if (baseName) {
    const row: SwarmPresetRow = SWARM_PRESET_POINTS[baseName];
    if (!isPresetPoint(row)) {
      return badInput(`preset "${baseName}" has no resolvable point: ${row.undeclared}. `
        + 'A preset whose row is absent is not a preset, so this call cannot be checked for '
        + 'validity — use preset:"custom" and state the axes, including the parameter that is '
        + 'missing, under a `label`.');
    }
    base = row;
  }

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
    config,
    settle: settleOf(config),
    caps: {
      branches: resolveCap(input.branches, base?.branches),
      depth: resolveCap(input.depth, base?.depth),
    },
    task: input.task,
    objective: input.objective ?? null,
    key: input.key ?? null,
    models: input.models ?? null,
  };
}

/* ── Validity, over the resolved configuration (§6.5) ─────────────────────── */

/** Every floor a resolved objective declares, with the direction it is stated
 *  against — a `vector` objective carries one per component and a `witness` carries
 *  its proxy's, so C1 cannot be written over a single field. */
function floorsOf(objective: Objective): readonly { floor: Floor; direction: ObjectiveDirection }[] {
  if (objective.kind === 'vector') return objective.components.flatMap(floorsOf);
  if (objective.kind === 'witness') return objective.proxy ? floorsOf(objective.proxy) : [];
  return objective.floor ? [{ floor: objective.floor, direction: objective.direction }] : [];
}

/**
 * §6.5's table, executable. Returns the FIRST refusal in table order, or null.
 *
 * One refusal rather than a list, and one imperative per refusal, which is §7.2's
 * measured result: a refusal naming two ways out was corrected to the wrong one.
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
  if (tree && config.score.kind === 'judge' && config.score.samples < JUDGE_MARGINALISATION_MIN) {
    return badInput(`a judged scalar is a noisy scorer and a tree amplifies scorer noise, so score:"judge" `
      + `down a tree needs samples ≥ ${String(JUDGE_MARGINALISATION_MIN)} and this composition has `
      + `${String(config.score.samples)}: at fixed node expansions a marginalised WEAKER judge beats an `
      + 'unmarginalised stronger one, 30.0% against 28.5%. Raise `samples`, and note the binding cap is '
      + '`maxEvalLLMCalls` rather than the request — a code-bearing branch realises '
      + 'min(samples, maxEvalLLMCalls − 1), so raising this alone silently does nothing.');
  }
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
    return badInput('score:"verify" measures something and this composition did not say what. Supply '
      + '`objective` with a `metric`, a `unit`, a `direction` and a `target` — or score:"none" for a flat '
      + 'run with no value signal.');
  }
  if (advance === 'archive' && !resolved.key) {
    return badInput('an archive needs a descriptor to bin elites into, and it must name something a '
      + '`ToolCallRecord` can witness. Supply `key`. A key that can only say "distinct idea" is a task '
      + 'with no coverage objective — that task wants preset:"ideate".');
  }
  if (resolved.key && advance !== 'archive') {
    return badInput(`\`key\` is the descriptor an archive bins elites into, and advance:"${advance}" `
      + 'keeps no archive, so this run would accept a coverage key and report no coverage — which is a '
      + 'silent lie about what it did rather than a harmless extra. Drop `key`, or use '
      + 'advance:"archive" if coverage is what you want.');
  }
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
   * `context` is PER BRANCH (§8.2's shape) and defensible precisely because the
   * NODE knows which of its threads is worth inheriting a whole conversation for
   * while the engine does not. It is validated against the search's own `context`
   * rather than overriding it: a run resolved `fresh` refuses a `fork` child and
   * says so, instead of quietly honouring one of two conflicting policies. A node
   * may NARROW, never widen.
   */
  readonly branches: readonly {
    readonly task: string;
    readonly rationale: string;
    readonly context: BranchContext;
  }[];
}

/**
 * §8.2's width band: a proposal names 2-4 narrower sub-questions.
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
 * proposal — §8.2's single scheduler, which a proposal is an input to.
 *
 * A faithful port of `lean/Proteus/Exploration/Arbitration.lean`'s `arbitrate`,
 * including its ORDER: the theorems there are projections of one acceptance
 * region (`accepted_iff`), so a reordering here would leave the proven arbiter and
 * the shipped one agreeing on which proposals pass while disagreeing on what the
 * node is TOLD, which is the half §7.2 measured as load-bearing. The five arms
 * discharge, in order, `archive_refuses_at_node`, `accepted_width_in_range`,
 * `accepted_children_within_depth` (S3), `accepted_within_budget` (S8) and
 * `accepted_respects_context` (§8.4).
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
 * work: {@link SWARM_CONTEXTS} decides what a child starts from. §8.4 states the rule over
 * the second one — *"a search resolved to `fresh` refuses a `fork` child"* — so the
 * arm compares `context` with `context`, and the theorem is
 * `accepted_respects_context`. That re-pointing is the cost §6.7's cut list named,
 * paid here rather than deferred, because a proven theorem about a field that no
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

/* ── The result half: what a settled run reports (§2.4(c), §4.4, §4.5) ────── */

/**
 * Whether the run's own ANSWER may be published, and under what.
 *
 * §4.4 seals the STORE — {@link PublicationState} plus `admitsPublication` govern
 * the six enumerated surfaces — and it deliberately does NOT seal the settle report,
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
  /** Why there is no measurement, when there is none. */
  readonly unmeasurable: string | null;
  readonly score: number | null;
}

/**
 * §2.4(c)'s mandated settle report: what the run REACHED, what it spent, and what it
 * did not find — with the last one stated as a fact about the search rather than
 * about the world.
 *
 * The whole point of the section is the distinction a report is most tempted to
 * collapse: *"did not find"* is not *"does not exist"*, and a search that conflates
 * them is the same defect as a floor nobody proved. So `witnessFound` is a verdict
 * about this run, `stop` says why the run ended, and neither field can be rendered
 * as an existence claim because neither carries one.
 */
export interface SwarmSettleReport {
  /** Derived from the resolved axes, never chosen. */
  readonly settle: SwarmSettle;
  /** §4.5 C3: computed and surfaced at declaration, never thresholded, because the
   *  failure being designed against was a thin margin nobody had looked at. NULL
   *  when the objective declared no floor — not zero, which claims a floor sitting
   *  exactly at the best known honest cost. */
  readonly floorMargin: number | null;
  /** The measured baseline, in the objective's unit. §2.3: measured before any
   *  candidate exists, never supplied by a caller. NULL when the run measured
   *  nothing (no objective, or the shape does not measure). */
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
   * §4.4's carry disclosure, as DATA rather than prose, or null when the carry was
   * not suppressed. Null is "not suppressed" and is a different claim from a
   * suppression of zero cells.
   */
  readonly carrySuppressed: CarrySuppression | null;
  /** Why the run ended. `budget` is the honest answer where a marginal-gain
   *  threshold trips early — the report says the gain decayed rather than implying
   *  the space is exhausted. */
  readonly stop: 'settled' | 'budget' | 'aborted';
  /** What it cost, absent rather than zero when nothing was reported: an unmeasured
   *  run is not a free one. */
  readonly expansions: number;
  readonly tokens: number | null;
  readonly durationMs: number;
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
   *  §6.4 means exactly "a tested path". */
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
}

/**
 * The shape of a configured search: seven axes, five presets, one escape hatch —
 * and what a call resolves to, whether that resolution is legal, and what a run
 * reports.
 *
 * Specified by docs/EXPLORATION-SPEC.md sections 6-9. The axes are derived from a
 * 27-technique coverage matrix rather than chosen; the matrix, not this file, is the
 * argument for why there are seven.
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

/** What one node is. */
export const SWARM_UNITS = ['step', 'answer', 'trajectory', 'generator'] as const;
export type SwarmUnit = (typeof SWARM_UNITS)[number];

/**
 * What ENVIRONMENT FEEDBACK enters the expansion prompt.
 *
 * `own` — this node's own observation. `ancestors` — every ancestor's, walked
 * root-ward. The axis is load-bearing rather than cosmetic: without it
 * Tree-of-Thoughts and LATS-over-programs are the same configuration, and they
 * are measurably not (feat/mcts-as-lats, commit 0da703d6).
 */
export const SWARM_OBSERVES = ['none', 'own', 'ancestors'] as const;
export type SwarmObserve = (typeof SWARM_OBSERVES)[number];

/**
 * How children are produced.
 *
 * `aggregate` is fan-in — k parents consumed by one child — and it is precisely
 * what makes a graph a DAG rather than a tree. Graph-of-Thoughts' `Aggregate`
 * vertex and Mixture-of-Agents' layers are both this value.
 */
export const SWARM_EXPANDS = ['sample', 'mutate', 'aggregate'] as const;
export type SwarmExpand = (typeof SWARM_EXPANDS)[number];

/**
 * How hard children are pushed apart.
 *
 * This is where decorrelation lives, and it is the ONLY place it lives. Varying
 * models is not decorrelation — see {@link SwarmConfig.models}.
 *
 * `blind` — a child is expanded WITHOUT sight of its siblings' proposals. Named
 * `blind` and not `fresh` because `fresh` was measured unusable: 0/6 on a reverse
 * probe, read as RECENCY by both vendors shown the bare name, and 4 of its 10
 * in-context uses described the `angles` mechanism instead **with the gloss in front of
 * the model**. Three independent instruments, six model families
 * (`AxisErgonomics`, 245 answered calls). It is the only axis value the study found
 * unusable and the only rename argued from measurement rather than taste.
 *
 * `angles` STAYS despite scoring 2/6 on the same bare-name probe, because it was
 * correct in all 29 of its in-context uses — and `carry` stays for the same reason
 * (23/24 with the mechanism present). A name is only ever read beside the question it
 * answers, so a bare-probe failure is a documentation constraint and not a rename.
 */
export const SWARM_DECORRELATES = ['none', 'angles', 'blind'] as const;
export type SwarmDecorrelate = (typeof SWARM_DECORRELATES)[number];

/** How a node is valued. */
export const SWARM_SCORES = ['verify', 'agree', 'novelty', 'judge', 'none'] as const;
export type SwarmScore = (typeof SWARM_SCORES)[number];

/** Where the next unit of budget goes. */
export const SWARM_ADVANCES = [
  'uct', 'beam', 'best-first', 'pareto', 'archive', 'none',
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
  | { readonly kind: 'agree' }
  | { readonly kind: 'novelty' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'judge';
      /** Ensemble size. REQUIRED here and unrepresentable elsewhere, so §6.5's
       *  marginalisation refusal always has its input. */
      readonly samples: number;
    };

export type SwarmCarrySetting =
  | { readonly kind: 'none' }
  | { readonly kind: 'elites' }
  | { readonly kind: 'reflections'; readonly threshold: number }
  | { readonly kind: 'artifacts'; readonly threshold: number };

/**
 * The rule the two types above instantiate, and its ONE honest exception.
 *
 * **Where a parameter belongs to exactly one axis value, it lives ON that value.**
 * Applied exhaustively: `samples` to `score:'judge'`, and the admission thresholds to
 * `carry:'reflections'`/`'artifacts'`.
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
  readonly unit: SwarmUnit;
  readonly observe: SwarmObserve;
  readonly expand: SwarmExpand;
  readonly decorrelate: SwarmDecorrelate;
  /**
   * How a node is valued. A TAGGED value rather than a bare string, because
   * `score:'judge'` carries a parameter and the other four do not.
   *
   * `SWARM_SCORES` remains the axis's value set — the tags ARE the values, so the
   * coverage matrix and `settleOf` read `score.kind` and the 28-value derivation is
   * unchanged.
   */
  readonly score: SwarmScoreSetting;
  readonly advance: SwarmAdvance;
  /** What survives, tagged for the same reason as {@link score}: two of the four
   *  values carry an admission threshold and two do not. */
  readonly carry: SwarmCarrySetting;
  /**
   * UCT's exploration constant. Applies ONLY to `advance:'uct'` and is otherwise
   * ignored — see the region note below for why this one is not tagged.
   */
  readonly explorationWeight?: number;
  /**
   * Pruning policy. Applies to the REGION of tree selectors (`uct`, `beam`,
   * `best-first`) rather than to one axis value, which is why it cannot be tagged
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
 * The five tested paths, plus the honest declaration that none of them fits.
 *
 * `custom` is not a sixth preset. It is the statement that no preset is the base,
 * which matters because the matrix holds 27 techniques while the presets pin 5
 * points: Reflexion, Graph-of-Thoughts, Mixture-of-Agents, GEPA, Promptbreeder
 * and ADAS are none of them, and naming one as the base for a composition that
 * overrode four of seven axes would be a lie about provenance in the run record.
 */
export const SWARM_PRESETS = [
  'ideate', 'research', 'audit', 'redteam', 'optimise', 'custom',
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
   * to 3.2x.
   * A model zoo is measured WORSE than repeated sampling from the best model when
   * the purpose is decorrelation. Decorrelation is {@link SwarmConfig.decorrelate}.
   *
   * Cost routing is understood 3/3 across vendors, so the field earns its place. The
   * warning holds 2/3 against a caller who demands a zoo for diversity, which is why
   * the composition `models.length > 1` with a resolved `decorrelate` of `'none'` is
   * REFUSED rather than merely discouraged — a docstring is advice, and advice loses
   * to an instruction from the caller.
   *
   * Because the refusal reads the RESOLVED `decorrelate`, a named preset whose own
   * `decorrelate` is not `'none'` accepts `models` freely. A preset that resolves to
   * `decorrelate:'none'` must instead PROHIBIT `models.length > 1` at its own
   * boundary — declared per preset, never discovered as a refusal, because §6.4
   * requires a named preset to be unrefusable.
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
  if (config.advance === 'archive') return 'archive';
  if (config.advance === 'pareto') return 'front';
  if (config.score.kind === 'none' && config.advance === 'none') return 'merge';
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
 * no `custom` row: `config` IS the override and `from` names the base, and a sixth
 * row would be the second spelling §6.4's reason 1 exists to prevent.
 *
 * TWO ROWS ARE UNDECLARED, and both are the same gap. §6.3 gives `research` and
 * `audit` `carry:'artifacts'`, but `carry` is a TAGGED value and its `artifacts`
 * arm requires an admission `threshold` the table never states. §6.5's τ=0.6 is
 * Rainbow Teaming's measurement offered as evidence that a rejection test is
 * needed, not a threshold this specification declares for a preset — so there is
 * nothing to put there, and this table says so instead of inventing it.
 */
export const SWARM_PRESET_POINTS = {
  ideate: {
    config: {
      unit: 'answer', observe: 'none', expand: 'sample', decorrelate: 'angles',
      score: { kind: 'none' }, advance: 'none', carry: { kind: 'none' },
    },
    // 1 BY CONSTRUCTION rather than by choice: `advance:'none'` means there is no
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
    config: {
      unit: 'answer', observe: 'own', expand: 'mutate', decorrelate: 'angles',
      score: { kind: 'novelty' }, advance: 'archive', carry: { kind: 'elites' },
    },
    depth: 3,
    branches: 4,
  },
  optimise: {
    config: {
      unit: 'answer', observe: 'ancestors', expand: 'mutate', decorrelate: 'angles',
      score: { kind: 'verify' }, advance: 'uct', carry: { kind: 'elites' },
    },
    // The deepest of the five because it is the only preset with a verifier — the
    // one value signal the literature says earns a tree — and still inside the 3-7
    // band every cited system runs rather than at the shipped default of 20.
    depth: 5,
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
 * stated over them — `pareto` reads the objective's kind, R7 reads `models` against
 * the resolved `decorrelate`, C1 reads the floor — and a predicate that cannot see
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
 * The seven axes a resolved configuration must name.
 *
 * `satisfies` holds every member to a real key of {@link SwarmConfig}, so a typo cannot
 * enter the list — but the compiler cannot force the converse, that a NEW required axis
 * joins it. What holds that direction is behavioural and lives in the fixture: the
 * refusal below names every axis a composition is missing, and a `custom` call with an
 * empty `config` therefore has to come back naming all seven. An axis added to the
 * interface and forgotten here makes that assertion fail rather than making the
 * resolver quietly accept an incomplete tuple.
 */
const AXES = [
  'unit', 'observe', 'expand', 'decorrelate', 'score', 'advance', 'carry',
] as const satisfies readonly (keyof SwarmConfig)[];

/** Whether a merged override names all seven axes. A type guard rather than a check
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
        + 'what differs, or name all seven axes. A named preset needs no `config` at all.');
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
    return badInput(`a resolved configuration names all seven axes and this one is missing ${missing.join(', ')}. `
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
  const { config, objective, caps, models } = resolved;
  const tree = isTreeAdvance(config.advance);

  if (tree && config.score.kind === 'none') {
    return badInput(`advance:"${config.advance}" selects on value and score:"none" supplies none, so this `
      + 'composition is a breadth-first enumerator whose winner is row order: at zero signal a 42-node '
      + 'tree agrees with the genuinely best node 0% of the time. Give it a signal — score:"verify" with '
      + 'an `objective`, or score:"novelty" with a `key` — or use advance:"none" and get honest parallel '
      + 'sampling.');
  }
  if (config.advance === 'archive' && config.score.kind === 'judge') {
    return badInput('an archive bins elites by a descriptor, and a judged descriptor is unrecoverable: a '
      + 'mis-ranked candidate can be re-ranked, a mis-binned elite is silently lost, and the grid fills '
      + 'while its cells hold low-quality behaviours. Bin on something a ToolCallRecord can witness — '
      + 'score:"novelty" — and keep the judge for a tree.');
  }
  if (config.advance === 'archive' && config.score.kind !== 'novelty') {
    return badInput(`an archive with score:"${config.score.kind}" has no novelty rejection test, and without `
      + 'one it collapses onto a single prompt across every cell while still reporting coverage — '
      + 'measured at self-BLEU 0.42 → 0.79 when the filter was dropped. Use score:"novelty", or '
      + 'advance:"uct" if what you want is to climb a value.');
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
  if (config.advance === 'pareto') {
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
      + '`objective` with a `metric`, a `unit`, a `direction` and a `target`, or use score:"novelty" with '
      + 'a coverage `key` — or score:"none" for a flat run with no value signal.');
  }
  if (config.advance === 'archive' && !resolved.key) {
    return badInput('an archive needs a descriptor to bin elites into, and it must name something a '
      + '`ToolCallRecord` can witness. Supply `key`. A key that can only say "distinct idea" is a task '
      + 'with no coverage objective — that task wants preset:"ideate".');
  }
  if (resolved.key && config.advance !== 'archive') {
    return badInput(`\`key\` is the descriptor an archive bins elites into, and advance:"${config.advance}" `
      + 'keeps no archive, so this run would accept a coverage key and report no coverage — which is a '
      + 'silent lie about what it did rather than a harmless extra. Drop `key`, or use '
      + 'advance:"archive" (preset:"research", "audit" or "redteam") if coverage is what you want.');
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
  if (models && models.length > 1 && config.decorrelate === 'none') {
    return badInput('set `decorrelate` — with decorrelate:"none" a model zoo is the run\'s only source of '
      + 'candidate diversity, and that arm is measured worse: 59.1 for the mixed panel against 65.7 for '
      + 'repeated sampling from the single best proposer, with the proposal count and topology held '
      + 'fixed. Keep the models for capability and cost routing, which is what they are good for, and '
      + 'get diversity from decorrelate:"angles".');
  }
  if (config.advance === 'none' && caps.depth && caps.depth.value > 1) {
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
    return badInput(`${named} is pruning policy for a tree selector, and advance:"${config.advance}" does not `
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
  /** 2-4 narrower sub-questions. */
  readonly branches: readonly { readonly task: string; readonly rationale: string }[];
  /**
   * Do children inherit this node's accumulated context?
   *
   * Per-branch `decorrelate`, and defensible precisely because the NODE knows
   * whether its context is worth inheriting while the engine does not. Validated
   * against the search's `decorrelate` rather than overriding it: a run configured
   * `fresh` refuses `inherit: true` and says so, instead of quietly honouring one
   * of two conflicting policies.
   */
  readonly inherit: boolean;
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

/**
 * The shape of a configured search: seven axes, five presets, one escape hatch.
 *
 * Specified by docs/EXPLORATION-SPEC.md sections 6-9. Declarations only — nothing
 * registers a `swarm` strategy, nothing adds a `swarm` action to
 * AGENTS_TOOL_ACTIONS (tools/registry.ts:161-163), and no validity predicate runs
 * yet. The axes are derived from a 27-technique coverage matrix rather than
 * chosen; the matrix, not this file, is the argument for why there are seven.
 *
 * WHAT A PRESET IS. A preset fixes the search. The caller supplies the objective.
 * Those are the two halves of a call and they never mix: `config` is axes only,
 * and a named preset does not accept it at all (section 6.4 records the decision
 * and its four reasons).
 */

import type { Objective } from './objective';

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
 */
export const SWARM_DECORRELATES = ['none', 'angles', 'fresh'] as const;
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
  readonly score: SwarmScore;
  readonly advance: SwarmAdvance;
  readonly carry: SwarmCarry;
  /**
   * Judge ensemble size, read by the validity predicate rather than by taste.
   *
   * A judged scalar driving a tree selector must be MARGINALISED or the tree
   * loses to plain re-ranking. Koh et al. 2407.01476 Table 4 holds the budget
   * fixed at c=20,d=5,b=5 and varies only the value function: no search 24.5% →
   * single-sample judge 28.5% → judge + SC(20) 37.0% → oracle 43.5%. So the knee
   * is SC(20), the refusal is about SAMPLE COUNT and not about judging, and our
   * live default of 3 (config.ts:100) is below it.
   */
  readonly judgeSamples: number;
  /**
   * Per-node model variation, for CAPABILITY AND COST ROUTING — a cheap model for
   * recon, a strong one for synthesis.
   *
   * NOT for diversity, and the docstring the model sees must say so. Self-MoA
   * (2502.00674) re-ran Mixture-of-Agents' own ablation over the same six models
   * and found the HOMOGENEOUS ensemble beat the mixed one 65.7 vs 59.1 at
   * identical compute, with quality dominating diversity by up to 3.2x in their
   * regression. A model zoo is measured WORSE than repeated sampling from the
   * best model when the purpose is decorrelation. Decorrelation is
   * {@link SwarmConfig.decorrelate}.
   *
   * NOTE `branches` and `depth` are deliberately NOT here. They are resource
   * caps, not axes — ToT at branches=3 and ToT at branches=8 are the same
   * TECHNIQUE, so width and depth do not span the coverage matrix. They live on
   * {@link SwarmInput} where every preset can set them, which is also the fix for
   * a measured hole: with them in `config`, a named preset (which takes no
   * `config`) had no way to say "eight candidates", and models reported exactly
   * that absence unprompted — "no direct field to set the initial population".
   */
  readonly models?: readonly string[];
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

/** The named presets, i.e. everything a `from` may point at. */
export type NamedSwarmPreset = Exclude<SwarmPreset, 'custom'>;

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
  /** REQUIRED with `custom`, prohibited otherwise. */
  readonly config?: SwarmConfig;
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
  if (config.score === 'none' && config.advance === 'none') return 'merge';
  return 'best';
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

/** Swarm-search contract at the platform layer: tools-layer schemas and the delegation surface
 *  share presets, axis settings and the call shape without importing the strategy engine. */

import type { Objective } from './objective';

/** What one node produces: `answer` is an agent tool loop; `thought` is one toolless model call.
 *  `generator`/`trajectory`/`step` are refused by name in `tools/swarm-input.ts`. */
export const SWARM_UNITS = ['answer', 'thought'] as const;

export type SwarmUnit = (typeof SWARM_UNITS)[number];

/**
 * What a child starts from, on the caller-to-root edge and every branch edge. `inherit` keeps
 * the parent's context verbatim (a shared cacheable prefix); `fresh` seeds only the parent's
 * reported results and the child's focus. May narrow down the tree, never widen.
 */
export const SWARM_CONTEXTS = ['inherit', 'fresh'] as const;

export type BranchContext = (typeof SWARM_CONTEXTS)[number];

/** How children are produced. `aggregate` is fan-in (k parents → one child), making a DAG. */
export const SWARM_EXPANDS = ['sample', 'aggregate'] as const;

export type SwarmExpand = (typeof SWARM_EXPANDS)[number];

/** How a node is valued. Novelty is an archive admission rule on {@link SwarmAdvanceSetting}. */
export const SWARM_SCORES = ['verify', 'judge', 'none'] as const;

export type SwarmScore = (typeof SWARM_SCORES)[number];

/** Where the next unit of budget goes. */
export const SWARM_ADVANCES = [
  'uct', 'best-first', 'pareto', 'archive', 'none',
] as const;

export type SwarmAdvance = (typeof SWARM_ADVANCES)[number];

/** What survives across iterations; `elites` and `artifacts` land in the records store. */
export const SWARM_CARRIES = ['none', 'reflections', 'elites', 'artifacts'] as const;

export type SwarmCarry = (typeof SWARM_CARRIES)[number];

/** How a run reports its answer. Derived from `score` and `advance`, never supplied. */
export type SwarmSettle = 'best' | 'archive' | 'front' | 'merge';

/** Tagged so a value's parameter cannot exist without the value that owns it. */
export type SwarmScoreSetting =
  | { readonly kind: 'verify' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'judge';
      /** Ensemble size. */
      readonly samples: number;
    };

/** Tagged so an archive without a rejection test is unrepresentable. A preset resolving to
 *  `archive` must declare its own τ; this file never invents one. */
export type SwarmAdvanceSetting =
  | { readonly kind: 'uct' }
  | { readonly kind: 'best-first' }
  | { readonly kind: 'pareto' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'archive';
      /** Novelty floor a candidate must clear to be admitted to its cell; without it an archive
       *  collapses onto one prompt while still reporting coverage. */
      readonly novelty: number;
    };

export type SwarmCarrySetting =
  | { readonly kind: 'none' }
  | { readonly kind: 'elites' }
  | { readonly kind: 'reflections'; readonly threshold: number }
  | { readonly kind: 'artifacts'; readonly threshold: number };

/** Untagged: inheritance belongs to {@link SWARM_CONTEXTS}, not to `unit`. */
export type SwarmUnitSetting =
  | { readonly kind: 'answer' }
  | { readonly kind: 'thought' };

/** The resolved configuration a run executes. Validity is checked on this, never on the preset
 *  name, so presets and `custom` share one definition of legal. */
export interface SwarmConfig {
  readonly unit: SwarmUnitSetting;
  /** Caller-to-root edge and the default every branch may narrow below. */
  readonly context: BranchContext;
  readonly expand: SwarmExpand;
  readonly score: SwarmScoreSetting;
  readonly advance: SwarmAdvanceSetting;
  readonly carry: SwarmCarrySetting;
  /** UCT exploration constant; applies only to `advance:'uct'`. */
  readonly explorationWeight?: number;
  /** Applies to tree selectors (`uct`, `best-first`); supplied under any other `advance` it is
   *  refused, not ignored. Same for `minVisitsForPrune`. */
  readonly pruneThreshold?: number;
  readonly minVisitsForPrune?: number;
  /** `branches`, `depth` and `models` are per-run choices, not technique identity, so they
   *  live on {@link SwarmInput} where every preset can set them. */
}

/** One first-level node's assignment. `prompt` is the brief, carried in the branch `rationale`. */
export interface SwarmNodeAssignment {
  readonly task: string;
  readonly prompt: string;
}

/** A refusal, returned as a value (never thrown); `error` says why and what to do instead. */
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

/** A call. `config` and `from` appear only with `preset:'custom'`, which keeps named presets
 *  unrefusable and `preset` a reliable provenance key. */
export interface SwarmInput {
  readonly preset: SwarmPreset;
  /** Prose: what the work is. Never where the measured quantity goes. */
  readonly task: string;
  /** Required for `optimise` and for `custom` compositions resolving to `score:'verify'`. */
  readonly objective?: Objective;
  /** Archive coverage key; required under `advance:'archive'`, refused otherwise. Must name a
   *  member of `MeasuredValue.measured` the objective's instrument reports. */
  readonly key?: string;
  /** Required with `custom`, prohibited otherwise. Without `from` it must name all seven axes. */
  readonly config?: Partial<SwarmConfig>;
  /** Starting point for `config`; the record still says `custom`. */
  readonly from?: NamedSwarmPreset;
  /** Required whenever `config` is present, so composed runs are distinguishable. */
  readonly label?: string;
  /** Short display handle. Not provenance: excluded from validity and the config digest. */
  readonly name?: string;
  /** Candidates per expansion; a resource cap on every preset. */
  readonly branches?: number;
  /** Requested search depth, overriding the selected preset. This bounds the
   * search tree, separately from subordinate lineage and a head's inherited
   * split budget. */
  readonly depth?: number;
  /** Explicit first-level assignments; `nodes.length` is the width, so combining with
   *  {@link branches} is refused. Every `task` must be distinct. */
  readonly nodes?: readonly SwarmNodeAssignment[];
  /**
   * Per-node model routing for capability and cost. Not for diversity. Child `i` of a wave runs
   * `models[i % models.length]`. Exclusive with `tier`; each spec resolves through
   * `AgentsSwarmDeps.resolveModel` and an unresolvable one is refused before any node runs.
   */
  readonly models?: readonly string[];
}

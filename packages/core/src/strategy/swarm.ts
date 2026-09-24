/**
 * Swarm search configuration: axes, presets, resolution, legality, and run reports.
 * Spec: docs/EXPLORATION.md "The six axes", "One spelling per axis", "Presets",
 * "Validity over the resolved configuration", "Settle is derived", "Arbitration".
 * {@link SWARM_PRESET_POINTS} is both fixture and resolver; a second spelling would drift.
 */

import { KinuError, refusalOf } from '../obs/error';
import { argumentDigest } from '../safety/argument-digest';
import { isJsonObject, type JsonValue } from '../utils/json';
import { PUBLISHING_CARRIES, VERIFIER_KIND_DOC, VERIFIER_KINDS, floorMargin } from './objective';
import { DEFAULT_CONFIG } from '../config';
import type {
  CarrySuppression, Floor, MeasuredValue, Objective, ObjectiveDirection, ParetoEvidence,
  PublicationState, VerifierKind, VerifierSpec,
} from '../types/objective';
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
} from '../types/swarm';

import {
  SWARM_ADVANCES,
  type BranchContext, type SwarmAdvance, type SwarmCarry, type SwarmConfig,
  type SwarmInput, type SwarmNodeAssignment, type SwarmRefusal,
  type SwarmSettle,
} from '../types/swarm';

export {
  SWARM_ADVANCES, SWARM_CARRIES, SWARM_CONTEXTS, SWARM_EXPANDS, SWARM_SCORES, SWARM_UNITS,
  type BranchContext, type SwarmAdvance, type SwarmAdvanceSetting, type SwarmCarry,
  type SwarmCarrySetting, type SwarmConfig, type SwarmExpand, type SwarmInput,
  type SwarmNodeAssignment, type SwarmRefusal, type SwarmScore, type SwarmScoreSetting,
  type SwarmSettle, type SwarmUnit, type SwarmUnitSetting,
} from '../types/swarm';

import type { SwarmProfileSnapshot } from '../profiles/snapshot';
import type { ExplorationRecordsReport } from './records';

/**
 * A parameter belonging to one axis value lives on that value. Region-spanning
 * parameters (`pruneThreshold`, `minVisitsForPrune`, `explorationWeight`) cannot be
 * tagged, so their applicability is checked (*Exhaustive over an axis*).
 */

/** Total over (`score`, `advance`), which is why `settle` is derived rather than an axis. */
export function settleOf(config: SwarmConfig): SwarmSettle {
  if (config.advance.kind === 'archive') return 'archive';

  if (config.advance.kind === 'pareto') return 'front';

  if (config.score.kind === 'none' && config.advance.kind === 'none') return 'merge';

  return 'best';
}

/** `depth` and `branches` are overridable cap defaults, not axes. */
export interface SwarmPresetPoint {
  readonly config: SwarmConfig;
  readonly depth: number;
  readonly branches: number;
  /**
   * The non-derivable clause of the doctrine, without the preset's name;
   * {@link SWARM_PRESET_DOCTRINE} derives the mechanical half from the axes.
   */
  readonly doctrine: string;
}

/** Every row is fully declared: *Presets* requires a named preset to be unrefusable. */
export type SwarmPresetRow = SwarmPresetPoint;

/**
 * `resolve(preset) → SwarmConfig` (*Presets*). No `custom` row: `config` is the override.
 * `novelty: 0.4` is Rainbow Teaming's τ=0.6 similarity ceiling converted to a distance floor.
 * `threshold: 0.8` is `craftExtractionThreshold`, the existing publication bar.
 */
export const SWARM_PRESET_POINTS = {
  ideate: {
    config: {
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'none' }, advance: { kind: 'none' }, carry: { kind: 'none' },
    },
    // Depth 1: `advance:'none'` has no selection step.
    depth: 1,
    branches: 5,
    doctrine: 'returns a set of distinct approaches, unranked. Reach for it when the thing you '
      + 'want is not measurable: it has no value signal by design and refuses an `objective`.',
  },
  /**
   * Coverage rows. `verify` because an archive cell is keyed and ranked by the objective;
   * without one they resolve to {@link unmeasuredPoint}. Depth 1: archives bin at settle.
   */
  research: {
    config: {
      unit: { kind: 'answer' }, context: 'fresh',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'archive', novelty: 0.4 },
      // `artifacts` publishes cross-workspace; the only axis separating this from `redteam`.
      carry: { kind: 'artifacts', threshold: 0.8 },
    },
    depth: 1,
    branches: 4,
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
      // `elites`, not `artifacts`: an exploit corpus must not leave its workspace.
      carry: { kind: 'elites' },
    },
    depth: 1,
    branches: 4,
    doctrine: 'is the same coverage shape over a TACTIC.',
  },
  optimise: {
    config: {
      unit: { kind: 'answer' }, context: 'inherit',
      expand: 'sample',
      score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'elites' },
    },
    depth: 5,
    branches: 3,
    doctrine: 'climbs one number you can measure — a cost, a runtime, a count.',
  },
  prove: {
    config: {
      unit: { kind: 'answer' }, context: 'inherit',
      expand: 'sample',
      // The checker is the score; the `objective` names it.
      score: { kind: 'verify' },
      // Best-first: an exact signal has no noise for UCT exploration to hedge.
      advance: { kind: 'best-first' },
      carry: { kind: 'artifacts', threshold: 1 },
    },
    // Deepest row: an exact checker refutes a wrong branch instead of carrying it down.
    depth: 7,
    branches: 3,
    doctrine: 'drives a checker that accepts a candidate or does not.',
  },
} as const satisfies Record<NamedSwarmPreset, SwarmPresetRow>;

/**
 * Read from `DEFAULT_CONFIG.mcts.judgeSamples`, not transcribed. The marginalisation floor
 * applies to tree selectors only; a flat sweep has no selection to amplify noise.
 */
export const UNMEASURED_JUDGE_SAMPLES = DEFAULT_CONFIG.mcts.judgeSamples;

/**
 * A named preset's point when the call named no `objective`: `score` becomes `judge`,
 * `advance` and `carry` become `none` (each reads a measurement), depth follows to 1.
 * Axes are named explicitly so tree-only parameters drop and a new axis is a compile error.
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

/** A `Record` over the axis so a new `advance` value must state its phrase. */
const ADVANCE_DOCTRINE = {
  none: (row) => `a flat measured wave of ${String(row.branches)}`,
  uct: (row) => `a depth-${String(row.depth)} UCT tree`,
  'best-first': (row) => `a depth-${String(row.depth)} best-first tree`,
  archive: () => 'a one-level coverage grid keyed by `key`, one elite per cell',
  pareto: () => 'a Pareto front over an `instanced` or `vector` objective',
} satisfies Record<SwarmAdvance, (row: SwarmPresetPoint) => string>;

const CARRY_DOCTRINE = {
  none: '',
  reflections: ', reflections seeding the next run',
  elites: ', its best kept in this workspace to seed the next run',
  artifacts: ', its best published for a later run to read',
} satisfies Record<SwarmCarry, string>;

/**
 * The one preset enumeration every model-facing surface renders; only
 * {@link SwarmPresetPoint.doctrine} is hand-written.
 */
export const SWARM_PRESET_DOCTRINE: readonly string[] = [
  'Every preset is callable as `preset` + `task` alone, and nothing else is required. '
    + 'With no `objective` a preset runs a JUDGED SWEEP at its own width: N candidates in '
    + 'parallel, ranked by a judge ensemble, none selected down a tree and none published. '
    + '"Sweep N" below is that width.',
  ...NAMED_SWARM_PRESETS.map((preset) => {
    const row = SWARM_PRESET_POINTS[preset];

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

/** Derived by exclusion so a new `advance` value cannot fall outside every tree rule. */
export const SWARM_TREE_ADVANCES = SWARM_ADVANCES.filter(
  (advance) => advance !== 'archive' && advance !== 'none',
);

export function isTreeAdvance(advance: SwarmAdvance): boolean {
  return SWARM_TREE_ADVANCES.some((tree) => tree === advance);
}

/**
 * Koh Table 4 at fixed node expansions: an unmarginalised strong judge (28.5%) is
 * beaten by a marginalised weaker one (30.0%), and SC(1)→SC(20) is worth +8.5.
 */
export const JUDGE_MARGINALISATION_MIN = 20;

/**
 * Derived from admitted `samples` so the ensemble that runs is the one admitted;
 * the extra call funds the check suite `judgeCallBudget` splits from the same pool.
 */
export function judgeCallPool(samples: number): number {
  return samples + 1;
}

export type SwarmCapOrigin = 'call' | 'preset';

export interface ResolvedCap {
  readonly value: number;
  readonly origin: SwarmCapOrigin;
}

/** `null` only via `custom` with no `from`: no default is invented. */
export interface ResolvedSwarmCaps {
  readonly branches: ResolvedCap | null;
  readonly depth: ResolvedCap | null;
}

/** Carries the objective's arguments because validity refusals are stated over them. */
export interface ResolvedSwarm {
  readonly preset: SwarmPreset;
  /** Provenance only; the record still says `custom`. */
  readonly from: NamedSwarmPreset | null;
  readonly label: string | null;
  readonly name: string | null;
  readonly config: SwarmConfig;
  readonly settle: SwarmSettle;
  readonly caps: ResolvedSwarmCaps;
  readonly task: string;
  readonly objective: Objective | null;
  readonly key: string | null;
  /** Null in count-based mode. When present, `caps.branches` is `nodes.length`. */
  readonly nodes: readonly SwarmNodeAssignment[] | null;
  /** Round-robin by slot ({@link SwarmInput.models}); digested into `configDigest`. */
  readonly models: readonly string[] | null;
}

function badInput(error: string): SwarmRefusal {
  return { reason: 'bad_input', error: refusalOf(new KinuError('bad_input', error)).error };
}

/**
 * The compiler cannot force a new axis into this list; the fixture does, since a
 * `custom` call with empty `config` must be refused naming every axis.
 */
const AXES = [
  'unit', 'context', 'expand', 'score', 'advance', 'carry',
] as const satisfies readonly (keyof SwarmConfig)[];

function namesEveryAxis(merged: Partial<SwarmConfig>): merged is SwarmConfig {
  return AXES.every((axis) => merged[axis] !== undefined);
}

function resolveCap(
  supplied: number | undefined, row: number | undefined,
): ResolvedCap | null {
  if (supplied !== undefined) return { value: supplied, origin: 'call' };

  if (row !== undefined) return { value: row, origin: 'preset' };

  return null;
}

/**
 * Call-level rules (*Accepted and ignored*, *Presets*) that run before resolution exists;
 * rules over resolved values live in {@link swarmValidity}.
 */
function requiredFieldRefusal(input: SwarmInput): SwarmRefusal | null {
  const composed = input.preset === 'custom';

  // The two width modes are exclusive: `nodes.length` is the width.
  if (input.nodes && input.branches !== undefined) {
    return badInput('`nodes` assigns the first level node by node, so its length is the branch count — '
      + `you named ${String(input.nodes.length)} node(s) and \`branches: ${String(input.branches)}\` as `
      + 'well, and one of the two would be ignored. Drop `branches` to keep your own assignments, or '
      + 'drop `nodes` to let the engine hand out that many diversity angles.');
  }

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

  // An empty or blank model spec would silently route to a default (*Accepted and ignored*).
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
    // `key` and `objective` rules are over the resolved config: see {@link swarmValidity}.
  }

  return null;
}

/** Total over `SwarmPreset`: every row is a point, so a named preset always resolves. */
export function resolveSwarm(input: SwarmInput): ResolvedSwarm | SwarmRefusal {
  const required = requiredFieldRefusal(input);

  if (required) return required;

  const baseName: NamedSwarmPreset | null = input.preset === 'custom'
    ? input.from ?? null
    : input.preset;

  const row: SwarmPresetPoint | null = baseName ? SWARM_PRESET_POINTS[baseName] : null;

  // A named preset without `objective` resolves to {@link unmeasuredPoint}. `custom` is
  // excluded: its caller stated `score` explicitly.
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
  // A blank name is no name.
  const name = input.name?.trim() ?? '';

  return {
    preset: input.preset,
    from: input.preset === 'custom' ? input.from ?? null : null,
    label: input.label?.trim() ?? null,
    name: name === '' ? null : name,
    config,
    settle: settleOf(config),
    caps: {
      // `nodes.length` is a `call` cap, like `branches`.
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
 * {@link ExplorationRecord}'s `configDigest`. Every tagged parameter is spelled per arm;
 * unset optional parameters digest as `null` (absent differs from zero). Caps by value, not origin.
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
    // `null` for unrouted: an absent list differs from one naming the run's own model.
    models: resolved.models === null ? null : [...resolved.models],
  });
}

/** One floor per `vector` component and a `witness` proxy's, so C1 is not over a single field. */
function floorsOf(objective: Objective): readonly { floor: Floor; direction: ObjectiveDirection }[] {
  if (objective.kind === 'vector') return objective.components.flatMap(floorsOf);

  if (objective.kind === 'witness') return objective.proxy ? floorsOf(objective.proxy) : [];

  return objective.floor ? [{ floor: objective.floor, direction: objective.direction }] : [];
}

/** Closures are skipped: they cannot fail to resolve. */
function verifierSpecsOf(objective: Objective): readonly VerifierSpec[] {
  if (objective.kind === 'vector') return objective.components.flatMap(verifierSpecsOf);

  const named = objective.kind === 'witness'
    ? [objective.check, ...(objective.proxy ? [objective.proxy.verify] : [])]
    : [objective.verify];

  return named.filter((source): source is VerifierSpec => 'kind' in source);
}

/** Presence only; `verifier-registry.ts` owns types, ranges and cross-field rules. */
function missingSpecFields(kind: VerifierKind, spec: JsonValue): readonly string[] {
  const fields = VERIFIER_KIND_DOC[kind].specFields;

  if (!isJsonObject(spec)) return fields;

  return fields.filter((field) => !Object.hasOwn(spec, field));
}

/** Appended to verifier refusals so the caller learns the working call in one round trip. */
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

/** Shared by {@link swarmValidity} and `runSwarm` so an in-process caller cannot bypass it. */
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

/** Shared by both entry points for the same reason as {@link judgeMarginalisationRefusal}. */
export function archiveRegionRefusal(
  config: SwarmConfig, caps: ResolvedSwarmCaps,
): SwarmRefusal | null {
  if (config.advance.kind !== 'archive') return null;

  if (config.score.kind !== 'verify') {
    return badInput(`an archive keys every cell by the objective's identity and orders each cell by the `
      + `objective's own direction, and score:"${config.score.kind}" measures neither — so nothing this `
      + 'run produced could be binned or ranked, and the coverage it reported would be over a store it '
      + 'never wrote. Use score:"verify" with an `objective`, or advance:"none" for a flat run.');
  }

  const { novelty } = config.advance;

  if (!(novelty >= 0 && novelty <= 1)) {
    // A distance floor; published filters are similarity ceilings (convert as 1 − x).
    return badInput(`\`novelty\` is the DISTANCE a candidate must put between itself and every occupant of `
      + `its cell, in [0,1] where 0 admits everything and 1 admits only an answer sharing no vocabulary `
      + `at all — and this composition states ${String(novelty)}, which no distance can satisfy or fail. `
      + 'Note the direction before transcribing one: a filter quoted as a similarity ceiling is one MINUS '
      + 'that number here. State a threshold inside [0,1].');
  }

  if (caps.depth && caps.depth.value > 1) {
    return badInput(`advance:"archive" bins its candidates into cells at the settle barrier, so during the `
      + `run there is no archive to select a second level FROM and depth ${String(caps.depth.value)} `
      + 'cannot be run — it is refused rather than silently flattened, because a cap accepted and ignored '
      + 'is a lie about what the run did. Pass depth:1 and carry:"elites", which is what makes the next '
      + "run start from this one's occupants.");
  }

  return null;
}

/**
 * *Validity over the resolved configuration*: returns the first refusal in table order.
 * One imperative per refusal (*Refusals*); stated over the resolution, never the preset name.
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

  if (advance === 'pareto' && PUBLISHING_CARRIES.some((carry) => carry === config.carry.kind)) {
    return badInput('advance:"pareto" keeps its durable frontier in node evidence and cannot '
      + 'publish a vector through the scalar records store. Use carry:"none" or "reflections".');
  }

  if (config.score.kind === 'verify' && !objective) {
    // Only `custom` reaches this: named presets without `objective` resolve to a judged sweep.
    return badInput('score:"verify" measures something and this composition did not say what. Supply '
      + '`objective` with a `metric`, a `unit`, a `direction`, a `target`, and `verify` as '
      + `{kind, spec} naming one of the registered instruments: ${VERIFIER_KINDS.join(', ')}. `
      + 'Or set score:{kind:"none"} in `config` for a flat run with no value signal — and note '
      + 'that a NAMED preset needs neither: it falls back to a judged sweep on its own.');
  }

  // The verifier kind is checked at call time. Each refusal ends with a complete working call.
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
    // The key names a quantity the objective's instrument reports.
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
 * A node proposes and `advance` arbitrates; it never spawns. A branch inside this search
 * (same budget and objective), unlike a nested `swarm`.
 */
export interface BranchProposal {
  readonly rationale: string;
  /** Per-branch `context` may narrow the search's own `context`, never widen it. */
  readonly branches: readonly {
    readonly task: string;
    readonly rationale: string;
    readonly context: BranchContext;
  }[];
}

/**
 * Enforced by the arbiter, not the type, so a bad width gets a reason-coded refusal
 * (`Arbitration.lean:65-69`). Applies to proposals only, never the search's own `branches`.
 */
export const BRANCH_PROPOSAL_WIDTH = { min: 2, max: 4 } as const;

/**
 * Exactly `Arbitration.lean`'s `Refusal` constructors, in order. Logged as tokens so
 * `every_refusal_is_reachable` stays checkable on the shipped engine.
 */
export const BRANCH_REFUSAL_POLICIES = [
  'does-not-expand-at-node', 'width-out-of-range', 'depth-exhausted',
  'budget-exhausted', 'context-conflict',
] as const;

export type BranchRefusalPolicy = (typeof BRANCH_REFUSAL_POLICIES)[number];

/** Pure decision without ids; {@link BranchVerdict} carries the minted ids. */
export type BranchArbitration =
  | { readonly kind: 'accepted'; readonly width: number }
  | {
    readonly kind: 'refused';
    readonly policy: BranchRefusalPolicy;
    readonly error: string;
  };

export interface BranchArbitrationInput {
  readonly config: SwarmConfig;
  readonly caps: ResolvedSwarmCaps;
  /** Read from the engine's row; a node never states its own depth. */
  readonly atDepth: number;
  readonly remainingChildren: number;
  readonly proposal: BranchProposal;
}

/**
 * Total, pure port of `lean/Kinu/Exploration/Arbitration.lean`'s `arbitrate`, order included.
 * Arms discharge, in order: `archive_refuses_at_node`, `accepted_width_in_range`,
 * `accepted_children_within_depth` (S3), `accepted_within_budget` (S8), `accepted_respects_context`.
 * Absent caps are refused, not defaulted.
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

  const widening = proposal.branches.filter((branch) => branch.context === 'inherit');

  if (config.context === 'fresh' && widening.length > 0) {
    return refused('context-conflict',
      `this search is resolved context:"fresh", which starts every child from its parent's REPORTED `
      + `results rather than its conversation, and ${String(widening.length)} of these `
      + `${String(width)} branches ask for context:"inherit". A node may narrow the search's inheritance `
      + 'and never widen it, so this is refused rather than one of two conflicting policies being '
      + 'honoured quietly. Propose the same branches with context:"fresh" — they still receive your '
      + 'report, your candidate and their own focus, which is everything except your transcript.');
  }

  return { kind: 'accepted', width };
}

/** Refusals name the policy and state; never dropped silently. */
export type BranchVerdict =
  | { readonly kind: 'accepted'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: 'denied'; readonly error: string };

/**
 * *The publication seal* governs the store, not the settle report; this marker says
 * whether the answer is publishable. Interpret the state only via `admitsPublication`.
 */
export interface SwarmPublicationMarker {
  readonly state: PublicationState;
  /** Null when publishable. */
  readonly caveat: string | null;
}

/** `value` is raw in the objective's unit; `score` is normalised. Absent, not zero, when unusable. */
export interface SwarmCandidate {
  readonly id: string;
  readonly artifact: string;
  readonly measured: MeasuredValue | null;
  /** Null outside a Pareto run or without comparable evidence. */
  readonly pareto: ParetoEvidence | null;
  readonly unmeasurable: string | null;
  /**
   * Why the node never finished (status, steps, clock); distinct from
   * {@link unmeasurable} so a cut node is not reported as a verifier complaint.
   */
  readonly incomplete: string | null;
  readonly score: number | null;
  /** Null without a witness predicate or measurement. */
  readonly witnessFound: boolean | null;
}

/** Realised ensemble is `min(samples, maxEvalLLMCalls − 1)` on code-bearing branches. */
export interface JudgeEnsembleReport {
  readonly requested: number;
  /** Smallest ensemble any candidate actually sampled; null when none reached the ensemble. */
  readonly realised: number | null;
}

/** Null on an `expand:'sample'` run, meaning no fan-in (not an empty one). */
export interface SwarmFanInReport {
  /** Levels with fewer than two consumable parents do not count. */
  readonly levels: number;
  /** In attempt order, so dependency order is checkable. */
  readonly order: readonly string[];
  readonly merged: number;
  /** One per disagreement between two parents (*Merge-back*). */
  readonly vertices: readonly string[];
  readonly unusableParents: number;
  /** Pruning steers budget only; a retired parent's edge still reaches the origin. */
  readonly prunedParents: number;
  // No "dependents refused" count: order holds a dependent behind its dependency.
}

/** Null on a first attempt. Disclosed so a resumed run does not read like a fresh one. */
export interface SwarmResumeReport {
  /** The first attempt's root id: one request, one tree. */
  readonly rootId: string;
  /** `expansions - inheritedExpansions` is what this activation bought. */
  readonly inheritedExpansions: number;
  readonly remainingBudget: number;
  /** Excluded from `tokens`, which is only what this activation was charged. */
  readonly inheritedTokens: number | null;
  /** Re-run under their own ids; counted in `inheritedExpansions`, so free. */
  readonly resumedNodes: number;
  readonly superseded: readonly string[];
  /** From the lease `reclaim` bumps; includes this attempt. */
  readonly attempt: number;
}

/** "Did not find" is never "does not exist": no field carries an existence claim. */
export interface SwarmSettleReport {
  readonly settle: SwarmSettle;
  /** *Floor margin* C3: surfaced, never thresholded. Null when no floor was declared. */
  readonly floorMargin: number | null;
  /** *Measured baseline*: measured before any candidate, never caller-supplied. */
  readonly baseline: number | null;
  /** `false` means not found under this budget, not that none exists. */
  readonly witnessFound: boolean | null;
  /** *The publication seal* carry disclosure; null means not suppressed. */
  readonly carrySuppressed: CarrySuppression | null;
  /** Null when the run had no objective identity to key a record by. */
  readonly records: ExplorationRecordsReport | null;
  /** Null unless judged. */
  readonly judgeEnsemble: JudgeEnsembleReport | null;
  readonly stop: 'settled' | 'budget' | 'aborted';
  /** Absent, not zero, when unreported: unmeasured is not free. */
  readonly expansions: number;
  readonly tokens: number | null;
  readonly durationMs: number;
  readonly fanIn: SwarmFanInReport | null;
  readonly resumed: SwarmResumeReport | null;
}

/** A run that did not start returns a refusal instead. */
export interface SwarmResult {
  readonly preset: SwarmPreset;
  readonly label: string | null;
  readonly config: SwarmConfig;
  readonly caps: ResolvedSwarmCaps;
  readonly report: SwarmSettleReport;
  readonly publication: SwarmPublicationMarker;
  /** Null when every candidate was unmeasurable. */
  readonly best: SwarmCandidate | null;
  readonly candidates: readonly SwarmCandidate[];
  /** Null outside `advance:"pareto"`. */
  readonly frontier: readonly SwarmCandidate[] | null;
  readonly profile?: SwarmProfileSnapshot;
}

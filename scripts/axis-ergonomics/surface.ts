/**
 * The `agents.swarm` surface UNDER TEST — the exact bytes a model would see.
 *
 * This is not the implementation. `swarm` does not exist yet; the design is
 * `local://mcts-as-lats-design.md` and the spec is mid-authoring by
 * `ObjectiveSpec`. What a caller model actually receives from a Kinu tool is
 * `renderToolSchemaDescription(spec)` plus a JSON schema (registry.ts:651-658),
 * so that pair IS the surface, and it is testable before a single line of
 * engine work exists. Rendering it here, from one source, is what makes the
 * ergonomics measurement reproducible against a spec that is still moving:
 * change these constants, re-run, get a new number.
 *
 * TWO VARIANTS ship, and the difference between them is the measurement.
 *
 *   `bare`    — axis names, value enums, and the one-line "question it answers"
 *               that the design's own matrix gives each axis. Nothing explains
 *               an individual VALUE. This is the honest test of the owner's
 *               criterion: a name should teach a model what the thing does.
 *   `glossed` — identical, plus one clause per value.
 *
 * Testing only `glossed` would measure my glosses. Testing only `bare` would
 * strawman a surface no one would ship. The A/B delta is how much work the
 * names are doing on their own, which is the only form of this question that
 * has an actionable answer.
 *
 * Axis names, value enums, preset table, and refusal rules are transcribed from
 * the design doc's sections 2 and 3 and are NOT edited here — this ticket
 * measures the surface, it does not change it.
 */

export const AXIS_NAMES = [
  'unit', 'observe', 'expand', 'decorrelate', 'score', 'advance', 'carry',
] as const;
export type AxisName = (typeof AXIS_NAMES)[number];

/** The 28 values, per axis, verbatim from the design's matrix table. */
export const AXIS_VALUES = {
  unit: ['step', 'answer', 'trajectory', 'generator'],
  observe: ['none', 'own', 'ancestors'],
  expand: ['sample', 'mutate', 'aggregate'],
  decorrelate: ['none', 'angles', 'fresh'],
  score: ['verify', 'agree', 'novelty', 'judge', 'none'],
  advance: ['uct', 'beam', 'best-first', 'pareto', 'archive', 'none'],
  carry: ['none', 'reflections', 'elites', 'artifacts'],
} satisfies Record<AxisName, readonly string[]>;

/** The design's "question it answers" column. One line, per AXIS, never per value. */
export const AXIS_QUESTION = {
  unit: 'what one node is',
  observe: 'what environment feedback enters the expansion prompt',
  expand: 'how children are produced',
  decorrelate: 'how hard children are pushed apart',
  score: 'how a node is valued',
  advance: 'where the next unit of budget goes',
  carry: 'what survives across iterations',
} satisfies Record<AxisName, string>;

/**
 * One clause per value, for the `glossed` variant only.
 *
 * Written to describe the MECHANISM and to avoid restating the value's own
 * word, because a gloss that says "`angles` means different angles" would
 * inflate the glossed arm without teaching anything and would corrupt the very
 * delta this file exists to measure.
 */
export const VALUE_GLOSS = {
  unit: {
    step: 'one reasoning step; a solution is a path of many nodes',
    answer: 'one complete candidate answer per node',
    trajectory: 'one whole agent run, tools and all, per node',
    generator: 'the node is a program or prompt that produces answers, and that artifact is what improves',
  },
  observe: {
    none: 'the expansion prompt sees no execution result',
    own: "the node's own execution result is fed back before it is expanded",
    ancestors: "every ancestor's execution result is carried into the prompt",
  },
  expand: {
    sample: 'draw independent children from the same prompt',
    mutate: 'edit an existing candidate into a new one',
    aggregate: 'fan-in — several parents are consumed by one child, which makes the shape a graph rather than a tree',
  },
  decorrelate: {
    none: 'nothing is done to stop children being near-copies',
    angles: 'each child is handed a different prescribed approach',
    fresh: 'children are generated without sight of their siblings',
  },
  score: {
    verify: "a caller-supplied check runs the candidate and returns a number; the reward IS the outcome",
    agree: 'the value is how far the candidates agree with each other',
    novelty: 'the value is how unlike everything already found the candidate is',
    judge: 'a model reads the candidate and rates it',
    none: 'nodes carry no value',
  },
  advance: {
    uct: 'tree search: spend on the child with the best value-plus-uncertainty',
    beam: 'keep the top k at each depth and drop the rest',
    'best-first': 'always spend on the highest-scoring candidate anywhere',
    pareto: 'keep the non-dominated frontier across several objectives at once',
    archive: 'keep one best occupant per cell of a descriptor grid, and spend on cells',
    none: 'no selection; every candidate gets the same budget once',
  },
  carry: {
    none: 'each iteration starts from nothing',
    reflections: "written lessons from what failed carry into the next attempt",
    elites: 'the best candidates persist and seed later iterations',
    artifacts: 'produced artifacts persist and are reusable later',
  },
} satisfies Record<AxisName, Record<string, string>>;

/** The five presets and `custom`, from the design's section 3 table. */
export const PRESET_NAMES = ['ideate', 'research', 'audit', 'redteam', 'optimise'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

interface PresetDoc {
  readonly intent: string;
  /** flat / archive / verifier-and-tree — the design's own word for each. */
  readonly topology: string;
  readonly needs: string;
  readonly returns: string;
}

export const PRESETS = {
  ideate: {
    intent: 'ideas, framing, thinking a problem through',
    topology: 'flat — no tree',
    needs: 'nothing',
    returns: 'a set',
  },
  research: {
    intent: 'open-ended research, recon, information gathering',
    topology: 'archive over a coverage key',
    needs: 'a coverage key',
    returns: 'coverage plus open questions',
  },
  audit: {
    intent: 'code quality and security findings',
    topology: 'archive over a finding-class key',
    needs: 'a finding-class key',
    returns: 'an archive of distinct findings',
  },
  redteam: {
    intent: 'adversarial and cyber',
    topology: 'archive over a tactic key',
    needs: 'a tactic key (e.g. ATT&CK)',
    returns: 'an archive; ten variants of one exploit is one finding',
  },
  optimise: {
    intent: 'make a quantifiable cost better',
    topology: 'verifier and a tree',
    needs: 'verify — REQUIRED',
    returns: 'one winner, plus the harvest',
  },
} as const satisfies Record<PresetName, PresetDoc>;

/**
 * `zoo` is `glossed` plus one extra field, and it exists to answer a single
 * question `ObjectiveSpec` asked: does a docstring sentence actually stop a
 * model reaching for a model zoo when the task asks for diversity?
 *
 * The BEFORE run (bare + glossed) offers no `models` field at all, so it can
 * only show that the craving is not spontaneous — it cannot show that the
 * sentence works, because nothing was there to reach for. This variant puts
 * the field in front of the model WITH the discouraging description it will
 * ship with. If a model asked for "genuinely different attack routes" still
 * populates it, the sentence is decoration and the spec needs a refusal.
 */
export type SurfaceVariant = 'bare' | 'glossed' | 'zoo';

/** Verbatim from `ObjectiveSpec`, because a paraphrase would test my wording. */
export const MODELS_FIELD_DESCRIPTION =
  'Per-node model variation, for CAPABILITY AND COST ROUTING — a cheap model for recon, a '
  + 'strong one for synthesis. NOT for diversity: Self-MoA (2502.00674) re-ran '
  + "Mixture-of-Agents' own ablation over the same six models and found the HOMOGENEOUS "
  + 'ensemble beat the mixed one 65.7 vs 59.1 with the proposer count and topology held fixed '
  + '(six proposals, one aggregator; the paper claims no cost parity). A model zoo is measured '
  + 'WORSE than repeated sampling from the best model when the purpose is decorrelation. '
  + 'Decorrelation is the `decorrelate` axis.';

/** One value's mechanism clause. Total over (axis, value) so a value added to
 *  AXIS_VALUES without a gloss renders as blank rather than crashing a run —
 *  and shows up in the report as a hole rather than as a model failure. */
export function valueGloss(axis: AxisName, value: string): string {
  const perAxis: Record<string, string> = VALUE_GLOSS[axis];
  return perAxis[value] ?? '';
}

function presetLines(): string {
  return PRESET_NAMES.map((p) => {
    const d = PRESETS[p];
    return `  ${p} — ${d.intent}. Shape: ${d.topology}. Needs from you: ${d.needs}. Returns: ${d.returns}.`;
  }).join('\n');
}

function axisLines(variant: SurfaceVariant): string {
  return AXIS_NAMES.map((axis) => {
    const values = AXIS_VALUES[axis];
    const head = `  ${axis}: ${values.join(' | ')} — ${AXIS_QUESTION[axis]}`;
    if (variant === 'bare') return head;
    const glosses = values
      .map((v) => `      ${v}: ${valueGloss(axis, v)}`)
      .join('\n');
    return `${head}\n${glosses}`;
  }).join('\n');
}

/**
 * The rendered tool docstring, in the exact five-part shape
 * `renderToolSchemaDescription` produces: summary, Use when, Avoid when,
 * doctrine, Returns.
 */
export function renderSwarmDescription(variant: SurfaceVariant): string {
  const summary =
    'Run a configured search over many candidate attempts — a tree or a graph of them — '
    + 'expanded, scored and pruned by the harness rather than by you.';

  const whenToUse =
    'Use when a task has many plausible attempts and reading cannot tell you which is best. '
    + '`preset` is required and picks the shape:\n'
    + `${presetLines()}\n`
    + '  custom — none of the five fits. Unlocks the seven axes below and validates the combination.\n'
    + 'The five presets take no axes; they are the tested paths. '
    + 'The axes, when preset=custom:\n'
    + `${axisLines(variant)}\n`
    + 'A `label` names a composed search in the run record.'
    + (variant === 'zoo' ? `\n  models: string[] — ${MODELS_FIELD_DESCRIPTION}` : '');

  const whenNotToUse =
    'A single short coherent change is yours to make directly. A question that one file '
    + 'answers is a read, not a search. optimise is refused without `verify`, and `verify` '
    + 'must return a NUMBER rather than pass/fail — a binary signal makes the search a list.';

  const doctrine =
    'Three tiers, and the surface tells you which one you are in: a preset is a tested path; '
    + 'custom is legal but untested; some combinations are refused as provably degenerate and '
    + 'the refusal says why.';

  const result =
    'Returns the winner or the archive for the preset you chose, the run record, and what was '
    + 'carried. A refusal returns { reason, error } and the error text names what to change.';

  return [summary, `Use when: ${whenToUse}`, `Avoid when: ${whenNotToUse}`, doctrine, `Returns: ${result}`].join('\n');
}

/** One property of the tool's JSON schema, as a provider would receive it. */
interface SchemaProperty {
  readonly type: 'string';
  readonly description?: string;
  readonly enum?: readonly string[];
}

export interface SwarmSchema {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, SchemaProperty>>;
}

/** The JSON schema half of the surface — enums are the whole point, so they ship. */
export function swarmSchema(): SwarmSchema {
  const axisProps: Record<string, SchemaProperty> = {};
  for (const axis of AXIS_NAMES) {
    axisProps[axis] = { type: 'string', enum: [...AXIS_VALUES[axis]], description: AXIS_QUESTION[axis] };
  }
  return {
    type: 'object',
    required: ['task', 'preset'],
    properties: {
      task: { type: 'string', description: 'what the search is for, in prose' },
      preset: { type: 'string', enum: [...PRESET_NAMES, 'custom'] },
      verify: { type: 'string', description: 'a command that scores a candidate and prints a number. Required by optimise.' },
      key: { type: 'string', description: 'the coverage / finding-class / tactic key an archive preset bins on' },
      label: { type: 'string', description: 'names a composed search in the run record' },
      ...axisProps,
    },
  };
}

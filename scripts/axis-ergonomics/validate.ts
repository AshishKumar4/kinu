/**
 * The validity table of the design's section 3, as a pure function.
 *
 * This is the mechanical half of the grade. Whether a model picked the preset
 * an expert would pick is a judgement; whether the configuration it emitted is
 * LEGAL is not, and anything that can be decided by a total function must be,
 * because a judge asked to rule on legality would introduce variance into the
 * one part of the measurement that has none.
 *
 * Only the rules the schema can actually see are implemented, and the ones it
 * cannot are named rather than guessed at:
 *
 *   R1 tree selector + score:'none'        implemented — both are axis values.
 *   R2 archive + no novelty rejection      implemented as advance:'archive'
 *                                          without score:'novelty', which is the
 *                                          only axis value that expresses a
 *                                          rejection test.
 *   R3 archive + JUDGED descriptor         NOT mechanical. The descriptor is the
 *                                          `key` string, and whether a model
 *                                          computes it is a fact about the key's
 *                                          prose. Graded semantically, flagged
 *                                          here as `unverifiable`.
 *   R4 score:'judge' + tree, samples < 20  NOT mechanical. `judgeSamples` is not
 *                                          on the surface at all — which is
 *                                          itself a finding, since the design's
 *                                          own default is 3, below Koh's knee
 *                                          (SC(1) 28.5 / SC(5) 32.5 / SC(20) 37.0).
 *   R5 optimise without verify             implemented — static, pre-spend.
 *   R6 a non-custom preset carrying axes   implemented. The design states the
 *                                          five presets take no axes; setting
 *                                          one is a caller who thinks the
 *                                          presets are defaults to override.
 *
 * Vocabulary errors are separated from rule violations deliberately. An unknown
 * VALUE means the model knew which axis it wanted and reached for a word we do
 * not have, which is evidence about that axis's naming. An unknown AXIS means it
 * wanted a control the design does not offer. Collapsing the two into
 * "malformed" would throw away the strongest naming signal in the study.
 */
import { AXIS_NAMES, AXIS_VALUES, PRESET_NAMES, type AxisName } from './surface';

/** Selectors that pick by a scalar value, so score:'none' empties them. */
const TREE_SELECTORS = ['uct', 'beam', 'best-first', 'pareto'] as const;

export interface ProposedConfig {
  readonly preset?: string;
  readonly verify?: string;
  readonly key?: string;
  readonly axes?: Readonly<Record<string, string>>;
  /** Only present on the `zoo` surface variant. */
  readonly models?: readonly string[];
}

export type Violation =
  | { readonly kind: 'unknown-preset'; readonly got: string }
  | { readonly kind: 'unknown-axis'; readonly got: string; readonly value: string }
  | { readonly kind: 'unknown-value'; readonly axis: AxisName; readonly got: string }
  | { readonly kind: 'rule'; readonly rule: 'R1' | 'R2' | 'R5' | 'R6' | 'R7'; readonly error: string };

export interface Validation {
  readonly legal: boolean;
  readonly violations: readonly Violation[];
  /** Rules that apply in principle but this surface cannot decide. */
  readonly unverifiable: readonly string[];
}

/**
 * The refusal text a caller would actually receive. Kept HERE, next to the rule
 * that produces it, because phase 2 of the study feeds this exact string back to
 * the model and asks it to try again — and a refusal is only worth its
 * `{reason, error}` shape if the error text is what does the correcting. If the
 * text lived somewhere else it would drift from the rule and the correction
 * measurement would be measuring a fiction.
 */
export function refusalText(v: Violation): string {
  switch (v.kind) {
    case 'unknown-preset':
      return `preset '${v.got}' does not exist. The presets are ${PRESET_NAMES.join(', ')}, or 'custom' to set the axes yourself.`;
    case 'unknown-axis':
      return `there is no '${v.got}' axis. The axes are ${AXIS_NAMES.join(', ')}.`;
    case 'unknown-value':
      return `'${v.got}' is not a value of ${v.axis}. Its values are ${AXIS_VALUES[v.axis].join(', ')}.`;
    case 'rule':
      return v.error;
  }
}

/**
 * R7's remedy order, as a switch, because it is the variable under test.
 *
 * The first run used `drop-offered`: one sentence naming two remedies, with
 * "keep the models" second. Both models it fired on produced a LEGAL attempt
 * two and only one of them achieved the rule's purpose — sonnet kept both
 * models and added `decorrelate:'angles'`; deepseek amputated from three models
 * to one and lost the cost routing the field exists for. A refusal whose whole
 * justification is that it makes the run strictly better cannot be satisfied by
 * throwing the run's intent away.
 *
 * `keep-first` is the fix `ObjectiveSpec` took as a normative rule: lead with
 * the remedy that preserves the caller's intent, and omit any remedy that is
 * always available anyway — dropping a field never needs suggesting.
 *
 * Kept as an A/B rather than replaced outright so the claim can be tested
 * instead of asserted. One observation is not a mechanism.
 */
export type RemedyOrder = 'drop-offered' | 'keep-first';

const SELF_MOA_EVIDENCE =
  'That is the arm Self-MoA (2502.00674) re-ran over Mixture-of-Agents\' own six models and '
  + 'measured WORSE than repeated sampling from the single best one — 59.1 against 65.7 with '
  + 'the proposer count and topology held fixed (six proposals, one aggregator; the paper '
  + 'claims no cost parity).';

function r7Error(count: number, order: RemedyOrder): string {
  const finding =
    `you named ${String(count)} models and set no decorrelation, so model variety is this `
    + `run's only source of candidate diversity. ${SELF_MOA_EVIDENCE}`;
  return order === 'keep-first'
    ? `${finding} Keep the models — they are for capability and cost routing, which is what `
      + "the field is for — and set decorrelate:'angles' or 'fresh' so the diversity comes "
      + 'from the axis that is measured to provide it.'
    : `${finding} Set decorrelate:'angles' or 'fresh' and keep the models if you want them `
      + 'for capability or cost routing, which is what the field is for.';
}

// R7 — landed in the spec at f30e48a0 as a direct result of this study's zoo
// arm, and this implementation exists to test the thing the arm could not:
// does a REFUSAL hold where a docstring sentence did not? Stated over the
// resolved composition rather than over intent, which no predicate reads:
// several models with no decorrelation axis set means model variety is the
// run's ONLY source of candidate diversity, which is true whatever the caller
// wanted, and is precisely the arm Self-MoA measured worse.
function checkR7(
  config: ProposedConfig,
  decorrelate: string | undefined,
  order: RemedyOrder,
): Violation | null {
  const models = config.models ?? [];
  if (models.length <= 1) return null;
  if (decorrelate !== undefined && decorrelate !== 'none') return null;
  return { kind: 'rule', rule: 'R7', error: r7Error(models.length, order) };
}

export function validate(config: ProposedConfig, remedyOrder: RemedyOrder = 'drop-offered'): Validation {
  const violations: Violation[] = [];
  const unverifiable: string[] = [];

  const preset = config.preset;
  const axes = config.axes ?? {};
  

  if (preset !== undefined && preset !== 'custom' && !PRESET_NAMES.some((p) => p === preset)) {
    violations.push({ kind: 'unknown-preset', got: preset });
  }

  // Vocabulary, before rules: a rule stated over a word we do not have would be
  // a rule about nothing.
  const clean: Partial<Record<AxisName, string>> = {};
  for (const [axis, value] of Object.entries(axes)) {
    const name = AXIS_NAMES.find((a) => a === axis);
    if (name === undefined) {
      violations.push({ kind: 'unknown-axis', got: axis, value });
      continue;
    }
    if (!AXIS_VALUES[name].some((v) => v === value)) {
      violations.push({ kind: 'unknown-value', axis: name, got: value });
      continue;
    }
    clean[name] = value;
  }

  if (preset !== undefined && preset !== 'custom' && Object.keys(axes).length > 0) {
    violations.push({
      kind: 'rule',
      rule: 'R6',
      error:
        `preset '${preset}' is a tested path and takes no axes; you set `
        + `${Object.keys(axes).join(', ')}. Use preset:'custom' to compose axes yourself, `
        + 'and know that custom is legal but untested.',
    });
  }

  if (preset === 'optimise' && (config.verify === undefined || config.verify.trim() === '')) {
    violations.push({
      kind: 'rule',
      rule: 'R5',
      error:
        "optimise needs `verify`: a command that scores one candidate and prints a NUMBER, "
        + 'lower or higher being better. Without it there is no value signal, and a search '
        + 'with no value signal returns its candidates in storage order while reporting that '
        + 'it converged. If nothing can measure this task, use ideate — it needs no verifier '
        + 'and does not pretend to rank.',
    });
  }

  const advance = clean.advance;
  const score = clean.score;

  if (advance !== undefined && TREE_SELECTORS.some((t) => t === advance) && score === 'none') {
    violations.push({
      kind: 'rule',
      rule: 'R1',
      error:
        `advance:'${advance}' selects by value and score:'none' means there is no value, so `
        + 'every node ties and selection falls entirely to the exploration term — the search '
        + 'is a breadth-first enumerator whose winner is storage order. Give it a score, or '
        + "set advance:'none' and take the candidates as an unranked set.",
    });
  }

  if (advance === 'archive' && score !== undefined && score !== 'novelty') {
    violations.push({
      kind: 'rule',
      rule: 'R2',
      error:
        `advance:'archive' keeps one occupant per cell, so it needs a rejection test that `
        + `stops near-duplicates filling the grid; score:'${score}' is not one. Measured: `
        + 'dropping that filter fills every cell with variants of a single candidate while '
        + "still reporting full coverage. Set score:'novelty'.",
    });
  }

  const r7 = checkR7(config, clean.decorrelate, remedyOrder);
  if (r7 !== null) violations.push(r7);

  if (advance === 'archive') {
    unverifiable.push('R3: whether the archive key is model-decided cannot be read off the config');
  }
  if (score === 'judge' && advance !== undefined && TREE_SELECTORS.some((t) => t === advance)) {
    unverifiable.push('R4: judge marginalisation count is not exposed on this surface');
  }

  return { legal: violations.length === 0, violations, unverifiable };
}

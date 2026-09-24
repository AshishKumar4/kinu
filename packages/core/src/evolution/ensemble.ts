/**
 * A two-judge cross-family LLM panel that re-judges the owner's hand-labeled turns, and the pre-registered bar it
 * must clear before it may draw recalibrations with a human audit slice.
 *
 * Judges see exactly `renderLabelingEvidence`, never another rater's verdict. A split is `unclear`, never
 * tie-broken. κ and error profiles come from ppi.ts (`designWeightedKappa`, `resampledAccuracy`).
 *
 * Stand-in bar, on lower 95% bounds (`STAND_IN_THRESHOLDS`): κ(human ↔ ensemble) clears the kappa bar and is at
 * least the classifier's over the same turns; negative-class sensitivity and specificity clear theirs, bounding the
 * Rogan–Gladen denominator q̂₁ + q̂₀ − 1. Landis & Koch (Biometrics 33:159, 1977) put "substantial" agreement at
 * 0.61 and up.
 *
 * A refusal is answered with more labels, never a lower bar. Passing enables nothing automatically.
 */

import * as v from 'valibot';
import type { LLM, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { tolerate } from '../obs/index';
import { formatScoreInterval } from '../utils/stats';
import {
  calibrationUniverse, labelingItem, renderLabelingEvidence, OUTCOME_LABEL_HELP,
  type LabelingItem, type UniverseRow,
} from './calibration';
import {
  ensembleLabels, goldLabels, isNegativeOutcome, recordEnsembleLabels,
  OUTCOME_LABELS, TURN_OUTCOMES,
  type OutcomeLabel, type TurnOutcome,
} from './outcomes';
import {
  designWeightedKappa, resampledAccuracy,
  type AccuracyStratum, type ClassifierAccuracy, type GoldStratum, type KappaEstimate,
} from './ppi';

/** The pre-registered bar; changing it redefines "the panel qualifies". */
export const STAND_IN_THRESHOLDS = {
  kappa: 0.6,
  sensitivity: 0.7,
  specificity: 0.9,
} as const;

export interface EnsembleJudge {
  /** `<provider>/<modelId>`. */
  spec: string;
  llm: LLM;
}

/** The blind judging prompt: the human file's evidence and label definitions. */
export function buildEnsembleJudgePrompt(item: LabelingItem): string {
  return (
    'You are auditing how one turn of a conversation landed. A user made a ' +
    'request, an assistant answered, and the user replied. Judge ONLY what the ' +
    "user's reply shows about how that answer was received — not whether you " +
    'think the answer was good.\n\n' +
    `${renderLabelingEvidence(item)}\n\n` +
    'Verdicts:\n' +
    OUTCOME_LABELS.map((label) => `- "${label}": ${OUTCOME_LABEL_HELP[label]}`).join('\n') +
    '\n\nAnswer "unclear" when the evidence genuinely does not settle it. A ' +
    'guess is worse than an abstention here.\n\n' +
    `JSON shape: {"verdict":${OUTCOME_LABELS.map((l) => `"${l}"`).join('|')}}\n` +
    jsonObjectOnlyInstruction()
  );
}

const VerdictSchema = v.object({ verdict: v.picklist(OUTCOME_LABELS) });

/** Null for an unusable answer: a hole the caller counts, not an abstention. */
function parseVerdict(raw: string): OutcomeLabel | null {
  const answer = tolerate(() => extractJsonObject(raw), 'malformed-input');
  const parsed = v.safeParse(VerdictSchema, answer);

  return parsed.success ? parsed.output.verdict : null;
}

export interface EnsembleGap {
  kind:
    | 'no_population'
    | 'no_gold_labels'
    | 'no_usable_labels'
    /** Fewer than two distinct vendor families. */
    | 'too_few_judges'
    | 'not_run';
  /** Available judges, for 'too_few_judges'. */
  judges: string[];
}

export function describeEnsembleGap(gap: EnsembleGap): string {
  switch (gap.kind) {
    case 'no_population':
      return 'no classifier-graded turns yet — the classifier grades a turn once the user follows up';
    case 'no_gold_labels':
      return 'no hand labels yet, so there is nothing to check the panel against — draw a set with ' +
        '`kinu label export <agent>`, fill it in, then `kinu label ingest <agent> <file>`';
    case 'no_usable_labels':
      return 'every turn the panel covered was hand-labeled `unclear`, so none of them settles anything — ' +
        'label more turns with `kinu label export <agent>`';
    case 'too_few_judges':
      return 'an ensemble needs two models from different vendors and this deployment has ' +
        (gap.judges.length === 0 ? 'none connected' : `only ${gap.judges.join(', ')}`) +
        ' — connect a second vendor, or name both judges explicitly';
    case 'not_run':
      return 'the panel has not judged these turns yet — run `kinu label ensemble <agent>`';
  }
}

export interface EnsembleRun {
  judged: Array<{ model: string; stored: number; failed: number }>;
  turns: number;
  /** Verdicts already on file from an earlier run, so not paid for again. */
  alreadyJudged: number;
}

export type EnsembleRunResult =
  | { run: EnsembleRun; gap: null }
  | { run: null; gap: EnsembleGap };

function goldLabeledItems(
  universe: ReadonlyArray<UniverseRow>, sql: SqlExecutor, actor: ActorHandle,
): LabelingItem[] {
  const gold = goldLabels(sql, actor);

  return universe.filter((row) => gold.has(row.id)).map(labelingItem);
}

/**
 * Choosing specs is free; resolving a judge needs credentials. Kept separate
 * so free preconditions (labels, two vendors) are reported before auth.
 */
export interface EnsemblePanel {
  specs(): Promise<readonly string[]>;
  judge(spec: string): EnsembleJudge;
}

/**
 * Put every hand-labeled turn to every judge. Already-answered turns are
 * skipped and each verdict is stored as it lands, so an interrupted run keeps
 * what it paid for. Unusable answers are counted; a failed call propagates.
 */
export async function runEnsemble(
  sql: SqlExecutor,
  actor: ActorHandle,
  panel: EnsemblePanel,
  opts: { now?: number } = {},
): Promise<EnsembleRunResult> {
  // Report gaps in fix order: ledger, labels, then models.
  const universe = calibrationUniverse(sql, actor);

  if (universe.length === 0) return { run: null, gap: { kind: 'no_population', judges: [] } };
  const items = goldLabeledItems(universe, sql, actor);

  if (items.length === 0) return { run: null, gap: { kind: 'no_gold_labels', judges: [] } };
  const specs = await panel.specs();

  if (specs.length < 2) {
    return { run: null, gap: { kind: 'too_few_judges', judges: [...specs] } };
  }

  const judges = specs.map((spec) => panel.judge(spec));

  const done = new Set(ensembleLabels(sql, actor).map((row) => `${row.outcomeId}\n${row.model}`));
  const judged: EnsembleRun['judged'] = [];
  let alreadyJudged = 0;

  for (const judge of judges) {
    const todo = items.filter((item) => !done.has(`${item.outcomeId}\n${judge.spec}`));
    alreadyJudged += items.length - todo.length;
    let stored = 0;
    let failed = 0;

    for (const item of todo) {
      const label = await askEnsembleJudge(judge, item);

      if (label === null) {
        failed++;
        continue;
      }

      recordEnsembleLabels(sql, actor, {
        model: judge.spec,
        labels: [{ outcomeId: item.outcomeId, label }],
        now: opts.now,
      });
      stored++;
    }

    judged.push({ model: judge.spec, stored, failed });
  }

  return { run: { judged, turns: items.length, alreadyJudged }, gap: null };
}

/** One judge's blind verdict on one turn, or null when unusable. Shared with
 *  behavior-labels.ts so prompt and parse cannot drift. */
export async function askEnsembleJudge(
  judge: EnsembleJudge,
  item: LabelingItem,
): Promise<OutcomeLabel | null> {
  return parseVerdict(await judge.llm.complete(buildEnsembleJudgePrompt(item)));
}

/** Unanimous verdict, else `unclear`; null only for an empty panel. */
export function panelVerdict(perJudge: ReadonlyArray<OutcomeLabel>): OutcomeLabel | null {
  if (perJudge.length === 0) return null;

  return perJudge.every((label) => label === perJudge[0]) ? perJudge[0] : 'unclear';
}

export interface ComparedTurn {
  /** Also the stratum the turn was sampled from. */
  predicted: TurnOutcome;
  /** `unclear` gold labels are excluded upstream. */
  human: TurnOutcome;
  ensemble: OutcomeLabel;
  /** In report model order; complete, since turns any judge missed are skipped. */
  perJudge: ReadonlyArray<OutcomeLabel>;
}

export interface EnsembleMember {
  model: string;
  labeled: number;
  kappa: KappaEstimate | null;
}

export interface StandInCondition {
  name: string;
  met: boolean;
  detail: string;
}

export interface EnsembleReport {
  members: EnsembleMember[];
  gold: number;
  /** Turns every judge answered. */
  covered: number;
  split: number;
  /** Covered minus owner-`unclear` turns; every number below is over these. */
  compared: number;
  kappa: {
    humanEnsemble: KappaEstimate | null;
    humanClassifier: KappaEstimate | null;
    ensembleClassifier: KappaEstimate | null;
  };
  confusion: Array<{ ensemble: OutcomeLabel; human: TurnOutcome; count: number }>;
  accuracy: ClassifierAccuracy | null;
  standIn: { qualified: boolean; conditions: StandInCondition[] } | null;
  /** Null when everything above is populated. */
  gap: EnsembleGap | null;
}

/** `unclear` counts as not flagging: an abstaining stand-in missed the bad turn. */
export function flagsNegative(label: OutcomeLabel): boolean {
  return label !== 'unclear' && isNegativeOutcome(label);
}

/**
 * Panel draws per classifier-verdict stratum (the sampling design). Strata with
 * population but no compared turns are emitted empty so `unlabeled_strata` is
 * reported rather than their weight silently dropped.
 */
export function panelStrata(
  compared: ReadonlyArray<ComparedTurn>,
  populations: ReadonlyMap<TurnOutcome, number>,
): AccuracyStratum[] {
  return [...populations].map(([verdict, population]) => ({
    key: verdict,
    population,
    draws: compared
      .filter((row) => row.predicted === verdict)
      .map((row) => ({ predictedEvent: flagsNegative(row.ensemble), event: isNegativeOutcome(row.human) })),
  }));
}

function kappaStrata(
  compared: ReadonlyArray<ComparedTurn>,
  populations: ReadonlyMap<TurnOutcome, number>,
  pair: (row: ComparedTurn) => { a: string; b: string },
): GoldStratum[] {
  return [...populations].map(([verdict, population]) => ({
    key: verdict,
    population,
    draws: compared.filter((row) => row.predicted === verdict).map(pair),
  }));
}

/**
 * All numbers are over turns all three raters covered, so the classifier κ here
 * differs from the calibration report's (which uses every gold label).
 */
export function ensembleReport(sql: SqlExecutor, actor: ActorHandle): EnsembleReport {
  const universe = calibrationUniverse(sql, actor);
  const byId = new Map(universe.map((row) => [row.id, row]));
  const gold = goldLabels(sql, actor);
  const rows = ensembleLabels(sql, actor);

  const models = [...new Set(rows.map((row) => row.model))].sort();

  /** Only turns the ledger still holds count as coverage. */
  const labeledBy = (model: string): number =>
    rows.filter((row) => row.model === model && byId.has(row.outcomeId)).length;

  const empty = {
    members: models.map((model) => ({ model, labeled: labeledBy(model), kappa: null })),
    gold: [...gold.keys()].filter((id) => byId.has(id)).length,
    covered: 0,
    split: 0,
    compared: 0,
    kappa: { humanEnsemble: null, humanClassifier: null, ensembleClassifier: null },
    confusion: [],
    accuracy: null,
    standIn: null,
  };

  if (universe.length === 0) return { ...empty, gap: { kind: 'no_population', judges: [] } };

  if (empty.gold === 0) return { ...empty, gap: { kind: 'no_gold_labels', judges: [] } };

  if (models.length < 2) return { ...empty, gap: { kind: models.length === 0 ? 'not_run' : 'too_few_judges', judges: models } };

  const byTurn = new Map<string, Map<string, OutcomeLabel>>();

  for (const row of rows) {
    const perModel = byTurn.get(row.outcomeId) ?? new Map<string, OutcomeLabel>();
    perModel.set(row.model, row.label);
    byTurn.set(row.outcomeId, perModel);
  }

  let covered = 0;
  let split = 0;
  const compared: ComparedTurn[] = [];

  for (const [id, label] of gold) {
    const row = byId.get(id);

    if (!row) continue;
    const answered = byTurn.get(id);

    const perJudge = models.map((model) => answered?.get(model))
      .filter((answer): answer is OutcomeLabel => answer !== undefined);

    // A judge with no answer leaves the panel without a verdict for this turn.
    if (perJudge.length < models.length) continue;
    const verdict = panelVerdict(perJudge);

    if (verdict === null) continue;
    covered++;

    if (verdict === 'unclear') split++;

    if (label.label === 'unclear') continue;
    compared.push({ predicted: row.predicted, human: label.label, ensemble: verdict, perJudge });
  }

  if (compared.length === 0) {
    return {
      ...empty,
      covered,
      split,
      gap: { kind: covered === 0 ? 'not_run' : 'no_usable_labels', judges: models },
    };
  }

  const populations = new Map<TurnOutcome, number>();

  for (const row of universe) {
    populations.set(row.predicted, (populations.get(row.predicted) ?? 0) + 1);
  }

  const kappa = {
    humanEnsemble: designWeightedKappa(kappaStrata(compared, populations, (r) => ({ a: r.ensemble, b: r.human }))),
    humanClassifier: designWeightedKappa(kappaStrata(compared, populations, (r) => ({ a: r.predicted, b: r.human }))),
    ensembleClassifier: designWeightedKappa(kappaStrata(compared, populations, (r) => ({ a: r.predicted, b: r.ensemble }))),
  };

  const accuracy = resampledAccuracy(panelStrata(compared, populations)).accuracy;

  return {
    members: models.map((model, i) => ({
      model,
      labeled: labeledBy(model),
      // Same compared turns as the panel, so a member beating the panel is visible.
      kappa: designWeightedKappa(kappaStrata(
        compared, populations, (r) => ({ a: r.perJudge[i], b: r.human }),
      )),
    })),
    gold: empty.gold,
    covered,
    split,
    compared: compared.length,
    kappa,
    confusion: OUTCOME_LABELS.flatMap((ensemble) => TURN_OUTCOMES.map((human) => ({
      ensemble,
      human,
      count: compared.filter((row) => row.ensemble === ensemble && row.human === human).length,
    }))).filter((cell) => cell.count > 0),
    accuracy,
    standIn: standInVerdict(kappa, accuracy),
    gap: null,
  };
}

/** An unrun or uncalibrated panel prints its missing step in one line. */
export function renderEnsembleReport(report: EnsembleReport): string {
  const lines = ['Judge panel — two cross-family models over the turns you labeled, blind'];

  if (report.gap !== null || report.standIn === null) {
    lines.push(`  ${report.gap === null ? 'not measurable from these labels' : describeEnsembleGap(report.gap)}`);

    if (report.members.length > 0) {
      lines.push(`  Judges so far: ${report.members.map((m) => `${m.model} (${m.labeled})`).join(', ')}`);
    }

    return lines.join('\n');
  }

  const kappa = (estimate: KappaEstimate | null): string => estimate === null
    ? 'undefined at these marginals'
    : `${estimate.value.toFixed(2)} (95% CI ${estimate.lo.toFixed(2)}–${estimate.hi.toFixed(2)})`;

  lines.push(
    `  Judges: ${report.members.map((m) => `${m.model} — κ vs you ${kappa(m.kappa)}`).join('\n          ')}`,
    `  Coverage: ${report.compared} of ${report.gold} hand-labeled turns scored` +
      ` (${report.covered} judged by every model, ${report.split} of those a split → unclear)`,
    `  κ  ${'you ↔ panel:'.padEnd(20)}${kappa(report.kappa.humanEnsemble)}`,
    `  κ  ${'you ↔ classifier:'.padEnd(20)}${kappa(report.kappa.humanClassifier)}` +
      '   (same turns, so the two compare)',
    `  κ  ${'panel ↔ classifier:'.padEnd(20)}${kappa(report.kappa.ensembleClassifier)}`,
  );

  if (report.confusion.length > 0) {
    lines.push('  Panel verdict vs yours:');

    for (const cell of report.confusion) {
      lines.push(`    panel ${cell.ensemble.padEnd(11)}you ${cell.human.padEnd(11)}${cell.count}`);
    }
  }

  if (report.accuracy !== null) {
    lines.push(
      '  On the negative class (corrected/frustrated), through the calibration estimator:',
      `    recall ${formatScoreInterval(report.accuracy.sensitivity)}` +
        `   specificity ${formatScoreInterval(report.accuracy.specificity)}`,
    );
  }

  lines.push(report.standIn.qualified
    ? '  Stand-in: CLEARS the pre-registered bar. Recalibration may be drawn by the panel with a hand-audited slice.'
    : '  Stand-in: the panel CANNOT stand in for you yet. Keep labeling by hand.');

  for (const condition of report.standIn.conditions) {
    lines.push(`    ${condition.met ? 'ok  ' : 'no  '}${condition.name} — ${condition.detail}`);
  }

  return lines.join('\n');
}

/** Each condition reports what it saw, so a failure shows how far off it is. */
function standInVerdict(
  kappa: EnsembleReport['kappa'],
  accuracy: ClassifierAccuracy | null,
) {
  const pair = kappa.humanEnsemble;
  const against = kappa.humanClassifier;

  const conditions: StandInCondition[] = [
    {
      name: `κ(you ↔ panel) lower bound ≥ ${STAND_IN_THRESHOLDS.kappa.toFixed(2)}`,
      met: pair !== null && pair.lo >= STAND_IN_THRESHOLDS.kappa,
      detail: pair === null
        ? 'κ is undefined at these marginals'
        : `${pair.value.toFixed(2)} (95% CI ${pair.lo.toFixed(2)}–${pair.hi.toFixed(2)})`,
    },
    {
      name: 'the panel tracks you at least as well as the classifier does',
      met: pair !== null && against !== null && pair.value >= against.value,
      detail: pair === null || against === null
        ? 'one of the two κ is undefined at these marginals'
        : `panel ${pair.value.toFixed(2)} vs classifier ${against.value.toFixed(2)}`,
    },
    {
      name: `negative-class recall ≥ ${STAND_IN_THRESHOLDS.sensitivity.toFixed(2)} and ` +
        `specificity ≥ ${STAND_IN_THRESHOLDS.specificity.toFixed(2)}, both as lower bounds`,
      met: accuracy !== null &&
        accuracy.sensitivity.lo >= STAND_IN_THRESHOLDS.sensitivity &&
        accuracy.specificity.lo >= STAND_IN_THRESHOLDS.specificity,
      detail: accuracy === null
        ? 'not measurable from these labels'
        : `recall ≥ ${accuracy.sensitivity.lo.toFixed(2)}, specificity ≥ ${accuracy.specificity.lo.toFixed(2)}`,
    },
  ];

  return { qualified: conditions.every((condition) => condition.met), conditions };
}

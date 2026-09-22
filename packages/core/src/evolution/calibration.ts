/**
 * The calibration set: a stratified, blind, append-only sample of hand labels
 * that ppi.ts turns into corrected classifier numbers.
 *
 * The draw is stratified on the classifier's verdict so rare verdicts get labels,
 * and systematic in time order within each stratum. The labeling file never shows
 * the classifier's verdict: showing it would anchor the human on the number under test.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { formatScoreInterval, seededRandom } from '../utils/stats';
import {
  goldLabels, isNegativeOutcome, recordOutcomeLabels, TURN_OUTCOMES,
  type OutcomeLabel, type TurnOutcome,
} from './outcomes';
import {
  classifierAccuracy, correctedRate, describeCalibrationGap, designWeightedKappa,
  type CalibrationGap, type ClassifierAccuracy, type CorrectedRate, type KappaEstimate,
  type PredictionStratum,
} from './ppi';

/** The file's key legend and its parser both read this list. */
const LABEL_KEYS: ReadonlyArray<readonly [string, OutcomeLabel]> = [
  ['a', 'accepted'],
  ['c', 'corrected'],
  ['f', 'frustrated'],
  ['b', 'abandoned'],
  ['?', 'unclear'],
];

/** ensemble.ts gives its judges these same sentences; differently-worded questions would not be comparable. */
export const OUTCOME_LABEL_HELP = {
  accepted: 'the user moved on, or built on the answer',
  corrected: 'the user re-asked, fixed it, or contradicted it',
  frustrated: 'the user said, in so many words, that it was bad',
  abandoned: 'the thread was dropped; the follow-up is a new topic',
  unclear: 'you genuinely cannot tell from what is here',
} satisfies Record<OutcomeLabel, string>;

export interface UniverseRow {
  id: string;
  predicted: TurnOutcome;
  scaffoldVersion: number | null;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  createdAt: number;
}

/**
 * The turns the classifier graded. Thumbs, Alternate Takes picks and `session_end`
 * rows have no classifier error and would dilute the profile. Time-ordered.
 * The one definition of the population for sample, report and ensemble.ts.
 */
export function calibrationUniverse(sql: SqlExecutor, actor: ActorHandle): UniverseRow[] {
  actor.assertCurrent();

  return sql<{
    id: string; outcome: TurnOutcome; scaffold_version: number | null;
    user_message: string; assistant_response: string; followup: string | null; created_at: number;
  }>`
    SELECT id, outcome, scaffold_version, user_message, assistant_response, followup, created_at
    FROM turn_outcomes
    WHERE actor_id = ${actor.actorId} AND source = 'classifier' AND outcome != 'abandoned'
    ORDER BY created_at, id`
    .map((r) => ({
      id: r.id, predicted: r.outcome, scaffoldVersion: r.scaffold_version,
      userMessage: r.user_message, assistantResponse: r.assistant_response,
      followup: r.followup, createdAt: r.created_at,
    }));
}

export const DEFAULT_LABEL_BUDGET = 100;

/** Share of the budget spread evenly across verdicts before the rest goes
 *  proportional. Fully even starves the majority verdict; fully proportional
 *  leaves rare verdicts with two or three labels. */
const EVEN_BUDGET_SHARE = 0.5;

/**
 * Half the budget spread evenly across verdicts, half proportional to ledger share.
 * A verdict that cannot fill its quota gives the remainder back for redistribution.
 */
export function allocateLabelBudget(sizes: ReadonlyArray<number>, budget: number): number[] {
  const total = sizes.reduce((n, s) => n + s, 0);

  if (sizes.length === 0 || total === 0 || budget <= 0) return sizes.map(() => 0);

  const even = Math.floor((budget * EVEN_BUDGET_SHARE) / sizes.length);
  const proportional = budget - even * sizes.length;
  // Largest remainder: rounding shares independently can overshoot the budget.
  const shares = sizes.map((size) => (proportional * size) / total);
  const quotas = shares.map((share) => even + Math.floor(share));
  let unassigned = proportional - shares.reduce((n, share) => n + Math.floor(share), 0);

  const byRemainder = shares
    .map((share, i) => ({ i, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const { i } of byRemainder) {
    if (unassigned <= 0) break;
    quotas[i]++;
    unassigned--;
  }

  for (let i = 0; i < quotas.length; i++) quotas[i] = Math.min(quotas[i], sizes[i]);

  let spare = budget - quotas.reduce((n, q) => n + q, 0);

  while (spare > 0) {
    const headroom = sizes.map((size, i) => size - quotas[i]);

    if (headroom.every((h) => h <= 0)) break;

    for (let i = 0; i < quotas.length && spare > 0; i++) {
      if (headroom[i] > 0) {
        quotas[i]++;
        spare--;
      }
    }
  }

  return quotas;
}

/** Everything needed to judge the turn, nothing that would anchor the judgement. */
export interface LabelingItem {
  outcomeId: string;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  createdAt: number;
}

export function labelingItem(row: UniverseRow): LabelingItem {
  return {
    outcomeId: row.id,
    userMessage: row.userMessage,
    assistantResponse: row.assistantResponse,
    followup: row.followup,
    createdAt: row.createdAt,
  };
}

/** Fixed so re-exporting an unchanged ledger is byte-identical. */
const SHUFFLE_SEED = 1;

/** Hides which stratum an item came from; the file is meant to be blind. */
function shuffled<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  const random = seededRandom(seed);

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

/** Evenly spaced draw over a time-ordered list. */
function spread<T>(rows: ReadonlyArray<T>, n: number): T[] {
  const take = Math.min(n, rows.length);

  return Array.from({ length: take }, (_, j) => rows[Math.floor(((j + 0.5) * rows.length) / take)]);
}

/**
 * Draw the next calibration set. Turns already carrying a gold label are excluded,
 * so a re-run tops the set up.
 */
export function sampleForLabeling(
  sql: SqlExecutor, actor: ActorHandle, opts: { size?: number } = {},
): LabelingItem[] {
  const already = goldLabels(sql, actor);
  const universe = calibrationUniverse(sql, actor).filter((row) => !already.has(row.id));

  if (universe.length === 0) return [];

  const byVerdict = new Map<TurnOutcome, UniverseRow[]>();

  for (const row of universe) {
    const bucket = byVerdict.get(row.predicted) ?? [];
    bucket.push(row);
    byVerdict.set(row.predicted, bucket);
  }

  const verdicts = [...byVerdict.keys()];

  const quotas = allocateLabelBudget(
    verdicts.map((v) => byVerdict.get(v)?.length ?? 0),
    opts.size ?? DEFAULT_LABEL_BUDGET,
  );

  const drawn = verdicts.flatMap((verdict, i) => spread(byVerdict.get(verdict) ?? [], quotas[i]));

  return shuffled(drawn, SHUFFLE_SEED).map(labelingItem);
}

/** Characters shown per field; the follow-up decides the verdict so it gets the most room. */
const SHOWN = { user: 400, response: 500, followup: 700 } as const;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();

  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… [truncated]`;
}

const BLOCK_HEADER = /^###\s+\d+\s*\/\s*\d+\s+(\S+)\s*$/;

const VERDICT_LINE = /^verdict:\s*(\S*)\s*$/;

/**
 * The only thing any rater sees of a turn. The human file and ensemble.ts both
 * render here, and nothing here has access to the classifier's verdict.
 */
export function renderLabelingEvidence(item: LabelingItem): string {
  return [
    `USER  (${new Date(item.createdAt).toISOString().slice(0, 10)})`,
    clip(item.userMessage, SHOWN.user),
    '',
    'AGENT',
    clip(item.assistantResponse, SHOWN.response),
    '',
    "USER'S NEXT MESSAGE",
    item.followup === null ? '(none — the session ended here)' : clip(item.followup, SHOWN.followup),
  ].join('\n');
}

export function renderLabelingFile(items: ReadonlyArray<LabelingItem>): string {
  const lines = [
    `# Kinu outcome calibration — ${items.length} turn${items.length === 1 ? '' : 's'}`,
    '#',
    "# For each turn, judge what the user's FOLLOW-UP shows about how the agent's",
    '# answer landed. Put ONE letter after `verdict:` —',
    '#',
    ...LABEL_KEYS.map(([key, label]) => `#   ${key}  ${label.padEnd(12)}${OUTCOME_LABEL_HELP[label]}`),
    '#',
    '# Leave a verdict blank to skip that turn.',
    '#',
    "# The classifier's own answer is deliberately NOT shown. Seeing it first",
    '# would anchor yours, and the distance between the two is the measurement.',
    '#',
    '# In vim:  /^verdict:  then  n  to step, then  A <letter> Esc.',
    '# When you are done, save and run:',
    '#',
    '#     kinu label ingest <agent> <this file>',
    '',
  ];

  for (const [index, item] of items.entries()) {
    lines.push(
      `### ${index + 1}/${items.length} ${item.outcomeId}`,
      'verdict:',
      '',
      renderLabelingEvidence(item),
      '',
    );
  }

  return lines.join('\n');
}

export interface ParsedLabelFile {
  labels: Array<{ outcomeId: string; label: OutcomeLabel }>;
  skipped: number;
  /** A non-empty list must block the write. */
  errors: string[];
}

/**
 * Purely syntactic; id existence is the ingest's business. Every problem is
 * collected rather than thrown, so one typo does not lose the pass.
 */
export function parseLabelingFile(text: string): ParsedLabelFile {
  const byKey = new Map<string, OutcomeLabel>(LABEL_KEYS.map(([key, label]) => [key, label]));
  const labels: Array<{ outcomeId: string; label: OutcomeLabel }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let current: string | null = null;
  let verdicts = 0;
  let blocks = 0;

  for (const [i, line] of text.split('\n').entries()) {
    const header = BLOCK_HEADER.exec(line);

    if (header) {
      current = header[1];
      blocks++;

      if (seen.has(current)) errors.push(`line ${i + 1}: turn ${current} appears more than once`);
      seen.add(current);

      continue;
    }

    const verdict = VERDICT_LINE.exec(line);

    if (!verdict) continue;

    if (current === null) {
      errors.push(`line ${i + 1}: a verdict before any turn`);

      continue;
    }

    verdicts++;
    const raw = verdict[1];

    if (raw === '') continue;
    const label = byKey.get(raw.toLowerCase());

    if (label === undefined) {
      errors.push(`line ${i + 1}: "${raw}" is not a verdict — use ${[...byKey.keys()].join(', ')}`);

      continue;
    }

    labels.push({ outcomeId: current, label });
  }

  if (blocks === 0) errors.push('no turns found — is this a Kinu labeling file?');

  return { labels, skipped: verdicts - labels.length, errors };
}

export interface LabelIngestResult {
  stored: number;
  /** Ids not in the calibration universe. Reported, not stored. */
  unknown: string[];
  /** Of the stored verdicts, how many disagreed with the classifier. */
  disagreements: number;
}

/** Unknown ids are skipped rather than fatal: a turn can age out between drawing and filling in a file. */
export function ingestOutcomeLabels(
  sql: SqlExecutor,
  actor: ActorHandle,
  input: { labeler: string; labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>; now?: number },
): LabelIngestResult {
  const predicted = new Map(calibrationUniverse(sql, actor).map((row) => [row.id, row.predicted]));
  const known = input.labels.filter((entry) => predicted.has(entry.outcomeId));

  const unknown = input.labels
    .filter((entry) => !predicted.has(entry.outcomeId))
    .map((entry) => entry.outcomeId);

  recordOutcomeLabels(sql, actor, { labeler: input.labeler, labels: known, now: input.now });

  return {
    stored: known.length,
    unknown,
    disagreements: known.filter((entry) => entry.label !== predicted.get(entry.outcomeId)).length,
  };
}

export interface CalibrationStratum {
  predicted: TurnOutcome;
  population: number;
  /** Usable gold labels drawn from them (`unclear` excluded). */
  labeled: number;
  actual: Array<{ outcome: TurnOutcome; count: number }>;
}

export interface CalibratedSegment {
  scaffoldVersion: number | null;
  /** Classifier-graded turns this version served, and how many it called
     *  corrected or frustrated. */
  observed: { events: number; population: number };
  rate: CorrectedRate | null;
}

export interface CalibrationReport {
  universe: number;
  labeled: number;
  /** Recorded, then excluded from every number below, assuming unclear labels are not biased toward one outcome. */
  unclear: number;
  /** Labels whose turn is no longer in the ledger. */
  orphaned: number;
  labelers: string[];
  lastLabeledAt: number | null;
  strata: CalibrationStratum[];
  accuracy: ClassifierAccuracy | null;
  kappa: KappaEstimate | null;
  overall: CorrectedRate | null;
  segments: CalibratedSegment[];
  /** Null when everything above is populated; otherwise why it is not. */
  gap: CalibrationGap | null;
}

/**
 * Per-version denominators are classifier-graded turns only, narrower than
 * K_align's own denominator, which also counts explicit user verdicts that have
 * no error to correct. Both rates are rendered side by side.
 */
export function calibrationReport(sql: SqlExecutor, actor: ActorHandle): CalibrationReport {
  const universe = calibrationUniverse(sql, actor);
  const gold = goldLabels(sql, actor);
  const byId = new Map(universe.map((row) => [row.id, row]));

  let unclear = 0;
  let orphaned = 0;
  const labelers = new Set<string>();
  let lastLabeledAt: number | null = null;
  const judged = new Map<TurnOutcome, TurnOutcome[]>();

  for (const label of gold.values()) {
    labelers.add(label.labeler);
    lastLabeledAt = Math.max(lastLabeledAt ?? 0, label.createdAt);
    const row = byId.get(label.outcomeId);

    if (!row) {
      orphaned++;
      continue;
    }

    if (label.label === 'unclear') {
      unclear++;
      continue;
    }

    judged.set(row.predicted, [...(judged.get(row.predicted) ?? []), label.label]);
  }

  const strata: CalibrationStratum[] = TURN_OUTCOMES
    .filter((verdict) => verdict !== 'abandoned')
    .map((verdict) => {
      const actuals = judged.get(verdict) ?? [];

      return {
        predicted: verdict,
        population: universe.filter((row) => row.predicted === verdict).length,
        labeled: actuals.length,
        actual: TURN_OUTCOMES
          .map((outcome) => ({ outcome, count: actuals.filter((a) => a === outcome).length }))
          .filter((cell) => cell.count > 0),
      };
    })
    .filter((stratum) => stratum.population > 0 || stratum.labeled > 0);

  const prediction: PredictionStratum[] = strata.map((stratum) => ({
    key: stratum.predicted,
    predictedEvent: isNegativeOutcome(stratum.predicted),
    population: stratum.population,
    labeled: stratum.labeled,
    events: stratum.actual.reduce((n, cell) => n + (isNegativeOutcome(cell.outcome) ? cell.count : 0), 0),
  }));

  const base = {
    universe: universe.length,
    labeled: prediction.reduce((n, s) => n + s.labeled, 0),
    unclear,
    orphaned,
    labelers: [...labelers].sort(),
    lastLabeledAt,
    strata,
  };

  const measured = classifierAccuracy(prediction);

  if (measured.accuracy === null) {
    return {
      ...base,
      accuracy: null,
      kappa: null,
      overall: null,
      segments: segmentObservations(universe).map((observed) => ({ ...observed, rate: null })),
      gap: measured.gap,
    };
  }

  const accuracy = measured.accuracy;

  const overall = correctedRate(
    { events: universe.filter((row) => isNegativeOutcome(row.predicted)).length, population: universe.length },
    accuracy,
  );

  const segments = segmentObservations(universe).map((segment) => ({
    ...segment,
    rate: correctedRate(segment.observed, accuracy).rate,
  }));

  return {
    ...base,
    accuracy,
    kappa: designWeightedKappa(strata.map((stratum) => ({
      key: stratum.predicted,
      population: stratum.population,
      draws: stratum.actual.flatMap((cell) =>
        Array<{ a: string; b: string }>(cell.count).fill({ a: stratum.predicted, b: cell.outcome })),
    }))),
    overall: overall.rate,
    segments,
    gap: overall.gap,
  };
}

function segmentObservations(universe: ReadonlyArray<UniverseRow>): Array<Omit<CalibratedSegment, 'rate'>> {
  const byVersion = new Map<number | null, UniverseRow[]>();

  for (const row of universe) {
    const bucket = byVersion.get(row.scaffoldVersion) ?? [];
    bucket.push(row);
    byVersion.set(row.scaffoldVersion, bucket);
  }

  return [...byVersion]
    .map(([scaffoldVersion, rows]) => ({
      scaffoldVersion,
      observed: {
        events: rows.filter((row) => isNegativeOutcome(row.predicted)).length,
        population: rows.length,
      },
      firstAt: Math.min(...rows.map((row) => row.createdAt)),
    }))
    .sort((a, b) => a.firstAt - b.firstAt)
    .map(({ scaffoldVersion, observed }) => ({ scaffoldVersion, observed }));
}

function per100(value: number): string {
  return (value * 100).toFixed(1);
}

function renderRate(rate: CorrectedRate): string {
  return `${per100(rate.corrected.mean)} per 100 turns ` +
    `(95% CI ${per100(rate.corrected.lo)}–${per100(rate.corrected.hi)})` +
    ` — the classifier said ${per100(rate.raw)}, off by ${rate.bias >= 0 ? '+' : ''}${per100(rate.bias)}`;
}

/** With no labels, says so in one line: the number is never approximated or defaulted. */
export function renderCalibrationReport(report: CalibrationReport): string {
  const lines = [
    'Judge calibration — the turn-outcome classifier, measured against hand labels',
  ];

  if (report.gap !== null || report.accuracy === null || report.overall === null) {
    const gap = report.gap;
    lines.push(
      `  ${gap === null ? 'uncalibrated — no hand-labeled turns yet' : describeCalibrationGap(gap)}`,
      `  ${report.universe} classifier-graded turn${report.universe === 1 ? '' : 's'} are waiting to be checked; ` +
        `${report.labeled} labeled so far.`,
      '  Draw a calibration set with:  kinu label export <agent>',
    );

    return lines.join('\n');
  }

  lines.push(
    `  Labels: ${report.labeled} usable` +
      (report.unclear > 0 ? `, ${report.unclear} unclear (excluded)` : '') +
      (report.orphaned > 0 ? `, ${report.orphaned} orphaned` : '') +
      ` over ${report.universe} classifier-graded turns` +
      (report.labelers.length > 0 ? ` — by ${report.labelers.join(', ')}` : '') +
      // A profile measured against an older model says nothing about the current one.
      (report.lastLabeledAt === null ? '' : `, last on ${new Date(report.lastLabeledAt).toISOString().slice(0, 10)}`),
    `  Sensitivity: ${formatScoreInterval(report.accuracy.sensitivity)}` +
      `   Specificity: ${formatScoreInterval(report.accuracy.specificity)}`,
    report.kappa === null
      ? "  Cohen's κ: undefined at these marginals"
      : `  Cohen's κ: ${report.kappa.value.toFixed(2)} (95% CI ${report.kappa.lo.toFixed(2)}–${report.kappa.hi.toFixed(2)})`,
    `  Corrected correction rate: ${renderRate(report.overall)}`,
  );

  if (report.segments.length > 1) {
    lines.push('  By scaffold version (oldest first):');

    for (const segment of report.segments) {
      lines.push(`    v${segment.scaffoldVersion ?? '?'}  n=${segment.observed.population}  ` +
        (segment.rate === null ? 'uncalibrated' : renderRate(segment.rate)));
    }
  }

  lines.push('  Sensitivity is a ratio estimate and runs ~1–2 points high at 100 labels; the corrected rate does not.');

  return lines.join('\n');
}

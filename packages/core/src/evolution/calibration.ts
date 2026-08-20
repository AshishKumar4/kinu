/**
 * The calibration set — how it is drawn, how it is put in front of a human,
 * how their verdicts come back, and what those verdicts buy.
 *
 * The turn-outcome classifier (outcomes.ts) labels every non-trivial turn, and
 * those labels gate craft retirement, scaffold promotion, GEPA train/val
 * splits and K_align. Until a human has checked a sample of them, the error
 * profile behind all of that is unmeasured — and an unmeasured judge is the
 * failure mode a self-evolving system is least able to notice, because it
 * grades its own homework with the same instrument it is trying to improve.
 *
 * This module closes that with ~100 hand labels. It draws them, presents them,
 * stores them, and hands them to ppi.ts, which turns them into corrected
 * numbers with honest intervals. Three design choices are load-bearing:
 *
 *  - **The draw is stratified on the classifier's verdict.** A uniform sample
 *    of a ledger that is ~85% "accepted" would spend ~85 of 100 labels
 *    confirming the easy case and leave the rare verdicts — the ones every
 *    downstream decision actually turns on — measured by a handful of rows.
 *
 *  - **The labeling file is BLIND.** It shows the turn, the answer and the
 *    user's follow-up, and never the classifier's verdict. Pre-filling the
 *    classifier's guess would make the file faster to fill in and would also
 *    destroy the measurement: the human would be anchored on the number under
 *    test, and sensitivity would come back flattered by exactly the amount
 *    that matters. Speed comes from the format instead — one keystroke per
 *    turn, verdict line first in each block.
 *
 *  - **Labels are append-only.** A re-label adds a row; the newest wins.
 *    Nothing that a human spent attention on is ever overwritten in place.
 *
 * The estimate is only valid if the draw is representative WITHIN each
 * stratum, so the draw is systematic over the ledger in time order: it spreads
 * evenly across the whole history rather than clustering in whichever era
 * happens to sort first.
 */

import type { SqlExecutor } from '../types/primitives';
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

/** One keystroke per verdict — the whole labeling flow's speed budget. The
 *  file's key legend and its parser both read this list, so a key can never
 *  be offered without being accepted back. */
const LABEL_KEYS: ReadonlyArray<readonly [string, OutcomeLabel]> = [
  ['a', 'accepted'],
  ['c', 'corrected'],
  ['f', 'frustrated'],
  ['b', 'abandoned'],
  ['?', 'unclear'],
];

/** What each verdict means, in the words a human deciding between them needs.
 *  The ensemble judges (ensemble.ts) are given these same sentences verbatim —
 *  two raters answering differently-worded questions would not be comparable. */
export const OUTCOME_LABEL_HELP = {
  accepted: 'the user moved on, or built on the answer',
  corrected: 'the user re-asked, fixed it, or contradicted it',
  frustrated: 'the user said, in so many words, that it was bad',
  abandoned: 'the thread was dropped; the follow-up is a new topic',
  unclear: 'you genuinely cannot tell from what is here',
} satisfies Record<OutcomeLabel, string>;

// ── The calibration universe ─────────────────────────────────────

/** One row of the population the classifier's error profile is about. */
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
 * The turns a calibration set speaks for: those the CLASSIFIER graded.
 *
 * Rows sourced from explicit thumbs or an Alternate Takes pick are already
 * ground truth and have no error to measure; `session_end` abandonment is a
 * mechanical rule, not a judgement. Including any of them would dilute the
 * measured error profile toward zero and quietly overstate the classifier.
 *
 * Ordered by time so a systematic draw over this list is spread across the
 * agent's whole history.
 *
 * Exported because it is the ONE definition of that population: the sample, the
 * report and the ensemble check (ensemble.ts) must all speak for the same rows
 * or their numbers are about different things.
 */
export function calibrationUniverse(sql: SqlExecutor): UniverseRow[] {
  return sql<{
    id: string; outcome: TurnOutcome; scaffold_version: number | null;
    user_message: string; assistant_response: string; followup: string | null; created_at: number;
  }>`
    SELECT id, outcome, scaffold_version, user_message, assistant_response, followup, created_at
    FROM turn_outcomes
    WHERE source = 'classifier' AND outcome != 'abandoned'
    ORDER BY created_at, id`
    .map((r) => ({
      id: r.id, predicted: r.outcome, scaffoldVersion: r.scaffold_version,
      userMessage: r.user_message, assistantResponse: r.assistant_response,
      followup: r.followup, createdAt: r.created_at,
    }));
}

// ── Drawing the sample ───────────────────────────────────────────

/** Labels to draw when the caller does not say. Enough for the classifier's
 *  error profile to be worth reading, few enough to hand-label in one sitting. */
export const DEFAULT_LABEL_BUDGET = 100;

/** Share of the budget spread evenly across verdicts before the rest goes
 *  proportional. Measured, not guessed: over 800 simulated calibration sets on
 *  a three-verdict ledger, a 50/50 split beat a fully even allocation by ~18%
 *  on RMSE and ~20% on interval width at the same 100 labels, while still
 *  giving the rarest verdict ~18 of them. Fully even starves the majority
 *  verdict, which carries most of the weight and therefore most of the
 *  variance; fully proportional leaves the rare verdicts with two or three
 *  labels and nothing to say about them. (`unit-calibration.test.ts` pins the
 *  properties, not the constant.) */
const EVEN_BUDGET_SHARE = 0.5;

/**
 * Split a label budget across the verdicts the classifier used.
 *
 * Half spread evenly so every verdict is really measured, half proportional to
 * how much of the ledger each verdict covers so the majority one is not
 * starved. A verdict that cannot supply its quota gives the remainder back,
 * and it is redistributed to whichever verdicts still have rows left.
 */
export function allocateLabelBudget(sizes: ReadonlyArray<number>, budget: number): number[] {
  const total = sizes.reduce((n, s) => n + s, 0);
  if (sizes.length === 0 || total === 0 || budget <= 0) return sizes.map(() => 0);

  const even = Math.floor((budget * EVEN_BUDGET_SHARE) / sizes.length);
  const proportional = budget - even * sizes.length;
  // Largest remainder for the proportional half: rounding each share
  // independently can overshoot the budget, and a quota nobody asked for is
  // as wrong as one that goes missing.
  const shares = sizes.map((size) => (proportional * size) / total);
  const quotas = shares.map((share) => even + Math.floor(share));
  let unassigned = proportional - shares.reduce((n, share) => n + Math.floor(share), 0);
  for (const { i } of shares
    .map((share, i) => ({ i, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder)) {
    if (unassigned <= 0) break;
    quotas[i]++;
    unassigned--;
  }
  for (let i = 0; i < quotas.length; i++) quotas[i] = Math.min(quotas[i], sizes[i]);

  // Give away whatever the caps left over, until nobody has headroom.
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

/** One turn as it reaches a human: everything needed to judge it, nothing that
 *  would anchor the judgement. */
export interface LabelingItem {
  /** The `turn_outcomes` row this verdict is about. */
  outcomeId: string;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  createdAt: number;
}

/** A ledger row as a rater sees it: everything needed to judge the turn,
 *  nothing that would anchor the judgement. */
export function labelingItem(row: UniverseRow): LabelingItem {
  return {
    outcomeId: row.id,
    userMessage: row.userMessage,
    assistantResponse: row.assistantResponse,
    followup: row.followup,
    createdAt: row.createdAt,
  };
}

/** Fixed so the same draw always renders in the same order — a re-export of
 *  an unchanged ledger is byte-identical, which makes a file easy to diff and
 *  a bug easy to reproduce. */
const SHUFFLE_SEED = 1;

/** Deterministic shuffle so the file's order carries no information about
 *  which stratum an item came from — a run of three "corrected" turns in a row
 *  would be a hint, and the file is meant to be blind. */
function shuffled<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  const random = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A systematic draw of `n` from a list already in time order: evenly spaced,
 *  so the sample spans the whole range instead of a corner of it. */
function spread<T>(rows: ReadonlyArray<T>, n: number): T[] {
  const take = Math.min(n, rows.length);
  return Array.from({ length: take }, (_, j) => rows[Math.floor(((j + 0.5) * rows.length) / take)]);
}

/**
 * Draw the next calibration set: stratified across the classifier's verdicts,
 * spread across time within each verdict, and shuffled for presentation.
 *
 * Turns that already carry a gold label are excluded, so running this again
 * tops the set up rather than re-asking questions already answered.
 */
export function sampleForLabeling(sql: SqlExecutor, opts: { size?: number } = {}): LabelingItem[] {
  const already = goldLabels(sql);
  const universe = calibrationUniverse(sql).filter((row) => !already.has(row.id));
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

// ── The labeling file ────────────────────────────────────────────

/** How much of each field the file shows. The follow-up gets the most room
 *  because it is the evidence that decides the verdict; the answer only needs
 *  to be recognisable. Sized so ~100 turns is a 30–45 minute read. */
const SHOWN = { user: 400, response: 500, followup: 700 } as const;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… [truncated]`;
}

const BLOCK_HEADER = /^###\s+\d+\s*\/\s*\d+\s+(\S+)\s*$/;
const VERDICT_LINE = /^verdict:\s*(\S*)\s*$/;

/**
 * The evidence one turn is judged from — and the ONLY thing any rater sees of
 * it. The human file and the ensemble judges (ensemble.ts) both render through
 * here, so the two cannot end up judging from different amounts of the turn,
 * and neither can be shown the classifier's verdict by accident: nothing in
 * this function has access to one.
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

/** Render a drawn calibration set as the file a human fills in. */
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
  items.forEach((item, index) => {
    lines.push(
      `### ${index + 1}/${items.length} ${item.outcomeId}`,
      'verdict:',
      '',
      renderLabelingEvidence(item),
      '',
    );
  });
  return lines.join('\n');
}

export interface ParsedLabelFile {
  labels: Array<{ outcomeId: string; label: OutcomeLabel }>;
  /** Turns present in the file with no verdict written. */
  skipped: number;
  /** Everything wrong with the file. A non-empty list must block the write. */
  errors: string[];
}

/**
 * Read a filled-in labeling file. Purely syntactic — whether an id exists in
 * the ledger is the ingest's business, not the parser's.
 *
 * Every problem is collected rather than thrown on, so one typo in a file
 * representing half an hour of attention reports as one fixable line instead
 * of losing the pass.
 */
export function parseLabelingFile(text: string): ParsedLabelFile {
  const byKey = new Map<string, OutcomeLabel>(LABEL_KEYS.map(([key, label]) => [key, label]));
  const labels: Array<{ outcomeId: string; label: OutcomeLabel }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let current: string | null = null;
  let verdicts = 0;
  let blocks = 0;

  text.split('\n').forEach((line, i) => {
    const header = BLOCK_HEADER.exec(line);
    if (header) {
      current = header[1];
      blocks++;
      if (seen.has(current)) errors.push(`line ${i + 1}: turn ${current} appears more than once`);
      seen.add(current);
      return;
    }
    const verdict = VERDICT_LINE.exec(line);
    if (!verdict) return;
    if (current === null) {
      errors.push(`line ${i + 1}: a verdict before any turn`);
      return;
    }
    verdicts++;
    const raw = verdict[1];
    if (raw === '') return;
    const label = byKey.get(raw.toLowerCase());
    if (label === undefined) {
      errors.push(`line ${i + 1}: "${raw}" is not a verdict — use ${[...byKey.keys()].join(', ')}`);
      return;
    }
    labels.push({ outcomeId: current, label });
  });

  if (blocks === 0) errors.push('no turns found — is this a Kinu labeling file?');
  return { labels, skipped: verdicts - labels.length, errors };
}

// ── Taking the verdicts back ─────────────────────────────────────

export interface LabelIngestResult {
  /** Verdicts written to the ledger. */
  stored: number;
  /** Verdicts whose turn is not in the calibration universe — a turn since
   *  removed, or an id from some other agent's file. Reported, not stored. */
  unknown: string[];
  /** Of the stored verdicts, how many disagreed with the classifier. The one
   *  number worth seeing the moment a labeling pass lands. */
  disagreements: number;
}

/**
 * Validate a parsed labeling pass against the ledger and store what belongs.
 *
 * Ids the ledger does not know are skipped rather than fatal: a turn can
 * legitimately have aged out between drawing a file and filling it in, and
 * losing an entire pass over one stale row would be the wrong trade for
 * something that costs a human half an hour.
 */
export function ingestOutcomeLabels(
  sql: SqlExecutor,
  input: { labeler: string; labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>; now?: number },
): LabelIngestResult {
  const predicted = new Map(calibrationUniverse(sql).map((row) => [row.id, row.predicted]));
  const known = input.labels.filter((entry) => predicted.has(entry.outcomeId));
  const unknown = input.labels
    .filter((entry) => !predicted.has(entry.outcomeId))
    .map((entry) => entry.outcomeId);

  recordOutcomeLabels(sql, { labeler: input.labeler, labels: known, now: input.now });
  return {
    stored: known.length,
    unknown,
    disagreements: known.filter((entry) => entry.label !== predicted.get(entry.outcomeId)).length,
  };
}

// ── The report ───────────────────────────────────────────────────

/** One classifier verdict, what the ledger holds of it, and what the gold
 *  labels found it to really be. */
export interface CalibrationStratum {
  predicted: TurnOutcome;
  /** Classifier-graded ledger rows carrying this verdict. */
  population: number;
  /** Usable gold labels drawn from them (`unclear` excluded). */
  labeled: number;
  /** How the labeler actually judged those, by outcome. */
  actual: Array<{ outcome: TurnOutcome; count: number }>;
}

/** The corrected correction rate for one scaffold version's turns. */
export interface CalibratedSegment {
  scaffoldVersion: number | null;
  /** Classifier-graded turns this version served, and how many it called
   *  corrected or frustrated. */
  observed: { events: number; population: number };
  /** Null when the ledger has no calibration behind it — see the report's gap. */
  rate: CorrectedRate | null;
}

export interface CalibrationReport {
  /** Classifier-graded turns the profile speaks for. */
  universe: number;
  /** Usable gold labels. */
  labeled: number;
  /** Labels the human marked `unclear`; recorded, then excluded from every
   *  number below. Excluding them assumes they are no more likely to be one
   *  outcome than another, which is worth watching if the count grows. */
  unclear: number;
  /** Labels whose turn is no longer in the ledger, so they inform nothing. */
  orphaned: number;
  labelers: string[];
  lastLabeledAt: number | null;
  strata: CalibrationStratum[];
  /** The classifier's measured error profile, or null with the gap below. */
  accuracy: ClassifierAccuracy | null;
  kappa: KappaEstimate | null;
  /** K_align's correction rate over the classifier-graded ledger, corrected. */
  overall: CorrectedRate | null;
  /** The same, per scaffold version, oldest first. */
  segments: CalibratedSegment[];
  /** Null when everything above is populated; otherwise why it is not. */
  gap: CalibrationGap | null;
}

/**
 * Everything the gold labels establish about the classifier, and everything
 * they correct downstream.
 *
 * The per-version denominators here are the CLASSIFIER-graded turns of each
 * version — deliberately narrower than K_align's own denominator, which also
 * counts turns carrying explicit user verdicts. Those need no correcting, and
 * folding them in would mean applying an error profile to rows that have no
 * error. The two rates therefore answer slightly different questions and are
 * rendered side by side rather than one replacing the other.
 */
export function calibrationReport(sql: SqlExecutor): CalibrationReport {
  const universe = calibrationUniverse(sql);
  const gold = goldLabels(sql);
  const byId = new Map(universe.map((row) => [row.id, row]));

  let unclear = 0;
  let orphaned = 0;
  const labelers = new Set<string>();
  let lastLabeledAt: number | null = null;
  /** predicted verdict → the labeler's verdicts for it. */
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

/** What the classifier reported per scaffold version, oldest first. */
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

/** Per 100 turns, the unit K_align is read in. */
function per100(value: number): string {
  return (value * 100).toFixed(1);
}

function renderRate(rate: CorrectedRate): string {
  return `${per100(rate.corrected.mean)} per 100 turns ` +
    `(95% CI ${per100(rate.corrected.lo)}–${per100(rate.corrected.hi)})` +
    ` — the classifier said ${per100(rate.raw)}, off by ${rate.bias >= 0 ? '+' : ''}${per100(rate.bias)}`;
}

/** The corrected block, printed wherever a corrected number would appear. When
 *  there are no labels it says so in one line and stops — the number is not
 *  approximated, defaulted, or quietly omitted. */
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
      // Judge drift is a distinct hypothesis from judge bias: a profile
      // measured against an older model says nothing about the current one.
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

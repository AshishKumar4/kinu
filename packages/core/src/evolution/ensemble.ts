/**
 * The LLM panel that re-judges the turns the owner already judged — and the
 * pre-registered bar it has to clear before anything may lean on it.
 *
 * calibration.ts buys an error profile for the turn-outcome classifier with
 * ~100 hand labels. That is expensive and it goes stale: the classifier's model
 * changes, the scaffold changes, and a profile measured against last quarter's
 * behaviour says nothing about this quarter's. Re-labeling by hand every time
 * is the honest answer and also the one that does not happen.
 *
 * So: run two independent cross-family judges (providers/judge-model.ts,
 * `selectEnsembleJudges`) blind over the SAME turns the human labeled, and
 * measure how well the panel tracks them. If it tracks them, later
 * recalibrations can be drawn by the panel with a human audit slice over part
 * of it. If it does not, this module says so and the owner keeps labeling.
 * The point is that the answer is measured before it is relied on.
 *
 * Four things are load-bearing.
 *
 *  - **The panel is blind, in the same way the human file is.** Judges see
 *    exactly `renderLabelingEvidence` — the same clipped user message, answer
 *    and follow-up the owner read — and never the classifier's verdict, never
 *    the human's, and never each other's. Any of those would make the panel
 *    agree for reasons that are not the turn.
 *
 *  - **Unanimous or nothing.** Each judge answers alone; agreement is the
 *    ensemble's verdict and a split is `unclear`. There is no tie-break and
 *    deliberately no third judge: a majority vote would convert the panel's
 *    admissions of ignorance into confident answers, and those admissions are
 *    the only reason a two-model panel is worth more than one model.
 *
 *  - **The numbers come from the calibration estimator, not a second one.**
 *    κ is `designWeightedKappa` and the panel's error profile is
 *    `resampledAccuracy` — ppi.ts's own functions, its design weighting, its
 *    point estimate. What changes is only which rater is being scored, and
 *    that the panel's interval is resampled rather than closed-form, because
 *    the panel's verdict varies inside a stratum the closed form assumes it is
 *    constant in. That is measured, not asserted — see `resampledAccuracy`.
 *
 *  - **The bar is stated here, in advance, and not moved.** Thresholds written
 *    after seeing the numbers are not thresholds.
 *
 * ── The pre-registered stand-in bar ──────────────────────────────
 *
 * All three conditions must hold. Each is on a LOWER interval bound, not a
 * point estimate, so a panel judged on 30 turns cannot pass by luck.
 *
 *  1. **κ(human ↔ ensemble) lower 95% bound ≥ 0.60.** Landis & Koch (Biometrics
 *     33:159, 1977) put "substantial" agreement at 0.61 and up. Requiring the
 *     lower bound to clear 0.60 means the data must RULE OUT the panel being
 *     merely moderate, rather than merely be compatible with it being good.
 *
 *  2. **κ(human ↔ ensemble) ≥ κ(human ↔ classifier), on the same turns.** This
 *     is the condition that actually matters and it is not a quality bar, it is
 *     a coherence one. The panel's only job would be to measure the classifier
 *     against the truth. If the panel is no closer to the human than the
 *     classifier already is, then calibrating the classifier against the panel
 *     measures one flawed rater with another equally flawed one, and reports
 *     the difference as an error profile. Both κ are computed over exactly the
 *     turns the panel covered, so the comparison is like for like.
 *
 *  3. **Ensemble sensitivity lower bound ≥ 0.70 AND specificity lower bound
 *     ≥ 0.90, on the negative class** (`corrected`/`frustrated` — what every
 *     rate downstream is really about). These two numbers are what a stand-in
 *     labeler would hand to ppi.ts, and there they appear as the Rogan–Gladen
 *     denominator q̂₁ + q̂₀ − 1. At (0.70, 0.90) that denominator is 0.60, so a
 *     corrected rate drawn through the panel is inflated by at most 1/0.6 ≈
 *     1.67× relative to a perfect labeler — a factor that leaves the interval
 *     readable. Loosen either bound much and the denominator heads for zero,
 *     where ppi.ts's own `uninformative_classifier` gate refuses the number
 *     anyway. The asymmetry between the two is prevalence: negatives are ~15%
 *     of the ledger, so at 0.90 specificity the false positives are already
 *     comparable in count to the true ones, and specificity is the bound that
 *     has to be tight.
 *
 * The bar errs toward more hand-labeling, and by how much is MEASURED rather
 * than hoped: over 200 simulated calibration sets per regime, on a 3,000-row
 * ledger with 15% negatives (`unit-ensemble.test.ts` pins it),
 *
 *   - a panel whose TRUE profile is below the bar passes it 0% of the time, at
 *     both 100 and 300 labels. It does not certify bad panels;
 *   - a panel sitting exactly ON the floor (0.70/0.90) also passes 0% of the
 *     time, because clearing a lower BOUND means beating the threshold by
 *     roughly an interval half-width. At 100 labels a true 0.95/0.99 panel
 *     passes 56% of the time; at 300 labels a true 0.85/0.97 one passes 75%
 *     and a 0.90/0.98 one 97%.
 *
 * That asymmetry is deliberate and is the whole posture: the cost of refusing a
 * good panel is that the owner labels another hundred turns, and the cost of
 * accepting a bad one is every downstream rate quietly acquiring an error
 * nobody measured. It also says how to answer a panel that is genuinely good
 * and keeps being refused — label MORE turns, which tightens the intervals it
 * is judged on. Never a lower bar.
 *
 * Below the bar the report says the panel cannot stand in, and that is the end
 * of it — there is no partial-credit mode and nothing switches on automatically
 * when it passes either. What passing buys is the owner's permission to draw
 * the next calibration set with the panel and audit a slice of it by hand.
 */

import * as v from 'valibot';
import type { LLM, SqlExecutor } from '../types/primitives';
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

/** The pre-registered bar, in one place. Changing a number here changes what
 *  "the panel qualifies" means, so it is a decision, not a tuning knob — see
 *  the module note for what each one is derived from. */
export const STAND_IN_THRESHOLDS = {
  /** Lower 95% bound on κ(human ↔ ensemble). */
  kappa: 0.6,
  /** Lower 95% bound on the panel's negative-class sensitivity. */
  sensitivity: 0.7,
  /** Lower 95% bound on the panel's negative-class specificity. */
  specificity: 0.9,
} as const;

// ── Asking one judge ─────────────────────────────────────────────

/** One member of the panel. `llm` is the seam: production passes a model-backed
 *  completion LLM, tests pass a scripted one, and nothing here knows which. */
export interface EnsembleJudge {
  /** `<provider>/<modelId>` — the row's provenance and the report's key. */
  spec: string;
  llm: LLM;
}

/**
 * The blind judging prompt for one turn.
 *
 * Everything the judge sees of the turn comes from `renderLabelingEvidence`,
 * which is also the only thing the human file shows — so the two raters being
 * compared are answering from identical evidence, by construction rather than
 * by matching two copies of the same formatting. The verdict definitions are
 * the human file's own sentences for the same reason. Nothing in this function
 * has access to the classifier's verdict, the human's, or another judge's.
 */
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

/** The panel verdict a model gave, or null when it answered without one — a
 *  hole in the measurement the caller counts, never an abstention. */
function parseVerdict(raw: string): OutcomeLabel | null {
  const answer = tolerate(() => extractJsonObject(raw), 'malformed-input');
  const parsed = v.safeParse(VerdictSchema, answer);
  return parsed.success ? parsed.output.verdict : null;
}

// ── Running the panel ────────────────────────────────────────────

/** Why the panel cannot be run or read. Reported instead of a number. */
export interface EnsembleGap {
  kind:
    /** No classifier-graded turns at all. */
    | 'no_population'
    /** Nothing hand-labeled, so there is nothing to check the panel against. */
    | 'no_gold_labels'
    /** The owner marked every turn the panel covered `unclear`, so none of them
     *  can score anybody. */
    | 'no_usable_labels'
    /** Fewer than two distinct vendor families available to judge with. */
    | 'too_few_judges'
    /** The panel has not judged the hand-labeled turns yet. */
    | 'not_run';
  /** The judges that were available, for 'too_few_judges'. */
  judges: string[];
}

/** One honest sentence per gap, naming the step that closes it. */
export function describeEnsembleGap(gap: EnsembleGap): string {
  switch (gap.kind) {
    case 'no_population':
      return 'no classifier-graded turns yet — the classifier grades a turn once the user follows up';
    case 'no_gold_labels':
      return 'no hand labels yet, so there is nothing to check the panel against — draw a set with ' +
        '`proteus label export <agent>`, fill it in, then `proteus label ingest <agent> <file>`';
    case 'no_usable_labels':
      return 'every turn the panel covered was hand-labeled `unclear`, so none of them settles anything — ' +
        'label more turns with `proteus label export <agent>`';
    case 'too_few_judges':
      return 'an ensemble needs two models from different vendors and this deployment has ' +
        (gap.judges.length === 0 ? 'none connected' : `only ${gap.judges.join(', ')}`) +
        ' — connect a second vendor, or name both judges explicitly';
    case 'not_run':
      return 'the panel has not judged these turns yet — run `proteus label ensemble <agent>`';
  }
}

export interface EnsembleRun {
  /** Verdicts stored, per judge. */
  judged: Array<{ model: string; stored: number; failed: number }>;
  /** Turns put to the panel this run. */
  turns: number;
  /** Verdicts already on file from an earlier run, so not paid for again. */
  alreadyJudged: number;
}

export type EnsembleRunResult =
  | { run: EnsembleRun; gap: null }
  | { run: null; gap: EnsembleGap };

/** Hand-labeled turns still in the ledger, as the blind items a rater sees. */
function goldLabeledItems(universe: ReadonlyArray<UniverseRow>, sql: SqlExecutor): LabelingItem[] {
  const gold = goldLabels(sql);
  return universe.filter((row) => gold.has(row.id)).map(labelingItem);
}

/**
 * The panel, in the two stages it really has.
 *
 * Choosing WHICH models judge is free — a spec is a string. Turning a spec into
 * a judge resolves a model, which reaches the signed-in session and the stored
 * provider keys. Collapsing the two put that credential requirement ahead of
 * both free preconditions below, so `proteus label ensemble` answered "Not
 * authenticated" to a workspace whose real missing step was hand labels, and to
 * a one-model panel that could never have run at all. The order is decided here,
 * once, for every backend.
 */
export interface EnsemblePanel {
  specs(): Promise<readonly string[]>;
  judge(spec: string): EnsembleJudge;
}

/**
 * Put every hand-labeled turn to every judge, and store what comes back.
 *
 * Turns a judge has already answered are skipped, and each verdict is written
 * the moment it lands rather than in a batch at the end, so a pass that is
 * interrupted — a rate limit, an evicted Durable Object, a closed laptop —
 * keeps every model call it already paid for and the next run tops up from
 * there. At two judges over a hundred turns that is two hundred calls; losing
 * them to a retry is the difference between an affordable command and one
 * nobody runs twice.
 *
 * A judge that answers unusably on a turn simply has no row for it; that turn
 * then has no unanimous panel verdict and drops out of the report, counted
 * rather than quietly treated as an abstention — an unreadable answer is not
 * the same finding as a disagreement. A failed CALL is neither: it propagates,
 * so a rate limit stops the run instead of being recorded as a hundred
 * unusable answers, and the next run resumes from the rows already stored.
 */
export async function runEnsemble(
  sql: SqlExecutor,
  panel: EnsemblePanel,
  opts: { now?: number } = {},
): Promise<EnsembleRunResult> {
  // Prerequisites in the order the owner would fix them: a ledger, then labels
  // to score the panel against, then models to be the panel. A deployment
  // missing all three should be told about the labels first — that is the step
  // the whole flow is about, and the one that is free to check.
  const universe = calibrationUniverse(sql);
  if (universe.length === 0) return { run: null, gap: { kind: 'no_population', judges: [] } };
  const items = goldLabeledItems(universe, sql);
  if (items.length === 0) return { run: null, gap: { kind: 'no_gold_labels', judges: [] } };
  const specs = await panel.specs();
  if (specs.length < 2) {
    return { run: null, gap: { kind: 'too_few_judges', judges: [...specs] } };
  }
  const judges = specs.map((spec) => panel.judge(spec));

  const done = new Set(ensembleLabels(sql).map((row) => `${row.outcomeId}\n${row.model}`));
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
      recordEnsembleLabels(sql, {
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

/** One judge's blind verdict on one turn, or null when it answered unusably.
 *  Exported because the behavioural corpus (behavior-labels.ts) scores the same
 *  panel over different turns, and a second copy of "ask, parse" would be a
 *  second place for the prompt and the parse to drift apart. */
export async function askEnsembleJudge(
  judge: EnsembleJudge,
  item: LabelingItem,
): Promise<OutcomeLabel | null> {
  return parseVerdict(await judge.llm.complete(buildEnsembleJudgePrompt(item)));
}

/** The panel's verdict for one turn: what every judge said, or `unclear` when
 *  they did not all say the same thing. Null only for an empty panel, which has
 *  no verdict to give. A judge MISSING an answer is the caller's business —
 *  that is a hole in the measurement, not an abstention. */
export function panelVerdict(perJudge: ReadonlyArray<OutcomeLabel>): OutcomeLabel | null {
  if (perJudge.length === 0) return null;
  return perJudge.every((label) => label === perJudge[0]) ? perJudge[0] : 'unclear';
}

// ── The report ───────────────────────────────────────────────────

/** One turn every rater has an opinion about — the unit every number in the
 *  report is computed over. */
export interface ComparedTurn {
  /** The classifier's verdict — and the stratum the turn was sampled from. */
  predicted: TurnOutcome;
  /** The owner's verdict. `unclear` gold labels are excluded upstream: they are
   *  not ground truth, so they cannot score anybody. */
  human: TurnOutcome;
  ensemble: OutcomeLabel;
  /** Each judge's own verdict, in the report's model order, for the per-member
   *  agreement. Always complete — a turn any judge missed is not compared. */
  perJudge: ReadonlyArray<OutcomeLabel>;
}

export interface EnsembleMember {
  model: string;
  /** Turns this judge returned a usable verdict for. */
  labeled: number;
  /** This judge alone against the owner, over the compared turns. */
  kappa: KappaEstimate | null;
}

export interface StandInCondition {
  /** The pre-registered condition, in the words of the module note. */
  name: string;
  met: boolean;
  /** What the data actually said, whether or not it cleared the bar. */
  detail: string;
}

export interface EnsembleReport {
  members: EnsembleMember[];
  /** Hand-labeled turns still in the ledger. */
  gold: number;
  /** Of those, turns every judge answered — the panel's coverage. */
  covered: number;
  /** Of the covered turns, how many the judges split on. */
  split: number;
  /** Turns every number below is computed over: covered, minus the ones the
   *  owner marked `unclear`. */
  compared: number;
  /** Cohen's κ per rater pair, all over the compared turns so they can be read
   *  against each other. */
  kappa: {
    humanEnsemble: KappaEstimate | null;
    humanClassifier: KappaEstimate | null;
    ensembleClassifier: KappaEstimate | null;
  };
  /** The panel's verdict against the owner's, cell by cell. */
  confusion: Array<{ ensemble: OutcomeLabel; human: TurnOutcome; count: number }>;
  /** The panel's error profile on the negative class, through the same
   *  estimator the classifier's own profile comes from. */
  accuracy: ClassifierAccuracy | null;
  /** Whether the panel cleared the pre-registered bar, condition by condition. */
  standIn: { qualified: boolean; conditions: StandInCondition[] } | null;
  /** Null when everything above is populated; otherwise why it is not. */
  gap: EnsembleGap | null;
}

/** A panel label counts as the event when it is one of the negative outcomes.
 *  `unclear` therefore counts as "did not flag it" — the conservative reading,
 *  and the right one: a stand-in labeler that abstains on a bad turn has failed
 *  to catch it, exactly as if it had called the turn fine. Exported so the
 *  behavioural corpus scores its raters on the same convention. */
export function flagsNegative(label: OutcomeLabel): boolean {
  return label !== 'unclear' && isNegativeOutcome(label);
}

/**
 * The panel's draws, per sampling stratum, for `resampledAccuracy`.
 *
 * The sample was stratified on the CLASSIFIER's verdict, so that — not the
 * panel's — is the stratum a draw belongs to and the unit the bootstrap
 * resamples within. A stratum with population but no compared turns is emitted
 * empty, so the profile reports its `unlabeled_strata` gap by name instead of
 * silently dropping that stratum's weight out of the denominator.
 *
 * Exported so the simulation in `unit-ensemble.test.ts` can measure the
 * resulting intervals against a known truth rather than assert them in prose.
 * Nothing else builds these.
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

/** The κ strata for one rater pair: the sampling design (classifier verdict,
 *  weighted by its ledger population) carrying one verdict pair per draw. */
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
 * Everything the panel's pass established, and whether it clears the bar.
 *
 * Every number is computed over the turns all three raters covered, so the two
 * κ that condition 2 compares are about the same turns. That makes this κ for
 * the classifier a different number from the calibration report's, which uses
 * every gold label — the report says which turns it speaks for.
 */
export function ensembleReport(sql: SqlExecutor): EnsembleReport {
  const universe = calibrationUniverse(sql);
  const byId = new Map(universe.map((row) => [row.id, row]));
  const gold = goldLabels(sql);
  const rows = ensembleLabels(sql);

  const models = [...new Set(rows.map((row) => row.model))].sort();
  /** Verdicts on turns the ledger still holds — a judge's rows about turns that
   *  have since aged out inform nothing and are not counted as coverage. */
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
      .filter((v): v is OutcomeLabel => v !== undefined);
    // A judge with no answer for this turn leaves a hole; the panel has no
    // verdict for it and it is not counted as covered.
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
      // Each judge alone against the owner, over the same compared turns as the
      // panel — so a member that beats the panel it belongs to is visible.
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

/** The panel block, printed wherever the calibration report is. An unrun or
 *  uncalibrated panel says which step is missing in one line and stops — the
 *  same honest-nulls rule the calibration report follows. */
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

/** The pre-registered bar, applied. Every condition reports what it saw, so a
 *  failing panel says how far off it is rather than just "no". */
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

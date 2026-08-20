/**
 * The judge panel: what it is shown, how it votes, what it refuses to say, and
 * whether it clears the pre-registered stand-in bar.
 *
 * No live model calls anywhere — every judge is a scripted LLM at the `LLM`
 * seam, which is the same seam production passes a model-backed one through.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import {
  initTurnOutcomeTables, recordTurnOutcome, recordOutcomeLabels, recordEnsembleLabels,
  ensembleLabels, type OutcomeLabel, type TurnOutcome,
} from '../src/evolution/outcomes';
import {
  buildEnsembleJudgePrompt, describeEnsembleGap, ensembleReport, panelStrata, panelVerdict,
  renderEnsembleReport, runEnsemble, STAND_IN_THRESHOLDS,
  type ComparedTurn, type EnsembleJudge, type EnsemblePanel,
} from '../src/evolution/ensemble';
import { allocateLabelBudget, renderLabelingFile } from '../src/evolution/calibration';
import {
  classifierAccuracy, resampledAccuracy,
  type AccuracyStratum, type ClassifierAccuracy, type PredictionStratum,
} from '../src/evolution/ppi';
import { seededRandom } from '../src/utils/stats';
import type { LLM } from '../src/types/primitives';

type Sql = ReturnType<typeof makeSql>;

/** An already-built panel as an EnsemblePanel. Real backends resolve a judge's
 *  model lazily — that is the point of the two stages — but a scripted judge
 *  costs nothing, so these hand it back directly. */
function panelOf(judges: ReadonlyArray<EnsembleJudge>): EnsemblePanel {
  return {
    async specs() { return judges.map((j) => j.spec); },
    judge(spec) { return judges.find((j) => j.spec === spec)!; },
  };
}

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db), sql);
  return { db, sql };
}

/** A ledger shaped like a real one: mostly accepted, a minority corrected, a
 *  few frustrated. Turn ids are recoverable from the message text so a scripted
 *  judge can answer per turn without ever being told which turn it is. */
function seedLedger(sql: Sql, spec: { accepted?: number; corrected?: number; frustrated?: number }): void {
  let n = 0;
  for (const outcome of ['accepted', 'corrected', 'frustrated'] as const) {
    for (let i = 0; i < (spec[outcome] ?? 0); i++) {
      recordTurnOutcome(sql, {
        turnId: `turn-${outcome}-${i}`,
        outcome,
        confidence: 0.8,
        source: 'classifier',
        userMessage: `request ${outcome} ${i}`,
        assistantResponse: `answer ${outcome} ${i}`,
        followup: `follow-up ${outcome} ${i}`,
        scaffoldVersion: 1,
        now: 1_700_000_000_000 + n++ * 60_000,
      });
    }
  }
}

interface LedgerRow { id: string; outcome: TurnOutcome; user_message: string }
interface PromptTurn { verdict: TurnOutcome; index: number }

function rows(sql: Sql): LedgerRow[] {
  return sql<LedgerRow>`SELECT id, outcome, user_message FROM turn_outcomes ORDER BY created_at, id`;
}

/** Hand-label every turn, choosing each verdict from the classifier's own. */
function labelAll(sql: Sql, choose: (row: LedgerRow, i: number) => OutcomeLabel): void {
  recordOutcomeLabels(sql, {
    labeler: 'owner',
    labels: rows(sql).map((row, i) => ({ outcomeId: row.id, label: choose(row, i) })),
    now: 1_700_100_000_000,
  });
}

/** A judge that answers from the prompt text alone — the only thing a real one
 *  gets. `null` makes it fail the way an outage would. */
function judge(spec: string, answer: (prompt: string) => OutcomeLabel | null): EnsembleJudge {
  const llm: LLM = {
    async *stream() { yield ''; },
    async complete(prompt: string) {
      const label = answer(prompt);
      if (label === null) throw new Error('judge unavailable');
      return JSON.stringify({ verdict: label });
    },
  };
  return { spec, llm };
}

/** Read a judge's prompt back to the seeded turn it is about — the test's own
 *  key into its fixture, never something a real judge would be shown. */
function turnOfPrompt(prompt: string): PromptTurn {
  const match = /request (accepted|corrected|frustrated) (\d+)/.exec(prompt);
  if (!match) throw new Error(`no seeded turn in prompt: ${prompt.slice(0, 120)}`);
  const verdict = match[1];
  const index = match[2];
  if (!verdict || !index) throw new Error('seeded turn match omitted a capture');
  if (verdict !== 'accepted' && verdict !== 'corrected' && verdict !== 'frustrated') {
    throw new Error(`invalid seeded verdict: ${verdict}`);
  }
  return { verdict, index: Number(index) };
}

// ── Blindness ────────────────────────────────────────────────────

describe('the judging prompt', () => {
  const item = {
    outcomeId: 'outc-1',
    userMessage: 'fix the parser',
    assistantResponse: 'done',
    followup: 'no, still broken',
    createdAt: 1_700_000_000_000,
  };

  test('shows the evidence and nothing that could anchor the answer', () => {
    const prompt = buildEnsembleJudgePrompt(item);
    expect(prompt).toContain('fix the parser');
    expect(prompt).toContain('no, still broken');
    // The only outcome words are the verdict legend's, exactly as in the human
    // file. The evidence itself carries none.
    const evidence = prompt.slice(prompt.indexOf('USER  ('), prompt.indexOf('Verdicts:'));
    for (const word of ['accepted', 'corrected', 'frustrated', 'abandoned', 'unclear']) {
      expect(evidence).not.toContain(word);
    }
  });

  test('cannot see the classifier or the human, because it is a function of the turn alone', () => {
    // Two ledgers where the SAME turn is classified and hand-labeled
    // differently. Identical prompts is the structural proof of blindness:
    // there is no path from either verdict into the text.
    const build = (outcome: TurnOutcome, label: OutcomeLabel): string => {
      const { sql } = setup();
      recordTurnOutcome(sql, {
        turnId: 't', outcome, confidence: 0.8, source: 'classifier',
        userMessage: item.userMessage, assistantResponse: item.assistantResponse,
        followup: item.followup, scaffoldVersion: 1, now: item.createdAt,
      });
      const id = rows(sql)[0].id;
      recordOutcomeLabels(sql, { labeler: 'owner', labels: [{ outcomeId: id, label }], now: 1 });
      return buildEnsembleJudgePrompt({ ...item, outcomeId: id });
    };
    expect(build('accepted', 'accepted')).toBe(build('frustrated', 'corrected'));
  });

  test('gives the judges the same verdict definitions the human file gives', () => {
    const prompt = buildEnsembleJudgePrompt(item);
    const file = renderLabelingFile([item]);
    for (const help of ['the user moved on, or built on the answer', 'you genuinely cannot tell from what is here']) {
      expect(prompt).toContain(help);
      expect(file).toContain(help);
    }
  });

  test('carries the same clipped evidence the human file does', () => {
    const long = { ...item, assistantResponse: 'x'.repeat(9000) };
    expect(buildEnsembleJudgePrompt(long)).toContain('[truncated]');
    expect(buildEnsembleJudgePrompt(long).length).toBeLessThan(3000);
  });
});

// ── Voting ───────────────────────────────────────────────────────

describe('the panel rule', () => {
  test('unanimity is the verdict and a split is unclear', () => {
    expect(panelVerdict(['corrected', 'corrected'])).toBe('corrected');
    expect(panelVerdict(['corrected', 'accepted'])).toBe('unclear');
    expect(panelVerdict(['unclear', 'unclear'])).toBe('unclear');
    expect(panelVerdict([])).toBeNull();
  });
});

// ── Refusals ─────────────────────────────────────────────────────

describe('running the panel', () => {
  const always = (spec: string, label: OutcomeLabel): EnsembleJudge => judge(spec, () => label);

  test('refuses without hand labels, and names the steps that produce them', async () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 10, corrected: 4 });
    const { run, gap } = await runEnsemble(sql, panelOf([always('a/1', 'accepted'), always('b/1', 'accepted')]));
    expect(run).toBeNull();
    expect(gap?.kind).toBe('no_gold_labels');
    const said = describeEnsembleGap(gap!);
    expect(said).toContain('kinu label export');
    expect(said).toContain('kinu label ingest');
  });

  test('refuses on an empty ledger, and refuses to be a panel of one', async () => {
    const { sql } = setup();
    expect((await runEnsemble(sql, panelOf([always('a/1', 'accepted'), always('b/1', 'accepted')]))).gap?.kind)
      .toBe('no_population');
    seedLedger(sql, { accepted: 4 });
    labelAll(sql, () => 'accepted');
    const { gap } = await runEnsemble(sql, panelOf([always('a/1', 'accepted')]));
    expect(gap?.kind).toBe('too_few_judges');
    expect(describeEnsembleGap(gap!)).toContain('two models from different vendors');
    expect(ensembleLabels(sql)).toHaveLength(0);
  });

  test('judges every hand-labeled turn once per model, and tops up rather than repeating', async () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 6, corrected: 3 });
    labelAll(sql, () => 'accepted');
    const judges = [always('a/1', 'accepted'), always('b/1', 'accepted')];

    const first = await runEnsemble(sql, panelOf(judges));
    expect(first.run?.turns).toBe(9);
    expect(first.run?.judged).toEqual([
      { model: 'a/1', stored: 9, failed: 0 },
      { model: 'b/1', stored: 9, failed: 0 },
    ]);
    expect(ensembleLabels(sql)).toHaveLength(18);

    // Nothing new to say about turns already judged.
    const again = await runEnsemble(sql, panelOf(judges));
    expect(again.run?.alreadyJudged).toBe(18);
    expect(again.run?.judged.every((j) => j.stored === 0)).toBe(true);
    expect(ensembleLabels(sql)).toHaveLength(18);

    // A fresh labeling pass brings new turns, and only those.
    seedLedger(sql, { frustrated: 2 });
    labelAll(sql, () => 'frustrated');
    const third = await runEnsemble(sql, panelOf(judges));
    expect(third.run?.judged.every((j) => j.stored === 2)).toBe(true);
  });

  test('a judge outage propagates instead of being recorded as unusable answers', async () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 4, corrected: 2 });
    labelAll(sql, () => 'accepted');
    const flaky = judge('b/1', (prompt) => turnOfPrompt(prompt).verdict === 'corrected' ? null : 'accepted');
    // A failed CALL is not a verdict. Counting it as one would report a rate
    // limit as a panel that read every turn and could not make sense of any.
    await expect(runEnsemble(sql, panelOf([always('a/1', 'accepted'), flaky]))).rejects.toThrow('judge unavailable');

    // Every call already paid for is durable, so the next run tops up from here
    // rather than re-billing the whole panel.
    const stored = ensembleLabels(sql);
    expect(stored.filter((row) => row.model === 'a/1')).toHaveLength(6);
    expect(stored.filter((row) => row.model === 'b/1').length).toBeLessThan(6);
    expect(ensembleReport(sql).gold).toBe(6);
  });

  test('an unusable answer is not stored as a guess', async () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 3 });
    labelAll(sql, () => 'accepted');
    const babbling: EnsembleJudge = {
      spec: 'b/1',
      llm: { async *stream() { yield ''; }, async complete() { return 'it seemed fine to me'; } },
    };
    const { run } = await runEnsemble(sql, panelOf([judge('a/1', () => 'accepted'), babbling]));
    expect(run?.judged[1]).toEqual({ model: 'b/1', stored: 0, failed: 3 });
    expect(ensembleLabels(sql).every((row) => row.model === 'a/1')).toBe(true);
  });

  test('writes each verdict as it lands, not in a batch at the end', async () => {
    // Two hundred model calls is a real bill. A pass that dies partway must
    // keep what it paid for, which it only does if the writes are incremental.
    const { sql } = setup();
    seedLedger(sql, { accepted: 5 });
    labelAll(sql, () => 'accepted');
    const seenMidRun: number[] = [];
    const watcher = judge('b/1', () => {
      seenMidRun.push(ensembleLabels(sql).filter((row) => row.model === 'b/1').length);
      return 'accepted';
    });
    await runEnsemble(sql, panelOf([judge('a/1', () => 'accepted'), watcher]));
    // Each of b's calls sees every verdict b gave before it.
    expect(seenMidRun).toEqual([0, 1, 2, 3, 4]);
  });

  test('stores one dated row per model per turn, append-only', async () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 2 });
    labelAll(sql, () => 'accepted');
    await runEnsemble(sql, panelOf([judge('a/1', () => 'accepted'), judge('b/1', () => 'corrected')]), { now: 5 });
    expect(ensembleLabels(sql).map((r) => ({ model: r.model, label: r.label, createdAt: r.createdAt })).sort(
      (x, y) => x.model.localeCompare(y.model) || x.label.localeCompare(y.label),
    )).toEqual([
      { model: 'a/1', label: 'accepted', createdAt: 5 },
      { model: 'a/1', label: 'accepted', createdAt: 5 },
      { model: 'b/1', label: 'corrected', createdAt: 5 },
      { model: 'b/1', label: 'corrected', createdAt: 5 },
    ]);

    // A later pass wins without erasing the earlier one.
    const id = rows(sql)[0].id;
    recordEnsembleLabels(sql, { model: 'a/1', labels: [{ outcomeId: id, label: 'frustrated' }], now: 9 });
    expect(ensembleLabels(sql).find((r) => r.outcomeId === id && r.model === 'a/1')?.label).toBe('frustrated');
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM outcome_ensemble_labels`[0].n).toBe(5);
  });
});

// ── The report ───────────────────────────────────────────────────

/** Seed a ledger, hand-label it, and have the panel answer per turn. */
async function panelOver(spec: {
  ledger: { accepted?: number; corrected?: number; frustrated?: number };
  human: (row: LedgerRow, i: number) => OutcomeLabel;
  says: (turn: { verdict: TurnOutcome; index: number }, which: 0 | 1) => OutcomeLabel;
}): Promise<Sql> {
  const { sql } = setup();
  seedLedger(sql, spec.ledger);
  labelAll(sql, spec.human);
  await runEnsemble(sql, panelOf([
    judge('anthropic/one', (p) => spec.says(turnOfPrompt(p), 0)),
    judge('codex/two', (p) => spec.says(turnOfPrompt(p), 1)),
  ]));
  return sql;
}

describe('the panel report', () => {
  test('a panel that reproduces the owner exactly clears every condition', async () => {
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });
    const report = ensembleReport(sql);
    expect(report.gap).toBeNull();
    expect(report.compared).toBe(300);
    expect(report.split).toBe(0);
    expect(report.kappa.humanEnsemble?.value).toBeCloseTo(1, 10);
    expect(report.standIn?.qualified).toBe(true);
    expect(report.standIn?.conditions.every((c) => c.met)).toBe(true);
    expect(renderEnsembleReport(report)).toContain('CLEARS the pre-registered bar');
  });

  test('a panel that always says "accepted" scores ~0 and is told so plainly', async () => {
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: () => 'accepted',
    });
    const report = ensembleReport(sql);
    expect(report.kappa.humanEnsemble?.value).toBeCloseTo(0, 6);
    // It flags nothing, so it catches none of the negatives.
    expect(report.accuracy?.sensitivity.mean).toBeCloseTo(0, 10);
    expect(report.standIn?.qualified).toBe(false);
    const rendered = renderEnsembleReport(report);
    expect(rendered).toContain('CANNOT stand in');
    expect(rendered).toContain('no  ');
  });

  test('a panel no better than the classifier fails the coherence condition', async () => {
    // The panel simply echoes the classifier. κ(you↔panel) then equals
    // κ(you↔classifier) exactly, which passes condition 2 by a hair — so the
    // interesting case is the panel that echoes it WORSE.
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      // The owner disagrees with the classifier on a third of the corrections.
      human: (row, i) => row.outcome === 'corrected' && i % 3 === 0 ? 'accepted' : row.outcome,
      says: (turn) => turn.verdict === 'frustrated' ? 'accepted' : turn.verdict,
    });
    const report = ensembleReport(sql);
    const coherence = report.standIn?.conditions[1];
    expect(coherence?.met).toBe(false);
    expect(coherence?.detail).toContain('panel');
    expect(report.kappa.humanEnsemble!.value).toBeLessThan(report.kappa.humanClassifier!.value);
  });

  test('splits become unclear, are counted, and cost the panel its recall', async () => {
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      // The two judges never agree about frustration.
      says: (turn, which) =>
        turn.verdict === 'frustrated' && which === 1 ? 'corrected' : turn.verdict,
    });
    const report = ensembleReport(sql);
    expect(report.split).toBe(40);
    expect(report.confusion).toContainEqual({ ensemble: 'unclear', human: 'frustrated', count: 40 });
    // An abstention on a bad turn is a miss, not a neutral outcome.
    expect(report.accuracy!.sensitivity.mean).toBeLessThan(1);
    expect(report.accuracy!.sensitivity.mean).toBeGreaterThan(0.5);
  });

  test('the classifier κ is measured over the panel’s own turns, so the two compare', async () => {
    const sql = await panelOver({
      ledger: { accepted: 120, corrected: 40, frustrated: 20 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });
    const report = ensembleReport(sql);
    // Both raters are perfect on these turns, so both κ are 1 — the point is
    // that they are computed from the same `compared` set.
    expect(report.kappa.humanClassifier?.n).toBe(report.kappa.humanEnsemble?.n);
    expect(report.kappa.ensembleClassifier?.n).toBe(report.compared);
    expect(renderEnsembleReport(report)).toContain('same turns, so the two compare');
  });

  test('scores each judge on its own, so a panel worse than its members shows', async () => {
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn, which) => which === 0 ? turn.verdict : 'accepted',
    });
    const report = ensembleReport(sql);
    expect(report.members.map((m) => m.model)).toEqual(['anthropic/one', 'codex/two']);
    expect(report.members[0].kappa!.value).toBeCloseTo(1, 10);
    expect(report.members[1].kappa!.value).toBeCloseTo(0, 6);
    expect(report.kappa.humanEnsemble!.value).toBeLessThan(report.members[0].kappa!.value);
  });
});

// ── Honest nulls ─────────────────────────────────────────────────

describe('an unmeasured panel', () => {
  test('says which step is missing instead of a number', () => {
    const { sql } = setup();
    expect(renderEnsembleReport(ensembleReport(sql))).toContain('no classifier-graded turns yet');

    seedLedger(sql, { accepted: 8, corrected: 2 });
    expect(renderEnsembleReport(ensembleReport(sql))).toContain('kinu label export');

    labelAll(sql, () => 'accepted');
    const unrun = ensembleReport(sql);
    expect(unrun.standIn).toBeNull();
    expect(unrun.gap?.kind).toBe('not_run');
    expect(renderEnsembleReport(unrun)).toContain('kinu label ensemble');
  });

  test('every turn hand-labeled unclear is named as such, not called a failure', async () => {
    const sql = await panelOver({
      ledger: { accepted: 6, corrected: 2 },
      human: () => 'unclear',
      says: () => 'accepted',
    });
    const report = ensembleReport(sql);
    expect(report.covered).toBe(8);
    expect(report.compared).toBe(0);
    expect(report.gap?.kind).toBe('no_usable_labels');
    expect(renderEnsembleReport(report)).toContain('none of them settles anything');
  });
});

// ── What the numbers are worth ───────────────────────────────────

/**
 * A synthetic ledger whose TRUE negative rate and whose TWO raters' true error
 * profiles are known by construction, plus the stratified gold draw
 * calibration.ts really performs. The only honest way to check an estimator is
 * to ask it for an answer that is already known.
 */
function syntheticDraw(spec: { panelSensitivity: number; panelSpecificity: number; budget: number; seed: number }) {
  const random = seededRandom(spec.seed);
  const rows = Array.from({ length: 3000 }, () => {
    const negative = random() < 0.15;
    // The classifier is the one the sample is stratified on: 60% sensitive,
    // 95% specific — roughly what the real one measures at.
    const classifierFlags = negative ? random() < 0.6 : random() >= 0.95;
    const predicted: TurnOutcome = classifierFlags
      ? (random() < 0.7 ? 'corrected' : 'frustrated')
      : 'accepted';
    return {
      negative,
      predicted,
      panelFlags: negative ? random() < spec.panelSensitivity : random() >= spec.panelSpecificity,
    };
  });

  const byVerdict = new Map<TurnOutcome, typeof rows>();
  for (const row of rows) {
    const bucket = byVerdict.get(row.predicted) ?? [];
    bucket.push(row);
    byVerdict.set(row.predicted, bucket);
  }
  const verdicts = [...byVerdict.keys()];
  const quotas = allocateLabelBudget(verdicts.map((v) => byVerdict.get(v)!.length), spec.budget);
  const compared: ComparedTurn[] = [];
  verdicts.forEach((verdict, i) => {
    const bucket = byVerdict.get(verdict)!;
    const take = Math.min(quotas[i], bucket.length);
    // Systematic, so the draw spans the stratum rather than a corner of it.
    for (let j = 0; j < take; j++) {
      const row = bucket[Math.floor(((j + 0.5) * bucket.length) / take)];
      compared.push({
        predicted: row.predicted,
        human: row.negative ? 'corrected' : 'accepted',
        ensemble: row.panelFlags ? 'corrected' : 'accepted',
        perJudge: [],
      });
    }
  });
  return panelStrata(compared, new Map(verdicts.map((v) => [v, byVerdict.get(v)!.length])));
}

function profiles(spec: { panelSensitivity: number; panelSpecificity: number; budget: number; reps: number }) {
  return Array.from({ length: spec.reps }, (_, i) => {
    const accuracy = resampledAccuracy(
      syntheticDraw({ ...spec, seed: 4000 + i }),
      { iterations: 300 },
    ).accuracy;
    return accuracy === null ? [] : [accuracy];
  }).flat();
}

describe('the panel’s error profile, against a known truth', () => {
  test('recovers the panel’s true sensitivity and specificity without bias', () => {
    const drawn = profiles({ panelSensitivity: 0.85, panelSpecificity: 0.97, budget: 100, reps: 60 });
    const mean = (pick: (a: (typeof drawn)[number]) => number): number =>
      drawn.reduce((sum, a) => sum + pick(a), 0) / drawn.length;
    expect(mean((a) => a.sensitivity.mean)).toBeCloseTo(0.85, 1);
    expect(mean((a) => a.specificity.mean)).toBeCloseTo(0.97, 2);
  });

  test('the resampled interval covers far better than the closed form it replaces', () => {
    // The panel's verdict varies inside a stratum the closed form assumes it is
    // constant in, so the closed form's delta method treats two halves of one
    // sample as independent and reports an interval that is much too narrow.
    // This is the measurement that chose the bootstrap; see ppi.ts's note.
    const truth = { sensitivity: 0.7, specificity: 0.9 };
    const strata = Array.from({ length: 120 }, (_, i) =>
      syntheticDraw({ panelSensitivity: truth.sensitivity, panelSpecificity: truth.specificity, budget: 100, seed: 4000 + i }));

    const covers = (accuracy: ClassifierAccuracy | null): boolean =>
      accuracy !== null &&
      accuracy.sensitivity.lo <= truth.sensitivity && truth.sensitivity <= accuracy.sensitivity.hi &&
      accuracy.specificity.lo <= truth.specificity && truth.specificity <= accuracy.specificity.hi;

    const resampledCoverage = strata.filter((s) => covers(resampledAccuracy(s, { iterations: 300 }).accuracy)).length / strata.length;
    const closedFormCoverage = strata.filter((s) => covers(classifierAccuracy(splitForClosedForm(s)).accuracy)).length / strata.length;

    expect(resampledCoverage).toBeGreaterThan(0.85);
    expect(resampledCoverage).toBeGreaterThan(closedFormCoverage + 0.1);
  });

  test('a rater that never slipped is not reported as certain', () => {
    // Every resample of a clean stratum returns exactly 1, so the percentile
    // interval alone would be [1, 1] — a claim of certainty from forty draws.
    const clean = resampledAccuracy([
      { key: 'accepted', population: 800, draws: Array.from({ length: 40 }, () => ({ predictedEvent: false, event: false })) },
      { key: 'corrected', population: 200, draws: Array.from({ length: 40 }, () => ({ predictedEvent: true, event: true })) },
    ]).accuracy;
    expect(clean?.specificity.mean).toBeCloseTo(1, 10);
    expect(clean?.specificity.lo).toBeLessThan(1);
    expect(clean?.sensitivity.lo).toBeLessThan(1);
    expect(clean?.specificity.se).toBeGreaterThan(0);
  });
});

/** The closed form applied to the same split — what `resampledAccuracy` would
 *  do if it kept `classifierAccuracy`'s interval instead of resampling. Only
 *  the test above builds this, to measure what that would have cost. */
function splitForClosedForm(strata: ReadonlyArray<AccuracyStratum>): PredictionStratum[] {
  return strata.flatMap((stratum) => [true, false].flatMap((predictedEvent) => {
    const cell = stratum.draws.filter((draw) => draw.predictedEvent === predictedEvent);
    return cell.length === 0 ? [] : [{
      key: `${stratum.key}/${predictedEvent}`,
      predictedEvent,
      population: (stratum.population * cell.length) / stratum.draws.length,
      labeled: cell.length,
      events: cell.filter((draw) => draw.event).length,
    }];
  }));
}

describe('the bar’s operating characteristic', () => {
  const clears = (accuracy: ClassifierAccuracy): boolean =>
    accuracy.sensitivity.lo >= STAND_IN_THRESHOLDS.sensitivity &&
    accuracy.specificity.lo >= STAND_IN_THRESHOLDS.specificity;

  test('never certifies a panel whose true profile is below it', () => {
    // The failure that would matter: a bad panel waved through, after which
    // every corrected rate quietly carries an error nobody measured.
    for (const below of [
      { panelSensitivity: 0.5, panelSpecificity: 0.85 },
      { panelSensitivity: 0.6, panelSpecificity: 0.9 },
    ]) {
      const passed = profiles({ ...below, budget: 100, reps: 60 }).filter(clears).length;
      expect(passed).toBe(0);
    }
  });

  test('a genuinely good panel does clear it, and more labels make that likelier', () => {
    const good = { panelSensitivity: 0.95, panelSpecificity: 0.99 };
    const at100 = profiles({ ...good, budget: 100, reps: 60 });
    const at300 = profiles({ ...good, budget: 300, reps: 40 });
    const rate = (drawn: typeof at100): number => drawn.filter(clears).length / drawn.length;
    expect(rate(at100)).toBeGreaterThan(0.5);
    expect(rate(at300)).toBeGreaterThanOrEqual(rate(at100));
  });
});

// ── The bar itself ───────────────────────────────────────────────

describe('the pre-registered bar', () => {
  test('is stated in the conditions it prints, at the values the module fixes', async () => {
    const sql = await panelOver({
      ledger: { accepted: 100, corrected: 30, frustrated: 20 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });
    const printed = renderEnsembleReport(ensembleReport(sql));
    expect(printed).toContain(STAND_IN_THRESHOLDS.kappa.toFixed(2));
    expect(printed).toContain(STAND_IN_THRESHOLDS.sensitivity.toFixed(2));
    expect(printed).toContain(STAND_IN_THRESHOLDS.specificity.toFixed(2));
  });

  test('a respectable panel still fails on the bound, not on the point estimate', async () => {
    // Catches half the negatives and calls one accepted turn in ten bad.
    // Respectable, and nowhere near good enough to label on the owner's behalf.
    const sql = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict === 'accepted'
        ? (turn.index % 10 === 0 ? 'corrected' : 'accepted')
        : (turn.index % 2 === 0 ? 'accepted' : turn.verdict),
    });
    const report = ensembleReport(sql);
    const recall = report.standIn!.conditions[2];
    expect(recall.met).toBe(false);
    expect(recall.detail).toMatch(/recall ≥ 0\.\d\d, specificity ≥ 0\.\d\d/);
    // The point estimate is the honest middle; the bound is what the bar reads.
    expect(report.accuracy!.sensitivity.lo).toBeLessThan(report.accuracy!.sensitivity.mean);
    expect(report.accuracy!.sensitivity.mean).toBeGreaterThan(0.4);
  });
});

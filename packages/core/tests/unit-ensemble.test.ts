/** The judge panel: its prompt, vote, refusals, and the pre-registered stand-in bar. Judges are scripted at the `LLM` seam. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { present, testActorHandle } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';
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

/** Scripted judges are free, so the lazy model stage is skipped. */
function panelOf(judges: ReadonlyArray<EnsembleJudge>): EnsemblePanel {
  return {
    async specs() { return judges.map((j) => j.spec); },
    judge(spec) { return present(judges.find((j) => j.spec === spec), `a judge for ${spec}`); },
  };
}

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db));

  // A real bound handle, since the ledger is actor-scoped.
  return { db, sql, actor: testActorHandle(sql) };
}

/** Mostly accepted, some corrected, a few frustrated. Turn ids are recoverable from
 *  message text so a scripted judge can answer per turn without being told. */
function seedLedger(
  sql: Sql, actor: ActorHandle, spec: { accepted?: number; corrected?: number; frustrated?: number },
): void {
  let n = 0;

  for (const outcome of ['accepted', 'corrected', 'frustrated'] as const) {
    for (let i = 0; i < (spec[outcome] ?? 0); i++) {
      recordTurnOutcome(sql, actor, {
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
function labelAll(sql: Sql, actor: ActorHandle, choose: (row: LedgerRow, i: number) => OutcomeLabel): void {
  recordOutcomeLabels(sql, actor, {
    labeler: 'owner',
    labels: rows(sql).map((row, i) => ({ outcomeId: row.id, label: choose(row, i) })),
    now: 1_700_100_000_000,
  });
}

/** Answers from the prompt text alone; `null` fails like an outage. */
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

/** The test's own key into its fixture, never shown to a judge. */
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
    // The only outcome words are the verdict legend's.
    const evidence = prompt.slice(prompt.indexOf('USER  ('), prompt.indexOf('Verdicts:'));

    for (const word of ['accepted', 'corrected', 'frustrated', 'abandoned', 'unclear']) {
      expect(evidence).not.toContain(word);
    }
  });

  test('cannot see the classifier or the human, because it is a function of the turn alone', () => {
    // Identical prompts across differing verdicts prove blindness.
    const build = (outcome: TurnOutcome, label: OutcomeLabel): string => {
      const { sql, actor } = setup();
      recordTurnOutcome(sql, actor, {
        turnId: 't', outcome, confidence: 0.8, source: 'classifier',
        userMessage: item.userMessage, assistantResponse: item.assistantResponse,
        followup: item.followup, scaffoldVersion: 1, now: item.createdAt,
      });
      const id = rows(sql)[0].id;
      recordOutcomeLabels(sql, actor, { labeler: 'owner', labels: [{ outcomeId: id, label }], now: 1 });

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

describe('the panel rule', () => {
  test('unanimity is the verdict and a split is unclear', () => {
    expect(panelVerdict(['corrected', 'corrected'])).toBe('corrected');
    expect(panelVerdict(['corrected', 'accepted'])).toBe('unclear');
    expect(panelVerdict(['unclear', 'unclear'])).toBe('unclear');
    expect(panelVerdict([])).toBeNull();
  });
});

describe('running the panel', () => {
  const always = (spec: string, label: OutcomeLabel): EnsembleJudge => judge(spec, () => label);

  test('refuses without hand labels, and names the steps that produce them', async () => {
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 10, corrected: 4 });
    const { run, gap } = await runEnsemble(sql, actor, panelOf([always('a/1', 'accepted'), always('b/1', 'accepted')]));
    expect(run).toBeNull();
    expect(gap?.kind).toBe('no_gold_labels');
    const said = describeEnsembleGap(present(gap, 'the ensemble gap'));
    expect(said).toContain('kinu label export');
    expect(said).toContain('kinu label ingest');
  });

  test('refuses on an empty ledger, and refuses to be a panel of one', async () => {
    const { sql, actor } = setup();
    expect((await runEnsemble(sql, actor, panelOf([always('a/1', 'accepted'), always('b/1', 'accepted')]))).gap?.kind)
      .toBe('no_population');
    seedLedger(sql, actor, { accepted: 4 });
    labelAll(sql, actor, () => 'accepted');
    const { gap } = await runEnsemble(sql, actor, panelOf([always('a/1', 'accepted')]));
    expect(gap?.kind).toBe('too_few_judges');
    expect(describeEnsembleGap(present(gap, 'the ensemble gap'))).toContain('two models from different vendors');
    expect(ensembleLabels(sql, actor)).toHaveLength(0);
  });

  test('judges every hand-labeled turn once per model, and tops up rather than repeating', async () => {
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 6, corrected: 3 });
    labelAll(sql, actor, () => 'accepted');
    const judges = [always('a/1', 'accepted'), always('b/1', 'accepted')];

    const first = await runEnsemble(sql, actor, panelOf(judges));
    expect(first.run?.turns).toBe(9);
    expect(first.run?.judged).toEqual([
      { model: 'a/1', stored: 9, failed: 0 },
      { model: 'b/1', stored: 9, failed: 0 },
    ]);
    expect(ensembleLabels(sql, actor)).toHaveLength(18);

    // Nothing new to say about turns already judged.
    const again = await runEnsemble(sql, actor, panelOf(judges));
    expect(again.run?.alreadyJudged).toBe(18);
    expect(again.run?.judged.every((j) => j.stored === 0)).toBe(true);
    expect(ensembleLabels(sql, actor)).toHaveLength(18);

    // A fresh labeling pass brings new turns, and only those.
    seedLedger(sql, actor, { frustrated: 2 });
    labelAll(sql, actor, () => 'frustrated');
    const third = await runEnsemble(sql, actor, panelOf(judges));
    expect(third.run?.judged.every((j) => j.stored === 2)).toBe(true);
  });

  test('a judge outage propagates instead of being recorded as unusable answers', async () => {
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 4, corrected: 2 });
    labelAll(sql, actor, () => 'accepted');
    const flaky = judge('b/1', (prompt) => turnOfPrompt(prompt).verdict === 'corrected' ? null : 'accepted');
    // A failed call is not a verdict.
    await expect(runEnsemble(sql, actor, panelOf([always('a/1', 'accepted'), flaky]))).rejects.toThrow('judge unavailable');

    // Paid-for calls are durable, so the next run tops up.
    const stored = ensembleLabels(sql, actor);
    expect(stored.filter((row) => row.model === 'a/1')).toHaveLength(6);
    expect(stored.filter((row) => row.model === 'b/1').length).toBeLessThan(6);
    expect(ensembleReport(sql, actor).gold).toBe(6);
  });

  test('an unusable answer is not stored as a guess', async () => {
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 3 });
    labelAll(sql, actor, () => 'accepted');

    const babbling: EnsembleJudge = {
      spec: 'b/1',
      llm: { async *stream() { yield ''; }, async complete() { return 'it seemed fine to me'; } },
    };

    const { run } = await runEnsemble(sql, actor, panelOf([judge('a/1', () => 'accepted'), babbling]));
    expect(run?.judged[1]).toEqual({ model: 'b/1', stored: 0, failed: 3 });
    expect(ensembleLabels(sql, actor).every((row) => row.model === 'a/1')).toBe(true);
  });

  test('writes each verdict as it lands, not in a batch at the end', async () => {
    // A pass that dies partway keeps what it paid for: writes are incremental.
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 5 });
    labelAll(sql, actor, () => 'accepted');
    const seenMidRun: number[] = [];

    const watcher = judge('b/1', () => {
      seenMidRun.push(ensembleLabels(sql, actor).filter((row) => row.model === 'b/1').length);

      return 'accepted';
    });

    await runEnsemble(sql, actor, panelOf([judge('a/1', () => 'accepted'), watcher]));
    // Each of b's calls sees every verdict b gave before it.
    expect(seenMidRun).toEqual([0, 1, 2, 3, 4]);
  });

  test('stores one dated row per model per turn, append-only', async () => {
    const { sql, actor } = setup();
    seedLedger(sql, actor, { accepted: 2 });
    labelAll(sql, actor, () => 'accepted');
    await runEnsemble(sql, actor, panelOf([judge('a/1', () => 'accepted'), judge('b/1', () => 'corrected')]), { now: 5 });
    expect(ensembleLabels(sql, actor).map((r) => ({ model: r.model, label: r.label, createdAt: r.createdAt })).sort(
      (x, y) => x.model.localeCompare(y.model) || x.label.localeCompare(y.label),
    )).toEqual([
      { model: 'a/1', label: 'accepted', createdAt: 5 },
      { model: 'a/1', label: 'accepted', createdAt: 5 },
      { model: 'b/1', label: 'corrected', createdAt: 5 },
      { model: 'b/1', label: 'corrected', createdAt: 5 },
    ]);

    // A later pass wins without erasing the earlier one.
    const id = rows(sql)[0].id;
    recordEnsembleLabels(sql, actor, { model: 'a/1', labels: [{ outcomeId: id, label: 'frustrated' }], now: 9 });
    expect(ensembleLabels(sql, actor).find((r) => r.outcomeId === id && r.model === 'a/1')?.label).toBe('frustrated');
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM outcome_ensemble_labels`[0].n).toBe(5);
  });
});

/** Seed a ledger, hand-label it, and have the panel answer per turn. */
async function panelOver(spec: {
  ledger: { accepted?: number; corrected?: number; frustrated?: number };
  human: (row: LedgerRow, i: number) => OutcomeLabel;
  says: (turn: { verdict: TurnOutcome; index: number }, which: 0 | 1) => OutcomeLabel;
}): Promise<{ readonly sql: Sql; readonly actor: ActorHandle }> {
  const { sql, actor } = setup();
  seedLedger(sql, actor, spec.ledger);
  labelAll(sql, actor, spec.human);
  await runEnsemble(sql, actor, panelOf([
    judge('anthropic/one', (p) => spec.says(turnOfPrompt(p), 0)),
    judge('codex/two', (p) => spec.says(turnOfPrompt(p), 1)),
  ]));

  return { sql, actor };
}

describe('the panel report', () => {
  test('a panel that reproduces the owner exactly clears every condition', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });

    const report = ensembleReport(sql, actor);
    expect(report.gap).toBeNull();
    expect(report.compared).toBe(300);
    expect(report.split).toBe(0);
    expect(report.kappa.humanEnsemble?.value).toBeCloseTo(1, 10);
    expect(report.standIn?.qualified).toBe(true);
    expect(report.standIn?.conditions.every((c) => c.met)).toBe(true);
    expect(renderEnsembleReport(report)).toContain('CLEARS the pre-registered bar');
  });

  test('a panel that always says "accepted" scores ~0 and is told so plainly', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: () => 'accepted',
    });

    const report = ensembleReport(sql, actor);
    expect(report.kappa.humanEnsemble?.value).toBeCloseTo(0, 6);
    // It flags nothing, so it catches none of the negatives.
    expect(report.accuracy?.sensitivity.mean).toBeCloseTo(0, 10);
    expect(report.standIn?.qualified).toBe(false);
    const rendered = renderEnsembleReport(report);
    expect(rendered).toContain('CANNOT stand in');
    expect(rendered).toContain('no  ');
  });

  test('a panel no better than the classifier fails the coherence condition', async () => {
    // An echoing panel passes condition 2 by a hair; the interesting case echoes it worse.
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      // The owner disagrees with the classifier on a third of the corrections.
      human: (row, i) => row.outcome === 'corrected' && i % 3 === 0 ? 'accepted' : row.outcome,
      says: (turn) => turn.verdict === 'frustrated' ? 'accepted' : turn.verdict,
    });

    const report = ensembleReport(sql, actor);
    const coherence = report.standIn?.conditions[1];
    expect(coherence?.met).toBe(false);
    expect(coherence?.detail).toContain('panel');
    const humanEnsemble = present(report.kappa.humanEnsemble, 'the human-ensemble κ').value;
    const humanClassifier = present(report.kappa.humanClassifier, 'the human-classifier κ').value;

    expect(humanEnsemble).toBeLessThan(humanClassifier);
  });

  test('splits become unclear, are counted, and cost the panel its recall', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      // The two judges never agree about frustration.
      says: (turn, which) =>
        turn.verdict === 'frustrated' && which === 1 ? 'corrected' : turn.verdict,
    });

    const report = ensembleReport(sql, actor);
    expect(report.split).toBe(40);
    expect(report.confusion).toContainEqual({ ensemble: 'unclear', human: 'frustrated', count: 40 });
    // An abstention on a bad turn is a miss.
    const accuracy = present(report.accuracy, 'the panel accuracy');

    expect(accuracy.sensitivity.mean).toBeLessThan(1);
    expect(accuracy.sensitivity.mean).toBeGreaterThan(0.5);
  });

  test('the classifier κ is measured over the panel’s own turns, so the two compare', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 120, corrected: 40, frustrated: 20 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });

    const report = ensembleReport(sql, actor);
    // Both κ come from the same `compared` set.
    expect(report.kappa.humanClassifier?.n).toBe(report.kappa.humanEnsemble?.n);
    expect(report.kappa.ensembleClassifier?.n).toBe(report.compared);
    expect(renderEnsembleReport(report)).toContain('same turns, so the two compare');
  });

  test('scores each judge on its own, so a panel worse than its members shows', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn, which) => which === 0 ? turn.verdict : 'accepted',
    });

    const report = ensembleReport(sql, actor);
    expect(report.members.map((m) => m.model)).toEqual(['anthropic/one', 'codex/two']);
    const firstMember = present(report.members[0].kappa, 'the first member κ');

    expect(firstMember.value).toBeCloseTo(1, 10);
    expect(present(report.members[1].kappa, 'the second member κ').value).toBeCloseTo(0, 6);
    expect(present(report.kappa.humanEnsemble, 'the human-ensemble κ').value).toBeLessThan(firstMember.value);
  });
});

describe('an unmeasured panel', () => {
  test('says which step is missing instead of a number', () => {
    const { sql, actor } = setup();
    expect(renderEnsembleReport(ensembleReport(sql, actor))).toContain('no classifier-graded turns yet');

    seedLedger(sql, actor, { accepted: 8, corrected: 2 });
    expect(renderEnsembleReport(ensembleReport(sql, actor))).toContain('kinu label export');

    labelAll(sql, actor, () => 'accepted');
    const unrun = ensembleReport(sql, actor);
    expect(unrun.standIn).toBeNull();
    expect(unrun.gap?.kind).toBe('not_run');
    expect(renderEnsembleReport(unrun)).toContain('kinu label ensemble');
  });

  test('every turn hand-labeled unclear is named as such, not called a failure', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 6, corrected: 2 },
      human: () => 'unclear',
      says: () => 'accepted',
    });

    const report = ensembleReport(sql, actor);
    expect(report.covered).toBe(8);
    expect(report.compared).toBe(0);
    expect(report.gap?.kind).toBe('no_usable_labels');
    expect(renderEnsembleReport(report)).toContain('none of them settles anything');
  });
});

/** A synthetic ledger with known truth and two raters' known error profiles, drawn
 *  as calibration.ts draws. */
function syntheticDraw(spec: { panelSensitivity: number; panelSpecificity: number; budget: number; seed: number }) {
  const random = seededRandom(spec.seed);

  const population = Array.from({ length: 3000 }, () => {
    const negative = random() < 0.15;
    // The stratifying classifier: 60% sensitive, 95% specific.
    const classifierFlags = negative ? random() < 0.6 : random() >= 0.95;
    let predicted: TurnOutcome = 'accepted';

    if (classifierFlags) predicted = random() < 0.7 ? 'corrected' : 'frustrated';

    return {
      negative,
      predicted,
      panelFlags: negative ? random() < spec.panelSensitivity : random() >= spec.panelSpecificity,
    };
  });

  const byVerdict = new Map<TurnOutcome, typeof population>();

  for (const row of population) {
    const bucket = byVerdict.get(row.predicted) ?? [];
    bucket.push(row);
    byVerdict.set(row.predicted, bucket);
  }

  const strata = [...byVerdict];
  const quotas = allocateLabelBudget(strata.map(([, bucket]) => bucket.length), spec.budget);
  const compared: ComparedTurn[] = [];

  for (const [i, [, bucket]] of strata.entries()) {
    const take = Math.min(quotas[i], bucket.length);

    // Systematic, so the draw spans the stratum.
    for (let j = 0; j < take; j++) {
      const row = bucket[Math.floor(((j + 0.5) * bucket.length) / take)];
      compared.push({
        predicted: row.predicted,
        human: row.negative ? 'corrected' : 'accepted',
        ensemble: row.panelFlags ? 'corrected' : 'accepted',
        perJudge: [],
      });
    }
  }

  return panelStrata(compared, new Map(strata.map(([verdict, bucket]) => [verdict, bucket.length])));
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
    // The panel varies within a stratum, so the closed form's interval is too narrow;
    // this is the measurement that chose the bootstrap.
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
    // The percentile interval alone would be [1, 1] from forty draws.
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

/** The closed form on the same split, built only to measure its cost. */
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
    // A bad panel waved through is the failure that matters.
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

describe('the pre-registered bar', () => {
  test('is stated in the conditions it prints, at the values the module fixes', async () => {
    const { sql, actor } = await panelOver({
      ledger: { accepted: 100, corrected: 30, frustrated: 20 },
      human: (row) => row.outcome,
      says: (turn) => turn.verdict,
    });

    const printed = renderEnsembleReport(ensembleReport(sql, actor));
    expect(printed).toContain(STAND_IN_THRESHOLDS.kappa.toFixed(2));
    expect(printed).toContain(STAND_IN_THRESHOLDS.sensitivity.toFixed(2));
    expect(printed).toContain(STAND_IN_THRESHOLDS.specificity.toFixed(2));
  });

  test('a respectable panel still fails on the bound, not on the point estimate', async () => {
    // Catches half the negatives and calls one accepted turn in ten bad: not good enough.
    const { sql, actor } = await panelOver({
      ledger: { accepted: 200, corrected: 60, frustrated: 40 },
      human: (row) => row.outcome,
      says: (turn) => {
        if (turn.verdict === 'accepted') return turn.index % 10 === 0 ? 'corrected' : 'accepted';

        return turn.index % 2 === 0 ? 'accepted' : turn.verdict;
      },
    });

    const report = ensembleReport(sql, actor);
    const recall = present(report.standIn, 'the stand-in verdict').conditions[2];
    const accuracy = present(report.accuracy, 'the panel accuracy');

    expect(recall.met).toBe(false);
    expect(recall.detail).toMatch(/recall ≥ 0\.\d\d, specificity ≥ 0\.\d\d/);
    // The bar reads the bound, not the point estimate.
    expect(accuracy.sensitivity.lo).toBeLessThan(accuracy.sensitivity.mean);
    expect(accuracy.sensitivity.mean).toBeGreaterThan(0.4);
  });
});

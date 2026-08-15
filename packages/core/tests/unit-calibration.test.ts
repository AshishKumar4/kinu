/**
 * The calibration set: how it is drawn, how it is presented, how verdicts come
 * back, and what the report says with and without them.
 *
 * No LLM calls — the ledger is written directly, the way the classifier would
 * have written it.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import {
  initTurnOutcomeTables, recordTurnOutcome, recordOutcomeLabels, listOutcomeLabels, goldLabels,
  type TurnOutcome, type OutcomeLabel,
} from '../src/evolution/outcomes.js';
import {
  allocateLabelBudget, calibrationReport, parseLabelingFile, renderCalibrationReport,
  renderLabelingFile, sampleForLabeling,
} from '../src/evolution/calibration.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db), sql);
  return { db, sql };
}

/** A ledger shaped like a real one: mostly accepted, a few corrections, fewer
 *  frustrations, spread over time and across two scaffold versions. */
function seedLedger(sql: ReturnType<typeof makeSql>, spec: {
  accepted?: number; corrected?: number; frustrated?: number;
  source?: 'classifier' | 'explicit'; version?: number; startAt?: number;
} = {}): void {
  const start = spec.startAt ?? 1_700_000_000_000;
  let n = 0;
  const write = (outcome: TurnOutcome, count: number): void => {
    for (let i = 0; i < count; i++) {
      recordTurnOutcome(sql, {
        turnId: `turn-${spec.version ?? 1}-${outcome}-${i}`,
        outcome,
        confidence: 0.8,
        source: spec.source ?? 'classifier',
        userMessage: `request ${outcome} ${i}`,
        assistantResponse: `answer ${outcome} ${i}`,
        followup: `follow-up ${outcome} ${i}`,
        scaffoldVersion: spec.version ?? 1,
        now: start + n++ * 60_000,
      });
    }
  };
  write('accepted', spec.accepted ?? 0);
  write('corrected', spec.corrected ?? 0);
  write('frustrated', spec.frustrated ?? 0);
}

/** Read back the classifier's verdict for a turn, so a test can label items
 *  agreeing or disagreeing with it on purpose. */
function predictionOf(sql: ReturnType<typeof makeSql>, outcomeId: string): TurnOutcome {
  return sql<{ outcome: TurnOutcome }>`SELECT outcome FROM turn_outcomes WHERE id = ${outcomeId}`[0].outcome;
}

type OutcomeLabelInput = Parameters<typeof recordOutcomeLabels>[1]['labels'][number];

function outcomeLabel(outcomeId: string, label: OutcomeLabel): OutcomeLabelInput {
  return { outcomeId, label };
}

// ── Budget allocation ────────────────────────────────────────────

describe('allocateLabelBudget', () => {
  test('spends the whole budget and never a label more', () => {
    // Rounding each share independently overshoots; a quota nobody asked for
    // is as wrong as one that goes missing.
    for (const sizes of [[1600, 260, 90], [50, 50], [100, 40, 20], [7, 11, 13, 17], [999, 1]]) {
      for (const budget of [10, 37, 60, 100, 137]) {
        const quotas = allocateLabelBudget(sizes, budget);
        const drawn = quotas.reduce((a, b) => a + b, 0);
        expect(`${sizes}/${budget}: ${drawn}`).toBe(`${sizes}/${budget}: ${Math.min(budget, sizes.reduce((a, b) => a + b, 0))}`);
        expect(quotas.every((q, i) => q >= 0 && q <= sizes[i])).toBe(true);
      }
    }
  });

  test('every verdict gets a real block, and the majority one gets the most', () => {
    const [accepted, corrected, frustrated] = allocateLabelBudget([1600, 260, 90], 100);
    expect(frustrated).toBeGreaterThan(10);
    expect(corrected).toBeGreaterThan(10);
    expect(accepted).toBeGreaterThan(corrected);
    // Not fully proportional either — a proportional split would leave the
    // rarest verdict about 5 labels, which measures nothing.
    expect(frustrated).toBeGreaterThan(Math.round((100 * 90) / 1950));
  });

  test('never asks a verdict for more rows than it has, and re-spends the rest', () => {
    const quotas = allocateLabelBudget([2000, 3], 100);
    expect(quotas[1]).toBe(3);
    expect(quotas[0]).toBe(97);
  });

  test('a ledger smaller than the budget is drawn whole', () => {
    expect(allocateLabelBudget([12, 4], 100)).toEqual([12, 4]);
  });

  test('degenerate inputs allocate nothing rather than throwing', () => {
    expect(allocateLabelBudget([], 100)).toEqual([]);
    expect(allocateLabelBudget([0, 0], 100)).toEqual([0, 0]);
    expect(allocateLabelBudget([10, 10], 0)).toEqual([0, 0]);
  });
});

// ── The draw ─────────────────────────────────────────────────────

describe('sampleForLabeling', () => {
  test('stratifies across verdicts instead of drowning in the majority one', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 800, corrected: 130, frustrated: 45 });
    const items = sampleForLabeling(sql, { size: 100 });

    expect(items).toHaveLength(100);
    const verdicts = items.map((item) => predictionOf(sql, item.outcomeId));
    const share = (outcome: TurnOutcome): number => verdicts.filter((v) => v === outcome).length;
    // Proportional would be ~82/13/5. Every verdict must be genuinely measured.
    expect(share('frustrated')).toBeGreaterThan(12);
    expect(share('corrected')).toBeGreaterThan(12);
    expect(share('accepted')).toBeGreaterThan(share('corrected'));
  });

  test('spreads across the ledger in time rather than taking a corner of it', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 400 });
    const times = sampleForLabeling(sql, { size: 40 }).map((item) => item.createdAt).sort((a, b) => a - b);
    const span = 399 * 60_000;
    // First and last draws sit near the ends of the ledger's whole history.
    expect(times[0] - 1_700_000_000_000).toBeLessThan(span * 0.1);
    expect(times[times.length - 1] - 1_700_000_000_000).toBeGreaterThan(span * 0.9);
  });

  test('only draws turns the classifier graded', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 30, corrected: 10 });
    seedLedger(sql, { accepted: 30, corrected: 10, source: 'explicit', version: 2, startAt: 1_800_000_000_000 });
    recordTurnOutcome(sql, {
      turnId: 'ended', outcome: 'abandoned', confidence: 1, source: 'session_end',
      userMessage: 'u', assistantResponse: 'a', scaffoldVersion: 1, now: 1_900_000_000_000,
    });

    const items = sampleForLabeling(sql, { size: 100 });
    expect(items).toHaveLength(40);
    for (const item of items) {
      const row = sql<{ source: string; outcome: string }>`
        SELECT source, outcome FROM turn_outcomes WHERE id = ${item.outcomeId}`[0];
      expect(row.source).toBe('classifier');
      expect(row.outcome).not.toBe('abandoned');
    }
  });

  test('a second draw tops the set up instead of re-asking', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 60, corrected: 20 });
    const first = sampleForLabeling(sql, { size: 20 });
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: first.map((item) => outcomeLabel(item.outcomeId, 'accepted')),
    });

    const second = sampleForLabeling(sql, { size: 20 });
    const alreadySeen = new Set(first.map((item) => item.outcomeId));
    expect(second).toHaveLength(20);
    expect(second.some((item) => alreadySeen.has(item.outcomeId))).toBe(false);
  });

  test('is deterministic, and an empty ledger draws nothing', () => {
    const { sql } = setup();
    expect(sampleForLabeling(sql, { size: 100 })).toEqual([]);
    seedLedger(sql, { accepted: 50, corrected: 20 });
    expect(sampleForLabeling(sql, { size: 30 })).toEqual(sampleForLabeling(sql, { size: 30 }));
  });

  test('the drawn order does not follow the strata', () => {
    // A file whose items arrive grouped by verdict would leak the answer the
    // labeler is being asked for.
    const { sql } = setup();
    seedLedger(sql, { accepted: 300, corrected: 100, frustrated: 60 });
    const verdicts = sampleForLabeling(sql, { size: 90 }).map((item) => predictionOf(sql, item.outcomeId));
    const runs = verdicts.filter((v, i) => i === 0 || v !== verdicts[i - 1]).length;
    expect(runs).toBeGreaterThan(verdicts.length / 2);
  });
});

// ── The file ─────────────────────────────────────────────────────

describe('the labeling file', () => {
  const items = [
    { outcomeId: 'outc-1', userMessage: 'fix the parser', assistantResponse: 'done', followup: 'no, still broken', createdAt: 1_700_000_000_000 },
    { outcomeId: 'outc-2', userMessage: 'ship it', assistantResponse: 'shipped', followup: null, createdAt: 1_700_000_100_000 },
  ];

  test('never shows the classifier verdict it is asking about', () => {
    const rendered = renderLabelingFile(items);
    expect(rendered).toContain('deliberately NOT shown');
    // The only outcome words present are the legend's, which every item shares.
    const body = rendered.slice(rendered.indexOf('### 1/2'));
    for (const word of ['accepted', 'corrected', 'frustrated', 'abandoned']) {
      expect(body).not.toContain(word);
    }
  });

  test('leads each turn with its verdict slot, so filling it in is one keystroke', () => {
    const block = renderLabelingFile(items).split('### 2/2')[1];
    expect(block.split('\n')[1]).toBe('verdict:');
  });

  test('shows the evidence a verdict needs', () => {
    const rendered = renderLabelingFile(items);
    expect(rendered).toContain('fix the parser');
    expect(rendered).toContain('no, still broken');
    expect(rendered).toContain('(none — the session ended here)');
  });

  test('truncates long turns rather than producing an unreadable file', () => {
    const rendered = renderLabelingFile([{ ...items[0], assistantResponse: 'x'.repeat(9000) }]);
    expect(rendered).toContain('[truncated]');
    expect(rendered.length).toBeLessThan(3000);
  });

  test('round-trips every verdict key', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...items[0], outcomeId: `outc-${i}` }));
    const filled = renderLabelingFile(many)
      .split('\n')
      .reduce<{ lines: string[]; n: number }>((acc, line) => {
        if (line !== 'verdict:') return { ...acc, lines: [...acc.lines, line] };
        return { lines: [...acc.lines, `verdict: ${['a', 'c', 'f', 'b', '?'][acc.n]}`], n: acc.n + 1 };
      }, { lines: [], n: 0 }).lines.join('\n');

    const parsed = parseLabelingFile(filled);
    expect(parsed.errors).toEqual([]);
    expect(parsed.skipped).toBe(0);
    expect(parsed.labels).toEqual([
      { outcomeId: 'outc-0', label: 'accepted' },
      { outcomeId: 'outc-1', label: 'corrected' },
      { outcomeId: 'outc-2', label: 'frustrated' },
      { outcomeId: 'outc-3', label: 'abandoned' },
      { outcomeId: 'outc-4', label: 'unclear' },
    ]);
  });

  test('an untouched file yields nothing, and says how much was skipped', () => {
    const parsed = parseLabelingFile(renderLabelingFile(items));
    expect(parsed.labels).toEqual([]);
    expect(parsed.skipped).toBe(2);
    expect(parsed.errors).toEqual([]);
  });

  test('accepts an upper-case verdict and stray spacing', () => {
    const parsed = parseLabelingFile('### 1/1 outc-9\nverdict:   C  \n');
    expect(parsed.labels).toEqual([{ outcomeId: 'outc-9', label: 'corrected' }]);
  });

  test('collects every problem instead of losing the pass to the first one', () => {
    const parsed = parseLabelingFile([
      'verdict: a',
      '### 1/2 outc-1',
      'verdict: q',
      '### 2/2 outc-1',
      'verdict: c',
    ].join('\n'));
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[0]).toContain('before any turn');
    expect(parsed.errors[1]).toContain('"q" is not a verdict');
    expect(parsed.errors[2]).toContain('more than once');
  });

  test('a file that is not a labeling file says so', () => {
    expect(parseLabelingFile('some notes I took').errors).toEqual(['no turns found — is this a Proteus labeling file?']);
  });
});

// ── The label ledger ─────────────────────────────────────────────

describe('the gold label ledger', () => {
  test('is append-only: a re-label adds a row and the newest wins', () => {
    const { sql } = setup();
    recordOutcomeLabels(sql, { labeler: 'owner', labels: [{ outcomeId: 'outc-1', label: 'accepted' }], now: 100 });
    recordOutcomeLabels(sql, { labeler: 'owner', labels: [{ outcomeId: 'outc-1', label: 'corrected' }], now: 200 });

    expect(listOutcomeLabels(sql)).toHaveLength(2);
    expect(goldLabels(sql).get('outc-1')?.label).toBe('corrected');
  });

  test('carries who labeled and when', () => {
    const { sql } = setup();
    recordOutcomeLabels(sql, {
      labeler: 'ashish',
      labels: [{ outcomeId: 'outc-2', label: 'frustrated' }],
      now: 12_345,
    });
    const row = goldLabels(sql).get('outc-2');
    expect(row?.labeler).toBe('ashish');
    expect(row?.createdAt).toBe(12_345);
  });

  test('every label counts, however many passes it took', () => {
    // A windowed read would silently drop the turns the oldest labels speak
    // for, and the estimate would quietly narrow to the recent ones.
    const { sql } = setup();
    for (let pass = 0; pass < 12; pass++) {
      recordOutcomeLabels(sql, {
        labeler: 'owner',
        labels: Array.from({ length: 60 }, (_, i) => outcomeLabel(`outc-${pass}-${i}`, 'accepted')),
        now: 1000 + pass,
      });
    }
    expect(goldLabels(sql).size).toBe(720);
    expect(listOutcomeLabels(sql, 10)).toHaveLength(10);
  });

  test('reads as empty before the table has ever been written', () => {
    const db = new Database(':memory:');
    expect(listOutcomeLabels(makeSql(db))).toEqual([]);
    expect(goldLabels(makeSql(db)).size).toBe(0);
  });
});

// ── The report ───────────────────────────────────────────────────

describe('calibrationReport', () => {
  test('an unlabeled ledger reports uncalibrated, not a number', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 200, corrected: 40, frustrated: 12 });
    const report = calibrationReport(sql);

    expect(report.universe).toBe(252);
    expect(report.labeled).toBe(0);
    expect(report.accuracy).toBeNull();
    expect(report.overall).toBeNull();
    expect(report.kappa).toBeNull();
    expect(report.gap?.kind).toBe('no_labels');
    expect(report.segments.every((s) => s.rate === null)).toBe(true);

    const rendered = renderCalibrationReport(report);
    expect(rendered).toContain('uncalibrated — no hand-labeled turns yet');
    expect(rendered).toContain('252 classifier-graded turns are waiting');
    expect(rendered).toContain('proteus label export');
  });

  test('a partially labeled ledger names the verdict it cannot correct', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 200, corrected: 40, frustrated: 12 });
    const drawn = sampleForLabeling(sql, { size: 200 })
      .filter((item) => predictionOf(sql, item.outcomeId) !== 'frustrated');
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: drawn.map((item) => outcomeLabel(item.outcomeId, 'accepted')),
    });

    const report = calibrationReport(sql);
    expect(report.gap?.kind).toBe('unlabeled_strata');
    expect(report.gap?.strata).toEqual(['frustrated']);
    expect(renderCalibrationReport(report)).toContain('"frustrated"');
  });

  test('labels turn into a measured profile and a corrected rate', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 800, corrected: 130, frustrated: 45 });
    // A classifier that misses corrections: a fifth of what it called
    // "accepted" was really a correction, and it over-called frustration.
    const drawn = sampleForLabeling(sql, { size: 120 });
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: drawn.map((item, i) => {
        const predicted = predictionOf(sql, item.outcomeId);
        if (predicted === 'accepted') {
          return outcomeLabel(item.outcomeId, i % 5 === 0 ? 'corrected' : 'accepted');
        }
        if (predicted === 'frustrated') {
          return outcomeLabel(item.outcomeId, i % 3 === 0 ? 'accepted' : 'frustrated');
        }
        return outcomeLabel(item.outcomeId, 'corrected');
      }),
    });

    const report = calibrationReport(sql);
    expect(report.gap).toBeNull();
    expect(report.labeled).toBe(120);
    expect(report.accuracy).not.toBeNull();
    expect(report.overall).not.toBeNull();
    expect(report.kappa).not.toBeNull();
    expect(report.labelers).toEqual(['owner']);

    // The classifier called 175/975 turns negative; the labels say many more
    // of the "accepted" ones really were.
    expect(report.overall?.raw).toBeCloseTo(175 / 975, 6);
    expect(report.overall?.corrected.mean).toBeGreaterThan(report.overall?.raw ?? 1);
    expect(report.overall?.bias).toBeGreaterThan(0.05);
    expect(report.accuracy?.sensitivity.mean).toBeLessThan(0.8);

    const rendered = renderCalibrationReport(report);
    expect(rendered).toContain('Sensitivity:');
    expect(rendered).toContain("Cohen's κ:");
    expect(rendered).toContain('per 100 turns');
    expect(rendered).toContain('the classifier said');
    // Judge drift: a profile measured months ago says nothing about today's
    // classifier, so the report always dates itself.
    expect(rendered).toMatch(/last on \d{4}-\d{2}-\d{2}/);
  });

  test('unclear verdicts are stored, excluded, and counted out loud', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 100, corrected: 40, frustrated: 20 });
    const drawn = sampleForLabeling(sql, { size: 60 });
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: drawn.map((item, i) => outcomeLabel(
        item.outcomeId,
        i % 6 === 0 ? 'unclear' : predictionOf(sql, item.outcomeId),
      )),
    });

    const report = calibrationReport(sql);
    expect(report.unclear).toBe(10);
    expect(report.labeled).toBe(50);
    expect(listOutcomeLabels(sql)).toHaveLength(60);
    expect(renderCalibrationReport(report)).toContain('10 unclear (excluded)');
  });

  test('a label whose turn is gone informs nothing and is reported as orphaned', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 40, corrected: 20 });
    const drawn = sampleForLabeling(sql, { size: 60 });
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: [
        ...drawn.map((item) => outcomeLabel(item.outcomeId, predictionOf(sql, item.outcomeId))),
        outcomeLabel('outc-vanished', 'corrected'),
      ],
    });

    const report = calibrationReport(sql);
    expect(report.orphaned).toBe(1);
    expect(report.labeled).toBe(60);
  });

  test('turns with an explicit user verdict are left out of the correction', () => {
    // They are already ground truth; folding them in would dilute the measured
    // error profile toward zero.
    const { sql } = setup();
    seedLedger(sql, { accepted: 100, corrected: 30 });
    seedLedger(sql, { accepted: 50, corrected: 50, source: 'explicit', version: 2, startAt: 1_800_000_000_000 });
    expect(calibrationReport(sql).universe).toBe(130);
  });

  test('each scaffold version is corrected from its own observed rate', () => {
    const { sql } = setup();
    seedLedger(sql, { accepted: 200, corrected: 100, version: 1 });
    seedLedger(sql, { accepted: 300, corrected: 30, version: 2, startAt: 1_800_000_000_000 });
    const drawn = sampleForLabeling(sql, { size: 100 });
    recordOutcomeLabels(sql, {
      labeler: 'owner',
      labels: drawn.map((item, i) => outcomeLabel(
        item.outcomeId,
        predictionOf(sql, item.outcomeId) === 'accepted' && i % 4 === 0
          ? 'corrected'
          : predictionOf(sql, item.outcomeId),
      )),
    });

    const report = calibrationReport(sql);
    const [older, newer] = report.segments;
    expect(older.scaffoldVersion).toBe(1);
    expect(newer.scaffoldVersion).toBe(2);
    expect(older.observed).toEqual({ events: 100, population: 300 });
    expect(newer.observed).toEqual({ events: 30, population: 330 });
    // The versions had genuinely different rates, and still do after correction.
    expect(newer.rate?.corrected.mean).toBeLessThan(older.rate?.corrected.mean ?? 0);
    expect(renderCalibrationReport(report)).toContain('By scaffold version');
  });

  test('an empty ledger says so without throwing', () => {
    const { sql } = setup();
    const report = calibrationReport(sql);
    expect(report.universe).toBe(0);
    expect(report.gap?.kind).toBe('no_population');
    expect(renderCalibrationReport(report)).toContain('0 classifier-graded turns');
  });
});

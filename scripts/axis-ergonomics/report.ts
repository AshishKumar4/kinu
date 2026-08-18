/**
 * Score the run files against the pre-registered falsifiers and print the
 * per-axis / per-value tables the report is written from.
 *
 * Separate from `run.ts` on purpose: the scoring must be re-runnable over the
 * saved replies without spending anything, so a scoring bug costs nothing to
 * fix and cannot be confused with a model result. Everything here is
 * mechanical. Nothing is judged, because the one judgement in this study — is
 * this configuration what an expert would write — was made in advance and is
 * sitting in `corpus.ts` as the expert key.
 *
 *   bun scripts/axis-ergonomics/report.ts /tmp/axis-*.json
 */
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { CORPUS, PRESET_REGION, ZOO_EXTRA_CASES, type Case, type Region } from './corpus';
import { AXIS_NAMES, AXIS_VALUES } from './surface';

// The run file is this study's own output, but it is still a file on disk that
// a previous process wrote, so it is parsed rather than trusted.
const ViolationSchema = v.looseObject({
  kind: v.string(),
  rule: v.fallback(v.string(), ''),
  got: v.fallback(v.string(), ''),
  axis: v.fallback(v.string(), ''),
});
const ValidationSchema = v.looseObject({
  legal: v.boolean(),
  violations: v.array(ViolationSchema),
});
const AnswerSchema = v.looseObject({
  decision: v.fallback(v.string(), ''),
  preset: v.fallback(v.nullable(v.string()), null),
  verify: v.fallback(v.nullable(v.string()), null),
  key: v.fallback(v.nullable(v.string()), null),
  axes: v.fallback(v.record(v.string(), v.string()), {}),
  measured: v.fallback(v.nullable(v.string()), null),
  direction: v.fallback(v.nullable(v.string()), null),
  axis_paraphrase: v.fallback(v.record(v.string(), v.string()), {}),
  nowhere_to_put: v.fallback(v.nullable(v.string()), null),
});
const AttemptSchema = v.looseObject({
  raw: v.string(),
  read: v.looseObject({
    parsed: v.boolean(),
    conformed: v.boolean(),
    answer: AnswerSchema,
  }),
  validation: ValidationSchema,
});
const ConfigureSchema = v.looseObject({
  model: v.string(),
  variant: v.string(),
  caseId: v.string(),
  first: AttemptSchema,
  corrected: v.fallback(v.nullable(AttemptSchema), null),
  tokensIn: v.number(),
  tokensOut: v.number(),
});
const NamingSchema = v.looseObject({
  forward: v.array(v.looseObject({
    model: v.string(),
    axis: v.string(),
    read: v.looseObject({
      answer: v.looseObject({
        controls: v.fallback(v.string(), ''),
        values: v.fallback(v.record(v.string(), v.string()), {}),
        confidence: v.fallback(v.string(), ''),
      }),
      unreadable: v.fallback(v.nullable(v.string()), null),
    }),
  })),
  reverse: v.array(v.looseObject({
    model: v.string(),
    axis: v.string(),
    value: v.string(),
    correct: v.boolean(),
    chose: v.string(),
    confidence: v.fallback(v.string(), ''),
  })),
});
const RunFileSchema = v.looseObject({
  models: v.array(v.string()),
  configure: v.array(ConfigureSchema),
  naming: v.array(NamingSchema),
  measuredTokens: v.looseObject({
    configureIn: v.fallback(v.number(), 0),
    configureOut: v.fallback(v.number(), 0),
  }),
});
type RunFile = v.InferOutput<typeof RunFileSchema>;
type ConfigureRow = v.InferOutput<typeof ConfigureSchema>;

const CASE_BY_ID: Readonly<Record<string, Case>> = Object.fromEntries(
  [...CORPUS, ...ZOO_EXTRA_CASES].map((c) => [c.id, c]),
);

/** Which pre-registered falsifier a row trips, or none. Exactly one is reported
 *  per row and the order is deliberate: a hallucinated value makes every later
 *  question unanswerable, and a no-swarm judgement precedes preset choice. */
export type Falsifier = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | null;

export interface Scored {
  readonly model: string;
  readonly variant: string;
  readonly caseId: string;
  readonly group: string;
  readonly chosePreset: string;
  readonly expected: readonly string[];
  readonly presetOk: boolean;
  readonly regionOk: boolean;
  readonly legal: boolean;
  readonly fixedAfterRefusal: boolean | null;
  readonly falsifier: Falsifier;
  /** Hallucinated axis names, verbatim — the strongest naming signal we get. */
  readonly inventedAxes: readonly string[];
  /** Hallucinated values, as `axis:value` — the second strongest. */
  readonly inventedValues: readonly string[];
  /** Required axes the model missed on a genuine-custom case. */
  readonly missedAxes: readonly string[];
  readonly namedMeasurement: boolean;
  /**
   * On a case where no measurement is reachable, the model supplied a `verify`
   * command anyway — a command that cannot exist. This is scored on its own
   * because it decides how much the STATIC refusal is worth: a rule that fires
   * on a missing field cannot fire when the caller invents one to fill it.
   */
  readonly fabricatedVerifier: string;
  readonly nowhereToPut: string;
  /** The reply held the requested contract without repair. */
  readonly conformed: boolean;
  /**
   * The model said ANYTHING parseable. An empty completion is a provider or
   * capacity failure, not a wrong preset, and scoring it as one would hand a
   * model a zero it never earned — absent is not zero. Every accuracy figure
   * below is computed over `replied` rows only, and the non-reply rate is
   * reported beside it as its own number so the reader can see what was lost.
   */
  readonly replied: boolean;
}

function regionOf(preset: string): Region {
  if (preset === 'custom') return 'flat';
  const known = Object.entries(PRESET_REGION).find(([name]) => name === preset);
  return known === undefined ? 'none' : known[1];
}

function score(row: ConfigureRow): Scored | null {
  const c = CASE_BY_ID[row.caseId];
  if (c === undefined) return null;
  const answer = row.first.read.answer;
  const chose = row.first.decision === 'no-swarm' ? 'no-swarm' : (answer.preset ?? 'none');
  const decidedNoSwarm = answer.decision === 'no-swarm';
  const effective = decidedNoSwarm ? 'no-swarm' : (answer.preset ?? 'none');

  const inventedAxes: string[] = [];
  const inventedValues: string[] = [];
  for (const [axis, value] of Object.entries(answer.axes)) {
    const name = AXIS_NAMES.find((a) => a === axis);
    if (name === undefined) { inventedAxes.push(axis); continue; }
    if (!AXIS_VALUES[name].some((known) => known === value)) inventedValues.push(`${axis}:${value}`);
  }

  const missedAxes: string[] = [];
  if (c.expect.requiredAxes !== undefined && effective === 'custom') {
    for (const axis of AXIS_NAMES) {
      const wanted = c.expect.requiredAxes[axis];
      if (wanted === undefined) continue;
      const got = Object.entries(answer.axes).find(([a]) => a === axis)?.[1];
      if (got === undefined || !wanted.some((w) => w === got)) missedAxes.push(axis);
    }
  }

  const presetOk = c.expect.decision === 'no-swarm'
    ? decidedNoSwarm
    : c.expect.presets.some((p) => p === effective);
  const regionOk = c.expect.decision === 'no-swarm'
    ? decidedNoSwarm
    : regionOf(effective) === c.expect.region;
  const legal = row.first.validation.legal;
  const fixedAfterRefusal = legal ? null : (row.corrected?.validation.legal ?? false);

  // One falsifier per row, most-diagnostic first.
  let falsifier: Falsifier = null;
  if (inventedAxes.length > 0 || inventedValues.length > 0) falsifier = 'F5';
  else if (c.expect.decision === 'no-swarm' && !decidedNoSwarm) falsifier = 'F7';
  else if (!legal && fixedAfterRefusal === false) falsifier = 'F6';
  else if (!legal) falsifier = 'F2';
  else if (missedAxes.length > 0) falsifier = 'F4';
  else if (effective === 'custom' && !c.expect.presets.some((p) => p === 'custom')) falsifier = 'F3';
  else if (!regionOk) falsifier = 'F1';

  return {
    model: row.model, variant: row.variant, caseId: row.caseId, group: c.group,
    chosePreset: chose, expected: c.expect.decision === 'no-swarm' ? ['no-swarm'] : c.expect.presets,
    presetOk, regionOk, legal, fixedAfterRefusal, falsifier,
    inventedAxes, inventedValues, missedAxes,
    namedMeasurement: (answer.measured ?? '').trim() !== '' && (answer.direction ?? '').trim() !== '',
    fabricatedVerifier: c.expect.needsScalarObjection === true ? (answer.verify ?? '').trim() : '',
    nowhereToPut: (answer.nowhere_to_put ?? '').trim(),
    conformed: row.first.read.conformed,
    replied: row.first.read.parsed,
  };
}

/** One distinct string and how often it appeared. */
interface Tally {
  readonly text: string;
  readonly n: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(0).padStart(4)}%`;
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: bun scripts/axis-ergonomics/report.ts <run.json>...');
    process.exit(2);
  }
  const runs: RunFile[] = [];
  for (const f of files) {
    try {
      runs.push(v.parse(RunFileSchema, JSON.parse(readFileSync(f, 'utf8'))));
    } catch (error) {
      // Named rather than skipped: a run file that will not parse is a hole in
      // the study, and a report that quietly covered it would be the lie.
      console.error(`SKIPPED ${f}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const rows: Scored[] = runs.flatMap((r) => r.configure.map(score)).filter((s): s is Scored => s !== null);
  if (rows.length === 0) {
    console.error('REFUSED: no scorable rows. Nothing here can be reported.');
    process.exit(1);
  }
  const models = [...new Set(rows.map((r) => r.model))].sort();
  // Every accuracy figure is over rows the model actually answered. An empty
  // completion is a capacity failure, and counting it as a wrong preset would
  // make a flaky endpoint look like an unusable surface.
  const answered = rows.filter((r) => r.replied);

  console.log('\n══ 1. per model — accuracy over ANSWERED rows ═════════════════════════');
  console.log('model                                  ans/n  preset region  legal  conform');
  for (const m of models) {
    const all = rows.filter((r) => r.model === m);
    const mine = all.filter((r) => r.replied);
    console.log(
      `${m.padEnd(38)} ${String(mine.length).padStart(2)}/${String(all.length).padEnd(2)} `
      + `${pct(mine.filter((r) => r.presetOk).length, mine.length)} `
      + `${pct(mine.filter((r) => r.regionOk).length, mine.length)} `
      + `${pct(mine.filter((r) => r.legal).length, mine.length)} `
      + `${pct(mine.filter((r) => r.conformed).length, mine.length)}`,
    );
  }
  const silent = rows.length - answered.length;
  if (silent > 0) {
    console.log(`\n  ${String(silent)} row(s) returned NO parseable reply and are excluded from every figure above:`);
    for (const m of models) {
      const n = rows.filter((r) => r.model === m && !r.replied).length;
      if (n > 0) console.log(`    ${m}: ${String(n)}`);
    }
  }

  console.log('\n══ 2. bare vs glossed — how much the NAMES carry ══════════════════════');
  console.log('model                                  bare  glossed  delta');
  for (const m of models) {
    const bare = answered.filter((r) => r.model === m && r.variant === 'bare');
    const glossed = answered.filter((r) => r.model === m && r.variant === 'glossed');
    const b = bare.length === 0 ? 0 : bare.filter((r) => r.presetOk).length / bare.length;
    const g = glossed.length === 0 ? 0 : glossed.filter((r) => r.presetOk).length / glossed.length;
    console.log(
      `${m.padEnd(38)} ${(100 * b).toFixed(0).padStart(4)}%   ${(100 * g).toFixed(0).padStart(4)}%  `
      + `${(100 * (g - b) >= 0 ? '+' : '')}${(100 * (g - b)).toFixed(0)}pp`,
    );
  }

  console.log('\n══ 3. per case — where the corpus discriminates ═══════════════════════');
  console.log('case                     group      n  preset region  falsifiers');
  for (const c of [...CORPUS, ...ZOO_EXTRA_CASES]) {
    const mine = answered.filter((r) => r.caseId === c.id);
    if (mine.length === 0) continue;
    const fs = mine.map((r) => r.falsifier).filter((f): f is Exclude<Falsifier, null> => f !== null);
    const tally = [...new Set(fs)].sort().map((f) => `${f}x${String(fs.filter((x) => x === f).length)}`).join(' ');
    console.log(
      `${c.id.padEnd(24)} ${c.group.padEnd(9)} ${String(mine.length).padStart(2)} `
      + `${pct(mine.filter((r) => r.presetOk).length, mine.length)} `
      + `${pct(mine.filter((r) => r.regionOk).length, mine.length)}  ${tally}`,
    );
  }

  console.log('\n══ 4. falsifier tally ═════════════════════════════════════════════════');
  for (const f of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'] as const) {
    const hits = answered.filter((r) => r.falsifier === f);
    if (hits.length === 0) { console.log(`${f}  0`); continue; }
    const byModel = models.map((m) => `${m.split('/').pop() ?? m}:${String(hits.filter((h) => h.model === m).length)}`)
      .filter((s) => !s.endsWith(':0')).join(' ');
    console.log(`${f}  ${String(hits.length).padStart(3)}   ${byModel}`);
  }

  console.log('\n══ 5. refusal correction (F6) ═════════════════════════════════════════');
  const refused = answered.filter((r) => !r.legal);
  const fixed = refused.filter((r) => r.fixedAfterRefusal === true);
  console.log(`refused on attempt 1: ${String(refused.length)}   legal on attempt 2: ${String(fixed.length)}  (${pct(fixed.length, refused.length)})`);
  for (const m of models) {
    const mine = refused.filter((r) => r.model === m);
    if (mine.length === 0) continue;
    console.log(`  ${m.padEnd(38)} ${String(mine.filter((r) => r.fixedAfterRefusal === true).length)}/${String(mine.length)}`);
  }

  console.log('\n══ 6. invented vocabulary (F5) — verbatim ═════════════════════════════');
  const axesInvented = answered.flatMap((r) => r.inventedAxes);
  const valuesInvented = answered.flatMap((r) => r.inventedValues);
  const tallyOf = (xs: readonly string[]): Tally[] =>
    [...new Set(xs)].map((x): Tally => ({ text: x, n: xs.filter((y) => y === x).length }))
      .sort((a, b) => b.n - a.n);
  console.log(`axes:   ${axesInvented.length === 0 ? '(none)' : tallyOf(axesInvented).map((t) => `${t.text} x${String(t.n)}`).join(', ')}`);
  console.log(`values: ${valuesInvented.length === 0 ? '(none)' : tallyOf(valuesInvented).map((t) => `${t.text} x${String(t.n)}`).join(', ')}`);

  console.log('\n══ 7. per-VALUE name legibility — reverse probe ═══════════════════════');
  console.log('(mechanism in prose, all 28 pairs flat, name the one meant)');
  const reverse = runs.flatMap((r) => r.naming).flatMap((n) => n.reverse);
  if (reverse.length > 0) {
    console.log('axis:value                  n  correct  what it chose instead');
    for (const axis of AXIS_NAMES) {
      for (const value of AXIS_VALUES[axis]) {
        const mine = reverse.filter((x) => x.axis === axis && x.value === value);
        if (mine.length === 0) continue;
        const wrong = mine.filter((x) => !x.correct).map((x) => x.chose);
        console.log(
          `${`${axis}:${value}`.padEnd(24)} ${String(mine.length).padStart(3)} `
          + `${pct(mine.filter((x) => x.correct).length, mine.length)}   `
          + tallyOf(wrong).slice(0, 3).map((t) => `${t.text === '' ? '(blank)' : t.text} x${String(t.n)}`).join(', '),
        );
      }
    }
    console.log('\n  per axis:');
    for (const axis of AXIS_NAMES) {
      const mine = reverse.filter((x) => x.axis === axis);
      console.log(`  ${axis.padEnd(14)} ${pct(mine.filter((x) => x.correct).length, mine.length)}  (${String(mine.length)} probes)`);
    }
  }

  console.log('\n══ 8. fabricated verifiers — the static refusal\'s blind spot ═════════');
  console.log('(cases with NO reachable measurement: collatz, optimise-no-verifier)');
  const noScalar = answered.filter((r) => {
    const c = CASE_BY_ID[r.caseId];
    return c !== undefined && c.expect.needsScalarObjection === true;
  });
  const madeUp = noScalar.filter((r) => r.fabricatedVerifier !== '');
  console.log(`supplied a verify command anyway: ${String(madeUp.length)}/${String(noScalar.length)} (${pct(madeUp.length, noScalar.length)})`);
  for (const r of madeUp) {
    console.log(`  ${r.model.split('/').pop() ?? r.model} ${r.variant} ${r.caseId}: ${r.fabricatedVerifier.replace(/\s+/g, ' ').slice(0, 110)}`);
  }

  console.log('\n══ 9. objective: did it name what is measured and which way is better ══');
  for (const m of models) {
    const mine = answered.filter((r) => r.model === m);
    console.log(`  ${m.padEnd(38)} ${pct(mine.filter((r) => r.namedMeasurement).length, mine.length)}`);
  }
  const gaps = answered.map((r) => r.nowhereToPut).filter((x) => x !== '' && x.toLowerCase() !== 'null');
  console.log(`\n  "nowhere to put" reported on ${String(gaps.length)}/${String(answered.length)} answered rows. Distinct, most frequent first:`);
  for (const t of tallyOf(gaps).slice(0, 14)) console.log(`   x${String(t.n).padEnd(3)} ${t.text.slice(0, 150)}`);

  const measuredIn = runs.reduce((a, r) => a + r.measuredTokens.configureIn, 0);
  const measuredOut = runs.reduce((a, r) => a + r.measuredTokens.configureOut, 0);
  console.log(`\nmeasured configure tokens across all run files: ${String(measuredIn)} in / ${String(measuredOut)} out`);
}

main();

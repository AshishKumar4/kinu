/**
 * WHAT THE ORACLE BUDGET IS FOR, AND WHERE ITS LAST CALL IS.
 *
 * `exec-ratio` is the only registered verifier kind, so the meter in `exec-ratio.ts`
 * scores every measured swarm run in this repository. Two decisions inside that meter
 * settle whether a candidate is MEASURED or REFUSED, and neither had a test: how much
 * of the reference's spend a candidate is allowed (`BUDGET_MULTIPLE`), and whether the
 * call landing exactly on that allowance is the last one permitted or the first one
 * refused (`OPS > LIMIT`).
 *
 * WHY NO SUITE REACHED THEM. Every other suite measures through a swarm, and a swarm's
 * candidates are either the optimum or the wasteful reference — neither sits near the
 * allowance, and both spend a count that depends on a shuffle. The two readings of each
 * decision differ only for a candidate WORSE than the reference by a stated amount,
 * which is exactly the case the allowance exists for and exactly the case a gradient
 * search never lands on by accident.
 *
 * THE INSTRUMENT IS REAL. Each measurement writes two modules into the workspace VFS and
 * runs node inside the workspace shell, which is what `runRatioMeasurement` does in
 * production. The problems are three-call small, so the whole file is a handful of
 * processes.
 *
 * NOTHING BELOW NAMES THE MULTIPLE. `BUDGET_MULTIPLE` is not exported, and a test
 * restating its value would pass against whatever value it had been edited to. The
 * allowance is DISCOVERED from the instrument's own refusal, which prints the limit it
 * enforced, and every assertion is a relation between that number, the reference's spend
 * and the candidate's — which is what the two decisions mean.
 */
import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers';
import { archiveCellOf } from '../src/strategy/archive';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import { preflightRatioHarness, runRatioMeasurement, SOLUTION_FILE } from '../src/strategy/exec-ratio';
import type { RatioMeasurement } from '../src/strategy/exec-ratio';
import type { Measurement, MeasurementContext } from '../src/strategy/objective';

/**
 * The reference's spend, exactly.
 *
 * Small and EXACT, which is the whole reason this file does not reuse the largest-token
 * task the swarm suites share: that reference's count depends on where a shuffle put the
 * maximum, and a boundary cannot be asserted against a number that moves. Here the
 * reference spends one call per element and answers with the count, so the ground truth
 * and the spend are the same declared number.
 */
const REFERENCE_CALLS = 3;

const REFERENCE = `export function solve(input, oracle) {
  let seen = 0;
  for (let i = 0; i < input.n; i += 1) seen = oracle.step(seen);
  return seen;
}
`;

/** One instance, one metered primitive, and the reference's own answer as ground truth. */
const BODY = `
const oracle = { step: meter((seen) => seen + 1) };
const decode = (out) => (out === undefined || out === null ? null : out);
emitTrials([trial({ n: P.n }, oracle, decode, P.n)]);
`;

/**
 * A candidate that spends exactly `calls` oracle calls and then answers correctly.
 *
 * The spend is the parameter under test and the answer is held RIGHT, so a refusal can
 * only ever be the budget. A candidate that also got the answer wrong would be refused
 * by the correctness gate and prove nothing about the allowance.
 */
function candidateSpending(calls: number): string {
  return `export function solve(input, oracle) {
  let burn = 0;
  for (let i = 0; i < ${String(calls)}; i += 1) burn = oracle.step(burn);
  return input.n;
}
`;
}

/** One real measurement of one candidate, through the production entry point. */
async function measure(source: string): Promise<RatioMeasurement> {
  const { rt } = createTestRuntime();
  const { shell } = rt;
  if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');
  const ctx: MeasurementContext = {
    vfs: rt.storage.vfs,
    exec: (command) => shell.exec(command),
  };
  await rt.storage.vfs.writeFile(SOLUTION_FILE, source);
  return await runRatioMeasurement(ctx, {
    params: { n: REFERENCE_CALLS },
    reference: REFERENCE,
    body: BODY,
    targetOps: REFERENCE_CALLS,
    lowerBoundOps: 1,
  });
}

/** The limit the meter actually enforced, read off its own refusal. */
function enforcedLimit(failure: string | null): number {
  const match = /oracle budget of (\d+) calls exhausted/.exec(failure ?? '');
  if (match?.[1] === undefined) {
    throw new Error(`the refusal did not name the budget it enforced: ${String(failure)}`);
  }
  return Number(match[1]);
}

describe('a candidate worse than the reference is measured, never refused', () => {
  test('the allowance leaves headroom above the reference, and a candidate inside it scores', async () => {
    // THE ALLOWANCE, discovered. A runaway is stopped and the refusal names the number
    // it was stopped at, which is the only place this file learns what the allowance is.
    const runaway = await measure(candidateSpending(REFERENCE_CALLS * 1000));
    expect(runaway.refOps).toBe(REFERENCE_CALLS);
    expect(runaway.correct).toBe(false);
    const limit = enforcedLimit(runaway.failure);

    // THE POLICY, as an inequality rather than a magnitude: the allowance is STRICTLY
    // above what the reference spent. An allowance equal to the reference's own spend
    // makes "worse than the reference" and "runaway" the same verdict — and worse than
    // the reference is a legitimate measurement, because the reference is the baseline
    // the search climbs away from and not a bound on correctness.
    expect(limit).toBeGreaterThan(REFERENCE_CALLS);

    // AND A CANDIDATE INSIDE IT IS SCORED. Twice the reference's calls: worse, correct,
    // and MEASURED at its full spend. `candOps` is the raw quantity the objective ranks
    // on, so refusing this candidate would not merely lose one row — it would delete the
    // whole gradient between the baseline and the target and leave the search scoring
    // only candidates that already beat the reference.
    const worse = await measure(candidateSpending(REFERENCE_CALLS * 2));
    expect(worse.failure).toBeNull();
    expect(worse.correct).toBe(true);
    expect(worse.candOps).toBe(REFERENCE_CALLS * 2);
    expect(worse.candOps).toBeGreaterThan(worse.refOps);
    expect(worse.candOps).toBeLessThanOrEqual(limit);
  }, 60_000);
});

describe('the call landing exactly on the oracle budget is the last one allowed', () => {
  test('a candidate spending exactly its budget is measured; one call past it is refused', async () => {
    // The boundary, from the instrument rather than from arithmetic this file performs:
    // whatever the allowance is, the question is which side of it the last call sits on.
    const probe = await measure(candidateSpending(REFERENCE_CALLS * 1000));
    const limit = enforcedLimit(probe.failure);

    // EXACTLY ON IT. Allowed, correct, and reported at its full spend — a budget of N
    // that refuses the Nth call is a budget of N-1 wearing the wrong number, and the
    // number is what the refusal tells a caller to raise.
    const onBudget = await measure(candidateSpending(limit));
    expect(onBudget.failure).toBeNull();
    expect(onBudget.correct).toBe(true);
    expect(onBudget.candOps).toBe(limit);

    // ONE PAST IT. Refused, and the count reported is the call that broke the budget
    // rather than the spend the candidate intended: the meter counts first and then
    // decides, so a refused candidate's `candOps` is the allowance plus one.
    const overBudget = await measure(candidateSpending(limit + 1));
    expect(overBudget.correct).toBe(false);
    expect(overBudget.failure).toContain('oracle budget');
    expect(overBudget.candOps).toBe(limit + 1);
  }, 60_000);
});

/**
 * THE PREMISE THAT MAKES ONE ENGINE REFUSAL UNREACHABLE, asserted where it belongs.
 *
 * An `advance:'archive'` run checks its `key` twice. Once against the BASELINE's reported
 * quantities, before a candidate exists, refusing a key the instrument does not witness.
 * Once per candidate at the settle barrier, where a candidate it cannot bin is refused as
 * `unwitnessed` — a branch whose own comment says reaching it means "the instrument
 * reported it for the baseline and not for this candidate".
 *
 * With one registered kind those two checks cannot disagree, because the instrument
 * reports the SAME quantity set for the workspace as found and for every candidate. That
 * is a fact about the instrument rather than about the engine, so it is asserted here,
 * beside the instrument, rather than left as a paragraph in the runner. The sweep's
 * `record-refused-cause` entry is retired against this test: if a second verifier kind
 * ever reports a quantity for only one of the two, this goes red and that mutation
 * becomes measurable again instead of quietly reachable.
 */
describe('every quantity the instrument reports is a key an archive can bin', () => {
  test('the workspace as found and a measured candidate report the same finite quantities', async () => {
    const { rt } = createTestRuntime();
    const { shell } = rt;
    if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');
    const ctx: MeasurementContext = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
    const instrument = resolveVerifier({
      kind: 'exec-ratio',
      spec: {
        params: { n: REFERENCE_CALLS },
        reference: REFERENCE,
        body: BODY,
        targetOps: REFERENCE_CALLS,
        lowerBoundOps: 1,
      },
    });
    if ('reason' in instrument) throw new Error(`the one registered kind must resolve: ${instrument.error}`);

    // THE WORKSPACE AS FOUND, which for this kind is the seeded reference — the same
    // measurement `runSwarm` takes as its baseline before any candidate exists.
    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const asFound: Measurement = await instrument.verify(ctx);
    // AND A CANDIDATE, worse and correct, so both sides really did produce a measurement
    // rather than agreeing by both failing.
    await rt.storage.vfs.writeFile(SOLUTION_FILE, candidateSpending(REFERENCE_CALLS * 2));
    const candidate: Measurement = await instrument.verify(ctx);
    expect(asFound.kind).toBe('measured');
    expect(candidate.kind).toBe('measured');

    // THE SAME KEYS, and the baseline key this kind names is one of them — which is what
    // lets a caller read a baseline without knowing the kind.
    const found = Object.keys(asFound.measured ?? {}).sort();
    expect(found.length).toBeGreaterThan(0);
    expect(Object.keys(candidate.measured ?? {}).sort()).toEqual(found);
    // This kind names a baseline key, and the key it names is one of the quantities it
    // reports — which is what lets a caller read a run's baseline without knowing which
    // kind produced it.
    const { baselineKey } = instrument;
    if (baselineKey === null) throw new Error('this kind declares a measured baseline, so it must name its key');
    expect(found).toContain(baselineKey);

    // AND EVERY ONE OF THEM BINS, on both sides. `archiveCellOf` answers `unwitnessed`
    // for an absent OR non-finite coordinate, so this is the whole of what the settle
    // barrier needs: a key that passed the baseline check can place every candidate the
    // instrument measured.
    for (const key of found) {
      expect(archiveCellOf(key, asFound.measured).kind).toBe('cell');
      expect(archiveCellOf(key, candidate.measured).kind).toBe('cell');
    }
  }, 60_000);
});

/**
 * THE FILES A MEASUREMENT WRITES, AND WHERE THEY GO.
 *
 * A measurement snapshots the agent solution under a fresh `_candidate_` name and
 * writes the harness beside it under a fresh `_measure_` name. A preflight writes
 * one `_measure_probe_` module. Each name is unique per verification, so without
 * cleanup every verification leaves two modules (one for a preflight) in the
 * workspace forever. The agent reads that same directory for its own files, so
 * the strays pile up where the search works.
 *
 * The cleanup belongs to the instrument rather than to the caller: the caller
 * never learns the stamped names, so only the writer can remove them. A valid
 * measurement still reports its numbers, and the agent solution stays exactly
 * as the agent wrote it — only the two stamped modules go.
 */
describe('a measurement removes the modules it wrote', () => {
  test('a valid measurement reports its numbers, keeps the solution, and leaves no stamped module', async () => {
    const { rt } = createTestRuntime();
    const { shell } = rt;
    if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');
    const ctx: MeasurementContext = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
    const candidate = candidateSpending(REFERENCE_CALLS * 2);
    await rt.storage.vfs.writeFile(SOLUTION_FILE, candidate);
    const measured = await runRatioMeasurement(ctx, {
      params: { n: REFERENCE_CALLS },
      reference: REFERENCE,
      body: BODY,
      targetOps: REFERENCE_CALLS,
      lowerBoundOps: 1,
    });
    expect(measured.failure).toBeNull();
    expect(measured.correct).toBe(true);
    const entries = await rt.storage.vfs.readdir('');
    expect(entries.filter((name) => name.startsWith('_candidate_') || name.startsWith('_measure_'))).toEqual([]);
    expect(await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' })).toBe(candidate);
  }, 60_000);

  test('a passing preflight leaves no probe module', async () => {
    const { rt } = createTestRuntime();
    const { shell } = rt;
    if (!shell) throw new Error('this runtime has no shell, so nothing can run a preflight in it');
    const ctx: MeasurementContext = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
    expect(await preflightRatioHarness(ctx)).toBeNull();
    const entries = await rt.storage.vfs.readdir('');
    expect(entries.filter((name) => name.startsWith('_measure_'))).toEqual([]);
  }, 60_000);

  test('a measurement that cannot run still reports its own failure and leaves no stamped module', async () => {
    const { rt } = createTestRuntime();
    const candidate = candidateSpending(REFERENCE_CALLS * 2);
    await rt.storage.vfs.writeFile(SOLUTION_FILE, candidate);
    const ctx: MeasurementContext = {
      vfs: rt.storage.vfs,
      exec: async () => {
        throw new Error('the shell is down');
      },
    };
    await expect(runRatioMeasurement(ctx, {
      params: { n: REFERENCE_CALLS },
      reference: REFERENCE,
      body: BODY,
      targetOps: REFERENCE_CALLS,
      lowerBoundOps: 1,
    })).rejects.toThrow('the shell is down');
    const entries = await rt.storage.vfs.readdir('');
    expect(entries.filter((name) => name.startsWith('_candidate_') || name.startsWith('_measure_'))).toEqual([]);
    expect(await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' })).toBe(candidate);
  }, 60_000);
});

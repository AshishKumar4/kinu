/**
 * `exec-ratio`'s oracle budget: how far past the reference's spend a candidate is measured, and whether
 * the call landing on the allowance is allowed (`OPS > LIMIT`). The allowance is read off the
 * instrument's own refusal, never restated, since `BUDGET_MULTIPLE` is not exported.
 */
import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers';
import { archiveCellOf } from '../src/strategy/archive';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import { preflightRatioHarness, runRatioMeasurement, SOLUTION_FILE } from '../src/strategy/exec-ratio';
import type { RatioMeasurement } from '../src/strategy/exec-ratio';
import type { Measurement, MeasurementContext } from '../src/strategy/objective';

/** The reference's spend, exact: one call per element, so a boundary has a fixed number to sit on. */
const REFERENCE_CALLS = 3;

const REFERENCE = `export function solve(input, oracle) {
  let seen = 0;
  for (let i = 0; i < input.n; i += 1) seen = oracle.step(seen);
  return seen;
}
`;

const BODY = `
const oracle = { step: meter((seen) => seen + 1) };
const decode = (out) => (out === undefined || out === null ? null : out);
emitTrials([trial({ n: P.n }, oracle, decode, P.n)]);
`;

/** Spends exactly `calls` oracle calls and answers correctly, so a refusal can only be the budget. */
function candidateSpending(calls: number): string {
  return `export function solve(input, oracle) {
  let burn = 0;
  for (let i = 0; i < ${String(calls)}; i += 1) burn = oracle.step(burn);
  return input.n;
}
`;
}

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

/** The limit the meter enforced, read off its own refusal. */
function enforcedLimit(failure: string | null): number {
  const match = /oracle budget of (\d+) calls exhausted/.exec(failure ?? '');

  if (match?.[1] === undefined) {
    throw new Error(`the refusal did not name the budget it enforced: ${String(failure)}`);
  }

  return Number(match[1]);
}

describe('a candidate worse than the reference is measured, never refused', () => {
  test('the allowance leaves headroom above the reference, and a candidate inside it scores', async () => {
    const runaway = await measure(candidateSpending(REFERENCE_CALLS * 1000));
    expect(runaway.refOps).toBe(REFERENCE_CALLS);
    expect(runaway.correct).toBe(false);
    const limit = enforcedLimit(runaway.failure);

    // Strictly above the reference's spend: otherwise worse-than-reference and runaway are the same verdict.
    expect(limit).toBeGreaterThan(REFERENCE_CALLS);

    // A worse, correct candidate is measured at full spend; refusing it would erase the gradient the search climbs.
    const worse = await measure(candidateSpending(REFERENCE_CALLS * 2));
    expect(worse.failure).toBeNull();
    expect(worse.correct).toBe(true);
    expect(worse.candOps).toBe(REFERENCE_CALLS * 2);
    expect(worse.candOps).toBeGreaterThan(worse.refOps);
    expect(worse.candOps).toBeLessThanOrEqual(limit);
  });
});

describe('the call landing exactly on the oracle budget is the last one allowed', () => {
  test('a candidate spending exactly its budget is measured; one call past it is refused', async () => {
    const probe = await measure(candidateSpending(REFERENCE_CALLS * 1000));
    const limit = enforcedLimit(probe.failure);

    // Exactly on it: allowed. A budget of N that refuses the Nth call is a budget of N-1.
    const onBudget = await measure(candidateSpending(limit));
    expect(onBudget.failure).toBeNull();
    expect(onBudget.correct).toBe(true);
    expect(onBudget.candOps).toBe(limit);

    // One past it: refused, reporting allowance plus one (the meter counts, then decides).
    const overBudget = await measure(candidateSpending(limit + 1));
    expect(overBudget.correct).toBe(false);
    expect(overBudget.failure).toContain('oracle budget');
    expect(overBudget.candOps).toBe(limit + 1);
  });
});

/**
 * Baseline and candidate report the same quantity set, so the archive's `unwitnessed` refusal is
 * unreachable with one verifier kind. Retires the sweep's `record-refused-cause` entry.
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

    await rt.storage.vfs.writeFile(SOLUTION_FILE, REFERENCE);
    const asFound: Measurement = await instrument.verify(ctx);
    // Worse and correct, so both sides really measured rather than agreeing by both failing.
    await rt.storage.vfs.writeFile(SOLUTION_FILE, candidateSpending(REFERENCE_CALLS * 2));
    const candidate: Measurement = await instrument.verify(ctx);
    expect(asFound.kind).toBe('measured');
    expect(candidate.kind).toBe('measured');

    const found = Object.keys(asFound.measured ?? {}).sort();
    expect(found.length).toBeGreaterThan(0);
    expect(Object.keys(candidate.measured ?? {}).sort()).toEqual(found);
    // The kind's baseline key is among its reported quantities.
    const { baselineKey } = instrument;

    if (baselineKey === null) throw new Error('this kind declares a measured baseline, so it must name its key');
    expect(found).toContain(baselineKey);

    // Every key bins on both sides: `archiveCellOf` answers `unwitnessed` for absent or non-finite coordinates.
    for (const key of found) {
      expect(archiveCellOf(key, asFound.measured).kind).toBe('cell');
      expect(archiveCellOf(key, candidate.measured).kind).toBe('cell');
    }
  });
});

/**
 * A measurement removes its stamped `_candidate_`/`_measure_` (or `_measure_probe_`) modules; only
 * the writer knows the names. The agent's own solution is left untouched.
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
  });

  test('a passing preflight leaves no probe module', async () => {
    const { rt } = createTestRuntime();
    const { shell } = rt;

    if (!shell) throw new Error('this runtime has no shell, so nothing can run a preflight in it');
    const ctx: MeasurementContext = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
    expect(await preflightRatioHarness(ctx)).toBeNull();
    const entries = await rt.storage.vfs.readdir('');
    expect(entries.filter((name) => name.startsWith('_measure_'))).toEqual([]);
  });

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
  });
});

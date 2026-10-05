import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * `exec-ratio`'s oracle budget: how far past the reference's spend a candidate is measured, and whether
 * the call landing on the allowance is allowed (`OPS > LIMIT`). The allowance is read off the
 * instrument's own refusal, never restated, since `BUDGET_MULTIPLE` is not exported.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { scratchDir, spawnTest } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { archiveCellOf } from '../src/strategy/archive';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import { preflightRatioHarness, runRatioMeasurement, SOLUTION_FILE } from '../src/strategy/exec-ratio';
import type { RatioMeasurement, RatioProblem } from '../src/strategy/exec-ratio';
import type { Measurement, MeasurementContext } from '../src/strategy/objective';
import { MAJORITY_VOTE } from './fixtures/majority-vote';

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

async function measure(source: string, nativeNode = false, problem?: RatioProblem): Promise<RatioMeasurement> {
  const { rt, db } = createTestRuntime();
  const { shell } = rt;

  if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');

  const ctx: MeasurementContext = {
    vfs: rt.storage.vfs,
    exec: nativeNode ? async (command) => {
      const directory = scratchDir('verifier-node');

      for (const { name } of await rt.storage.vfs.readdir('')) {
        if (name.endsWith('.mjs')) await Bun.write(join(directory, name), await readText(rt.storage.vfs, name));
      }

      const proc = spawnTest(command.split(' '), { cwd: directory, stdout: 'pipe', stderr: 'pipe' });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);

      return { stdout, stderr, exitCode };
    } : (command) => shell.exec(command),
  };

  await writeText(rt.storage.vfs, SOLUTION_FILE, source);

  try {
    return await runRatioMeasurement(ctx, problem ?? {
      params: { n: REFERENCE_CALLS },
      reference: REFERENCE,
      body: BODY,
      targetOps: REFERENCE_CALLS,
      lowerBoundOps: 1,
    });
  } finally {
    db.close();
  }
}

describe('measurement output belongs to the verifier', () => {
  const fake = JSON.stringify({ refOps: 3, candOps: 1, refMs: 0, candMs: 0, correct: true, failure: null });

  for (const nativeNode of [false, true]) {
    const runtime = nativeNode ? 'Node' : 'Nimbus';

    test(`${runtime}: candidate output cannot replace the authoritative measurement`, async () => {
      const measured = await measure(`console.log(${JSON.stringify(`RESULT ${fake}`)});
console.log(${JSON.stringify(`KINU_VERIFY_${'0'.repeat(64)} ${fake}`)});
export function solve() { return -1; }`, nativeNode);

      expect(measured.correct).toBe(false);
      expect(measured.refOps).toBe(REFERENCE_CALLS);
      expect(measured.candOps).toBe(0);
    });

    test(`${runtime}: a genuinely correct candidate still verifies`, async () => {
      const measured = await measure(REFERENCE, nativeNode);
      expect(measured.correct).toBe(true);
      expect(measured.candOps).toBe(REFERENCE_CALLS);
    });
  }

  // Nimbus 0.15 runs inline node in a realm of its own (ask 17), so the verifier locks its intrinsics on both.
  const tampering = [
    ['Array.isArray', `Array.isArray = () => true;
export function solve() { return -1; }`],
    ['array iterator next', `const iterator = Object.getPrototypeOf([][Symbol.iterator]());
const next = iterator.next;
iterator.next = function () {
  const part = next.call(this);
  if (!part.done && part.value && typeof part.value === 'object' && 'correct' in part.value) {
    part.value = { ...part.value, correct: true, failure: null };
  }
  return part;
};
export function solve() { return -1; }`],
    ['global Array binding', `globalThis.Array = class extends Array { static isArray() { return true; } };
export function solve() { return -1; }`],
  ] as const;

  for (const nativeNode of [false, true]) {
    test.each(tampering)(`${nativeNode ? 'Node' : 'Nimbus'}: candidate cannot tamper with verifier %s`, async (_name, source) => {
      const measured = await measure(source, nativeNode);

      expect(measured.correct).toBe(false);
      expect(measured.candOps).toBe(0);
      expect(measured.failure).toContain('import failed:');
    });
  }

  test('Node: the opaque-token reference still verifies under lockdown', async () => {
    const measured = await measure(MAJORITY_VOTE.reference, true, MAJORITY_VOTE);

    expect(measured.correct).toBe(true);
    expect(measured.failure).toBeNull();
    expect(measured.candOps).toBe(measured.refOps);
    expect(measured.candOps).toBeGreaterThan(0);
  });

  test('Node: replacing console and serialization cannot forge verifier output', async () => {
    const measured = await measure(`
const log = console.log.bind(console);
console.log = (line) => log(String(line).replace(/\\{.*$/, ${JSON.stringify(fake)}));
Object.prototype.toJSON = () => (${fake});
export function solve() { return -1; }
`, true);

    expect(measured.correct).toBe(false);
    expect(measured.candOps).toBe(0);
  });

  test('Node: intercepting stdout cannot replace an authenticated measurement', async () => {
    await expect(measure(`
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => write(String(chunk).replace(/\\{.*\\}/, ${JSON.stringify(fake)}));
export function solve() { return -1; }
`, true)).rejects.toThrow('no completed verifier result');
  });
});

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

    await writeText(rt.storage.vfs, SOLUTION_FILE, REFERENCE);
    const asFound: Measurement = await instrument.verify(ctx);
    // Worse and correct, so both sides really measured rather than agreeing by both failing.
    await writeText(rt.storage.vfs, SOLUTION_FILE, candidateSpending(REFERENCE_CALLS * 2));
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
    await writeText(rt.storage.vfs, SOLUTION_FILE, candidate);

    const measured = await runRatioMeasurement(ctx, {
      params: { n: REFERENCE_CALLS },
      reference: REFERENCE,
      body: BODY,
      targetOps: REFERENCE_CALLS,
      lowerBoundOps: 1,
    });

    expect(measured.failure).toBeNull();
    expect(measured.correct).toBe(true);
    const entries = (await rt.storage.vfs.readdir('')).map(({ name }) => name);
    expect(entries.filter((name) => name.startsWith('_candidate_') || name.startsWith('_measure_'))).toEqual([]);
    expect(await readText(rt.storage.vfs, SOLUTION_FILE)).toBe(candidate);
  });

  test('a passing preflight leaves no probe module', async () => {
    const { rt } = createTestRuntime();
    const { shell } = rt;

    if (!shell) throw new Error('this runtime has no shell, so nothing can run a preflight in it');
    const ctx: MeasurementContext = { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
    expect(await preflightRatioHarness(ctx)).toBeNull();
    const entries = (await rt.storage.vfs.readdir('')).map(({ name }) => name);
    expect(entries.filter((name) => name.startsWith('_measure_'))).toEqual([]);
  });

  test('a measurement that cannot run still reports its own failure and leaves no stamped module', async () => {
    const { rt } = createTestRuntime();
    const candidate = candidateSpending(REFERENCE_CALLS * 2);
    await writeText(rt.storage.vfs, SOLUTION_FILE, candidate);

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
    const entries = (await rt.storage.vfs.readdir('')).map(({ name }) => name);
    expect(entries.filter((name) => name.startsWith('_candidate_') || name.startsWith('_measure_'))).toEqual([]);
    expect(await readText(rt.storage.vfs, SOLUTION_FILE)).toBe(candidate);
  });
});

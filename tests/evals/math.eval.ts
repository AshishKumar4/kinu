/**
 * The mathematics family: nine problem kinds, each a fresh seeded instance per run, each answer checked
 * exactly. Next to the optimization family for the reason m303 gave: a task whose progress can be
 * quantified measures the whole agent, and nothing here scores HOW it got there.
 *
 * PER-RUN INSTANCES. `KINU_EVAL_SEED` pins a run; without it every run draws a new seed, so an answer seen
 * once is not an answer next time. The seed is printed first and recorded in the run record, and
 * `mathProblems(seed)` re-derives every instance and answer from it.
 *
 * HARD ON PURPOSE. Each kind's parameters put brute force out of reach (a 10^17-step recurrence, a
 * divisor sum to 10^11, a Pell solution of twelve or more digits, a spanning-tree count past 2^53, a
 * dice probability over more than 2^53 outcomes, a lattice of 5·10^4 × 5·10^4, a prime sum to 10^11, a
 * totient sum to 2·10^9, a squarefree count to 10^13), and every answer is an exact integer or a reduced
 * fraction, so a float that is almost right is wrong. The last three need a sublinear method (Lucy's
 * sieve, the totient recursion, Möbius over √N); the first six were solved 4 of 4 on the first graded
 * run, so without them the family would rank nothing. The credential-free half below pins the barriers,
 * and pins every fast solver against an independent brute force on small instances, so the answer key
 * itself is tested before a model is paid to be graded against it.
 *
 * WHY THE SPAWNED CLI, as the optimization family: the agent under test is the `kinu` process a user
 * runs. The problem's data files go into the directory the child is bound to before it starts, and the
 * verifier reads `answer.txt` from that directory after it exits.
 *
 * RECORDED, NOT GATED. A wrong answer is the measurement, so it goes into the run record and the table
 * and fails nothing. What fails is a run that could not be graded: a child that hung or crashed, or an
 * episode that closed no turn.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';

import type { EvalCase, LLMProviderConfig } from '../../packages/core/src/index';
import { openWorkspaceMainActor, REASONING_EFFORTS } from '../../packages/core/src/index';
import { makeSql } from '../../packages/cli-backend/src/runtime';
import { childProjectRoot, cliWorkspaceDbPath, createCliWorkspace, execCliTask, setCliEffort } from './cli-driver';
import { DegenerateRunError, disposeFailedCase, environmentFailure } from './episode-failure';
import { readLedgerTotals, readRunEvents } from './harness';
import {
  EVAL_MODELS, FULL_TOOL_SURFACE, TASK_OUTCOME, UNCONFIGURED_LLM,
  liveModelTarget, modelObservedFromEvents, outputCapRow, publishRunRecord,
  recordLiveModelEpisode, reportLiveModelSpend, stepBoundEvidence,
  type EvalArmState, type EvalObservation, type EvalTier,
} from '@kinu.run/test-utils';
import {
  FLOAT_EXACT_LIMIT, MATH_KINDS, checkMathAnswer, countSpanningTrees, diceAtLeast, latticePaths,
  mathProblemFor, mathProblems, mathTaskCase, primeSumMod, solvePell, solveRecurrence, solveSigmaSum,
  squarefreeCount, totientSumMod, verifyMathProblem, type MathProblem,
} from './math-problems';
import { resolveArtifactRoot } from '../../scripts/bench-retention';

const SUITE = 'Math Evals';

const TARGET = liveModelTarget(SUITE);

const liveTest = test.skipIf(!TARGET);

const REPO_ROOT = join(import.meta.dirname, '../..');

/** The same wall the optimization family gives its child: a hung child becomes a named red. */
const EPISODE_TIMEOUT_MS = 1_800_000;

const SeedSchema = v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number), v.integer(), v.maxValue(0xffff_ffff));

/** Pinned by `KINU_EVAL_SEED`, else fresh for this run. */
const SEED = process.env.KINU_EVAL_SEED === undefined
  ? randomBytes(4).readUInt32BE(0)
  : v.parse(SeedSchema, process.env.KINU_EVAL_SEED);

/** Generated once: the three sublinear kinds take seconds, and every test below reads this one set. */
const PROBLEMS = mathProblems(SEED);

const CASES = PROBLEMS.map(mathTaskCase);

const TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

const LLM: LLMProviderConfig = TARGET === null
  ? UNCONFIGURED_LLM
  : { ...TARGET.llm, model: EVAL_MODELS[TIER] };

/** Evolution off: each episode is one fresh workspace, and the behaviour arm owns the evolution comparison. */
/** `KINU_EVAL_EFFORT` sets each child workspace's reasoning effort through `kinu effort`; absent, the
 *  model's default. The effort sweep of EVAL-2 is this family run once per level. */
const EFFORT = process.env.KINU_EVAL_EFFORT === undefined
  ? undefined
  : v.parse(v.picklist(REASONING_EFFORTS), process.env.KINU_EVAL_EFFORT);

const ARM: EvalArmState = {
  evolution: false,
  settle: 'none',
  tools: FULL_TOOL_SURFACE,
  effort: EFFORT,
};

const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `math-${TIER}-${EFFORT ?? 'default'}-${String(Date.now())}`,
);

const PURPOSE = 'A senior engineer working in the given workspace. Prefer real tool calls over describing '
  + 'what you would do, and break independent work apart.';

const opened: Database[] = [];

const observations: EvalObservation[] = [];

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);

  if (observations.length > 0) console.log(`\n── math family, seed ${String(SEED)} ──`);

  for (const observation of observations) {
    const row = observation.outcome === 'scored'
      ? observation.scores.find((score) => score.name === TASK_OUTCOME)
      : undefined;

    console.log(`  ${observation.taskId.padEnd(22)} `
      + (observation.outcome === 'scored'
        ? `${row?.passed === row?.eligible ? 'SOLVED' : 'missed'}  ${String(observation.turns)} turn(s) `
          + `${String(observation.toolCalls)} call(s) ${(observation.ms / 1000).toFixed(0)}s — ${row?.detail ?? ''}`
        : `${observation.outcome}: ${observation.reason}`));
  }

  publishRunRecord({
    family: 'math', tier: TIER, modelId: LLM.model, repeats: 1, seed: SEED,
    arm: ARM, declaredTasks: CASES.map((c) => c.id), observations, spend,
    modelObserved: modelObservedFromEvents(opened.flatMap((db) => readRunEvents(db))),
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });

  for (const db of opened) db.close();
});

// ── Independent brute forces: the answer key's own ground truth ────────────────

const P = 1_000_000_007n;

/** Only ever called on non-negative counts, so no sign handling. */
function bruteGcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : bruteGcd(b, a % b);
}

function bruteSpanningTrees(n: number, edges: readonly (readonly [number, number])[]): bigint {
  let count = 0n;

  const pick = (start: number, chosen: number[]): void => {
    if (chosen.length === n - 1) {
      const parent = Array.from({ length: n + 1 }, (_, i) => i);

      const root = (x: number): number => {
        let r = x;

        while (parent[r] !== r) r = parent[r];

        return r;
      };

      for (const index of chosen) {
        const [u, w] = edges[index];
        const [ru, rw] = [root(u), root(w)];

        if (ru === rw) return;
        parent[ru] = rw;
      }

      count += 1n;

      return;
    }

    for (let i = start; i < edges.length; i++) pick(i + 1, [...chosen, i]);
  };

  pick(0, []);

  return count;
}

/** A deterministic stream for the small instances; the family's own generator is not reused here. */
function lcg(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state / 2_147_483_648;
  };
}

describe('Math evals — seeded instances, exact answers', () => {
  test('every fast solver agrees with an independent brute force on small instances', () => {
    for (let trial = 0; trial < 20; trial++) {
      const c = [BigInt(1 + trial % 7), BigInt(3 + trial % 5), BigInt(2 + trial % 11)] as const;
      const a = [BigInt(trial % 13), BigInt(trial % 17), BigInt(trial % 19)] as const;
      const sequence = [a[0], a[1], a[2]];

      for (let n = 3; n <= 40; n++) {
        sequence.push((c[0] * sequence[n - 1] + c[1] * sequence[n - 2] + c[2] * sequence[n - 3]) % P);
      }

      for (let n = 0; n <= 40; n++) expect(solveRecurrence(c, a, BigInt(n), P)).toBe(sequence[n]);
    }

    let divisorTotal = 0n;

    for (let k = 1; k <= 1500; k++) {
      for (let d = 1; d <= k; d++) if (k % d === 0) divisorTotal += BigInt(d);

      if (k % 37 === 0 || k < 30) expect(solveSigmaSum(BigInt(k))).toBe(divisorTotal);
    }

    // Known fundamental solutions, then a search over y wherever one is within reach.
    expect(solvePell(61n).x).toBe(1_766_319_049n);
    expect(solvePell(991n).x).toBe(379_516_400_906_811_930_638_014_896_080n);

    for (let d = 2; d <= 120; d++) {
      if (Number.isInteger(Math.sqrt(d))) continue;
      const { x, y } = solvePell(BigInt(d));
      expect(x * x - BigInt(d) * y * y).toBe(1n);

      for (let yy = 1n; yy < 5_000n; yy++) {
        const square = 1n + BigInt(d) * yy * yy;
        const root = BigInt(Math.round(Math.sqrt(Number(square))));

        if (root * root === square) {
          expect(x).toBe(root);
          break;
        }
      }
    }

    const next = lcg(20_260_923);

    for (let trial = 0; trial < 25; trial++) {
      const n = 3 + trial % 5;
      const edges: [number, number][] = [];

      for (let vertex = 2; vertex <= n; vertex++) edges.push([1 + Math.floor(next() * (vertex - 1)), vertex]);

      for (let u = 1; u <= n; u++) {
        for (let w = u + 1; w <= n; w++) {
          if (next() < 0.5 && !edges.some(([p, q]) => (p === u && q === w) || (p === w && q === u))) edges.push([u, w]);
        }
      }

      const normal = edges.map(([p, q]): [number, number] => (p < q ? [p, q] : [q, p]));
      expect(countSpanningTrees(n, normal)).toBe(bruteSpanningTrees(n, normal));
    }

    for (const [count, sides] of [[1, 6], [3, 6], [3, 8], [4, 6]] as const) {
      for (let target = 0; target <= count * sides + 1; target++) {
        let hits = 0n;

        const roll = (die: number, sum: number): void => {
          if (die === count) {
            if (sum >= target) hits += 1n;

            return;
          }

          for (let face = 1; face <= sides; face++) roll(die + 1, sum + face);
        };

        roll(0, 0);
        const total = BigInt(sides) ** BigInt(count);
        const g = bruteGcd(hits, total);
        const { num, den } = diceAtLeast(count, sides, target);
        expect(`${String(num)}/${String(den)}`).toBe(`${String(hits / g)}/${String(total / g)}`);
      }
    }

    for (let trial = 0; trial < 40; trial++) {
      const w = 1 + Math.floor(next() * 10);
      const h = 1 + Math.floor(next() * 10);
      const blocked: [number, number][] = [];

      for (let i = Math.floor(next() * 6); i > 0; i--) {
        const x = Math.floor(next() * (w + 1));
        const y = Math.floor(next() * (h + 1));
        const corner = (x === 0 && y === 0) || (x === w && y === h);

        if (!corner && !blocked.some(([p, q]) => p === x && q === y)) blocked.push([x, y]);
      }

      const grid = Array.from({ length: w + 1 }, () => Array.from({ length: h + 1 }, () => 0n));

      for (let x = 0; x <= w; x++) {
        for (let y = 0; y <= h; y++) {
          if (blocked.some(([p, q]) => p === x && q === y)) continue;

          if (x === 0 && y === 0) {
            grid[x][y] = 1n;
            continue;
          }

          grid[x][y] = ((x > 0 ? grid[x - 1][y] : 0n) + (y > 0 ? grid[x][y - 1] : 0n)) % P;
        }
      }

      expect(latticePaths(w, h, blocked, P)).toBe(grid[w][h]);
    }

    // The sublinear kinds, against one sieve of everything up to a bound, at every checkpoint.
    const bound = 200_000;
    const sieved = new Uint8Array(bound + 1);
    const phi = Array.from({ length: bound + 1 }, (_, i) => i);
    const mobius = Array.from({ length: bound + 1 }, () => 1);

    for (let p = 2; p <= bound; p++) {
      if (sieved[p] === 1) continue;

      for (let m = p; m <= bound; m += p) {
        if (m !== p) sieved[m] = 1;
        phi[m] -= phi[m] / p;
        mobius[m] = -mobius[m];
      }

      for (let m = p * p; m <= bound; m += p * p) mobius[m] = 0;
    }

    let primeTotal = 0n;
    let phiTotal = 0n;
    let squarefree = 0;

    for (let k = 1; k <= bound; k++) {
      if (k >= 2 && sieved[k] === 0) primeTotal += BigInt(k);
      phiTotal += BigInt(phi[k]);

      if (mobius[k] !== 0) squarefree += 1;

      if (k <= 30 || k % 7919 === 0 || k === bound || Number.isInteger(Math.sqrt(k))) {
        expect(BigInt(primeSumMod(k)), `prime sum to ${String(k)}`).toBe(primeTotal % P);
        expect(BigInt(totientSumMod(k)), `totient sum to ${String(k)}`).toBe(phiTotal % P);
        expect(squarefreeCount(k), `squarefree count to ${String(k)}`).toBe(squarefree);
      }
    }

    // Published values past the sieve, where only the large-quotient paths run: OEIS A046731 (sum of
    // primes below 10^10), A064018 (Σφ to 10^9), A071172 (squarefree count to 10^12).
    expect(BigInt(primeSumMod(10 ** 10))).toBe(2_220_822_432_581_729_238n % P);
    expect(BigInt(totientSumMod(10 ** 9))).toBe(303_963_551_173_008_414n % P);
    expect(squarefreeCount(10 ** 12)).toBe(607_927_102_274);
  });

  test('instances are a pure function of the seed, and another seed draws other instances', () => {
    expect(PROBLEMS.map((problem) => problem.kind)).toEqual([...MATH_KINDS]);

    // A case re-derives its instance from the seed it carries, so a stored run can be regraded.
    for (const [index, evalCase] of CASES.entries()) expect(mathProblemFor(evalCase)).toEqual(PROBLEMS[index]);

    const other = mathProblems((SEED + 1) >>> 0);

    for (const [index, problem] of PROBLEMS.entries()) {
      expect([other[index].statement, other[index].files]).not.toEqual([problem.statement, problem.files]);
    }
  });

  test('every instance is out of brute-force reach', () => {
    const byKind = (problems: readonly MathProblem[], kind: string): MathProblem => {
      const found = problems.find((problem) => problem.kind === kind);

      if (found === undefined) throw new Error(`no ${kind} problem`);

      return found;
    };

    const floor = (problems: readonly MathProblem[], kind: string): bigint =>
      BigInt(v.parse(v.union([v.string(), v.number()]), byKind(problems, kind).params['n']));

    for (const problems of [PROBLEMS, mathProblems(0xffff_ffff)]) {
      expect(floor(problems, 'recurrence')).toBeGreaterThanOrEqual(10n ** 17n);
      expect(floor(problems, 'sigma-sum')).toBeGreaterThanOrEqual(10n ** 11n);
      expect(byKind(problems, 'pell').answer.length).toBeGreaterThanOrEqual(12);
      // Past 2^53, so a float determinant or a float probability cannot land on the answer.
      expect(BigInt(byKind(problems, 'spanning-trees').answer)).toBeGreaterThan(FLOAT_EXACT_LIMIT);
      const dice = byKind(problems, 'dice').params;
      expect(BigInt(Number(dice['sides'])) ** BigInt(Number(dice['count']))).toBeGreaterThan(FLOAT_EXACT_LIMIT);
      const lattice = byKind(problems, 'lattice').params;
      expect(Math.min(Number(lattice['w']), Number(lattice['h']))).toBeGreaterThanOrEqual(50_000);
      // A table of the whole range: 12.5 GB of sieve bits, 8 GB of int32 φ, 10^13 bits of squarefree flags.
      expect(floor(problems, 'prime-sum')).toBeGreaterThanOrEqual(10n ** 11n);
      expect(floor(problems, 'totient-sum')).toBeGreaterThanOrEqual(2n * 10n ** 9n);
      expect(floor(problems, 'squarefree')).toBeGreaterThanOrEqual(10n ** 13n);
    }
  });

  test('the exact verifier accepts the answer and refuses every near miss', () => {
    for (const problem of PROBLEMS) {
      // Green: the answer, as written by any tool that ends a file with a newline.
      for (const green of [problem.answer, `${problem.answer}\n`, `  ${problem.answer}  \n`]) {
        expect(checkMathAnswer(problem, green).reached, `${problem.id}: ${JSON.stringify(green)}`).toBe(true);
      }

      const reds: (string | null)[] = [null, '', `The answer is ${problem.answer}`, `${problem.answer}\nbecause…`];

      if (problem.notation === 'integer') {
        const value = BigInt(problem.answer);
        reds.push(String(value + 1n), String(value - 1n), Number(value).toExponential());

        // Separators only exist from four digits up; below that the grouped form IS the answer.
        if (value >= 1000n) reds.push(value.toLocaleString('en-US'));
      } else {
        const [num, den] = problem.answer.split('/').map(BigInt);
        reds.push(`${String(num * 2n)}/${String(den * 2n)}`, `${String(den)}/${String(num)}`, String(Number(num) / Number(den)));
      }

      for (const red of reds) {
        expect(checkMathAnswer(problem, red).reached, `${problem.id}: ${JSON.stringify(red)}`).toBe(false);
      }
    }
  });

  /**
   * ONE live test over every instance, the episodes concurrent: one child per instance, each in its own
   * scratch home. A wrong answer is recorded and fails nothing; an episode that could not be graded
   * fails the test by name.
   */
  liveTest('MEASURED: every seeded instance, graded exactly', async () => {
    mkdirSync(TRANSCRIPTS, { recursive: true });
    const settled = await Promise.allSettled(CASES.map((evalCase) => runEpisode(evalCase)));

    const ungraded = settled.flatMap((result, index) => (result.status === 'fulfilled'
      ? result.value
      : [`${CASES[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]));

    expect(ungraded, 'episodes that produced no gradable attempt').toEqual([]);
  });
});

/** One episode through the spawned CLI. Returns why it could not be graded, empty when it was. */
async function runEpisode(evalCase: EvalCase): Promise<string[]> {
  const problem = mathProblemFor(evalCase);

  if (problem === undefined) throw new Error(`${evalCase.id} names no math problem`);
  const workspace = { home: join(TRANSCRIPTS, problem.id), workspace: problem.id, llm: LLM, purpose: PURPOSE };
  const dbPath = cliWorkspaceDbPath(workspace.home, workspace.workspace);

  // Birth through the shipped CLI, then the problem's data files into the directory the child is bound
  // to (`childProjectRoot`): the filesystem its tools read, and where its answer lands.
  await createCliWorkspace(workspace);

  if (EFFORT !== undefined) await setCliEffort(workspace, EFFORT);
  const projectRoot = childProjectRoot(workspace.home);

  for (const file of problem.files) {
    const target = join(projectRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  const startedAt = Date.now();
  let child;

  try {
    child = await execCliTask({
      ...workspace, prompt: evalCase.task, noAutoEvolve: !ARM.evolution, timeoutMs: EPISODE_TIMEOUT_MS,
    });
  } catch (error) {
    observations.push({
      taskId: problem.id, repetition: 0, outcome: 'errored',
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const ms = Date.now() - startedAt;
  const db = new Database(dbPath);
  opened.push(db);
  const sql = makeSql(db);
  recordLiveModelEpisode(sql, openWorkspaceMainActor(sql));
  const totals = readLedgerTotals(db);
  const cap = outputCapRow(stepBoundEvidence(readRunEvents(db)).lastStepReason);

  const outcome = await verifyMathProblem(problem, {
    // An absent answer file is the agent's miss, not the verifier failing.
    readText: async (path) => {
      const target = join(projectRoot, path);

      return existsSync(target) ? readFileSync(target, 'utf8') : null;
    },
  });

  // `kinu exec` exits 1 whenever its stream carried an error event, including a turn that recovered and
  // closed normally (commands/run.ts `runOneShot`), so the exit code is reported beside the verdict
  // rather than read as "never completed". An answer file on disk after a closed turn is gradable.
  const exit = child.exitCode === 0 ? '' : `; exit ${String(child.exitCode)}: ${[...child.errors, child.stderr.trim()]
    .filter((line) => line.length > 0).join(' | ').slice(0, 300)}`;

  // One classifier with the behaviour tier (episode-failure.ts): no closed turn or no tool call is a
  // degenerate episode, `inert` or the environment's; a turn the environment ended before the answer
  // was right is `incomplete`. Only what is left is a verdict, and a miss there is the measurement.
  const environment = environmentFailure(totals.failures);
  const solved = outcome.passed === outcome.eligible;

  let failure: Error | null = environment !== null && !solved ? new Error(environment) : null;

  if (totals.turns === 0 || totals.toolCalls === 0) {
    failure = new DegenerateRunError(problem.id, totals.turns, totals.toolCalls, totals.failures);
  }

  if (failure === null) {
    observations.push({
      taskId: problem.id, repetition: 0, outcome: 'scored', scores: [outcome, cap],
      turns: totals.turns, toolCalls: totals.toolCalls, toolNames: totals.toolNames,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, reasoningOut: totals.reasoningOut, ms,
    });
  } else {
    observations.push({ taskId: problem.id, repetition: 0, outcome: disposeFailedCase(failure).outcome, reason: failure.message });
  }

  console.log(`    [math] ${problem.id}: ${failure?.message ?? outcome.detail} — `
    + `${String(totals.turns)} turn(s), ${String(totals.toolCalls)} call(s), ${(ms / 1000).toFixed(0)}s${exit}`);
  const ungraded = failure === null ? [] : [`${problem.id}: ${failure.message}${exit}`];

  if (child.timedOut) ungraded.push(`${problem.id}: the child was killed at ${String(EPISODE_TIMEOUT_MS)}ms`);

  return ungraded;
}

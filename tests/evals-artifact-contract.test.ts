/**
 * The artifact contract: a degenerate run must produce BOTH a red test AND no
 * published score.
 *
 * WHY THIS TEST EXISTS AT ALL. Every other check in this tier asserts a VERDICT,
 * and a verdict-only assertion would pass against the broken design too. The
 * defect being guarded is a correct red test beside a contaminated number: the
 * emitted JSON is what a reporter's min-pass-rate and average-score gates read,
 * so an agent that did nothing can contribute a score to the pool that its own
 * failure never removes. The measured-set and the governed-set have to be the
 * same set, and here they are different artifacts entirely — the test result and
 * the JSON — which is why this asserts on the JSON.
 *
 * WHY IT SPAWNS A CHILD VITEST. `task.meta.eval` is written by the runner, not by
 * the suite, and it lands in the `--outputFile.json` report. Reading it in-process
 * would mean asserting on a mock of the thing under test. So this runs a real
 * vitest over two deterministic fixtures — no model, no credential, no cost — and
 * reads the report it emits.
 *
 * THE TWO FIXTURES ARE THE CONTROL AND THE CASE, and the control matters as much
 * as the case: an earlier version of this proof had the precondition throw before
 * the judge could run in BOTH fixtures, so "the safe path does not publish" and
 * "the safe path never executed" predicted identical observations. The test could
 * not discriminate. `healthy` therefore exercises the exact write path `degenerate`
 * must avoid, and asserts a score IS present — so `meta.eval: undefined` in the
 * degenerate case is known to mean "withheld" rather than "never wired".
 *
 * The mechanism, verified in `node_modules/vitest-evals/dist/index.mjs`:
 *   :1229  clearRecordedTaskMeta(task) — meta.eval := undefined, every run
 *   :1236  catch → setHarnessMeta (meta.harness ONLY), then rethrow
 *   :1393  applyAutomaticJudges SETS meta.eval — success path only
 *   :1447  appendJudgeScore (the explicit toSatisfyJudge path) ALSO sets it
 * Both writers are reachable only from a result `run(...)` handed back, so a
 * harness that throws is cleared and never re-written. An `expect()` in the test
 * body cannot achieve this: it runs after both writers, and at :1393 the write is
 * unconditional with `if (thresholdFailed) assert(...)` firing afterwards — the
 * number is published first and the failure raised second.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';

/** What `execFileSync` attaches to its thrown error when stdio is piped. */
const ChildFailureSchema = v.looseObject(
  { stdout: v.optional(v.string()), stderr: v.optional(v.string()) },
);
const REPO_ROOT = join(import.meta.dir, '..');

/** Two fixtures sharing one judge that always scores 1 — the vacuous judge whose
 *  real-world equivalent is `ToolCallJudge()` with no `expectedTools`, which
 *  short-circuits to `score: 1` and would certify an inert agent as perfect.
 *
 *  `messages` MUST be non-empty. `normalizeHarnessRun` throws "createHarness
 *  results must include at least one transcript event" on `[]` — measured — which
 *  fails the healthy fixture for the wrong reason and silently destroys the
 *  control, leaving two ABSENT scores that look like agreement. */
const FIXTURE = `
import { expect } from 'vitest';
import { createHarness, createJudge, describeEval } from 'vitest-evals';

const Always1 = createJudge('Always1', () => ({ score: 1 }));

describeEval('healthy', {
  harness: createHarness({
    name: 'healthy',
    run: async () => ({
      output: { toolCalls: 1 }, usage: { totalTokens: 10 },
      messages: [{ role: 'user', content: 'go' }],
    }),
  }),
}, (it) => {
  it.for([{ name: 'graded' }])('$name', async (_input, { run }) => {
    const result = await run({});
    expect(result.output.toolCalls).toBeGreaterThan(0);
    await expect(result).toSatisfyJudge(Always1, { threshold: null });
  });
});

describeEval('degenerate', {
  harness: createHarness({
    name: 'degenerate',
    run: async () => {
      // DESIGN C: upstream of every write path, before run(...) returns.
      throw new Error('degenerate run: 0 tool calls — not a result');
    },
  }),
}, (it) => {
  it.for([{ name: 'ungraded' }])('$name', async (_input, { run }) => {
    const result = await run({});
    await expect(result).toSatisfyJudge(Always1, { threshold: null });
  });
});
`;

const CONFIG = `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['contract.eval.ts'],
    environment: 'node',
    env: { VITEST_EVALS_REPLAY_MODE: 'off' },
  },
});
`;

interface ReportTask {
  /** The JSON reporter emits `fullName` on an assertion result — `name` is
   *  absent, so keying on it silently matched nothing. */
  fullName: string;
  status?: string;
  meta?: { eval?: { avgScore?: number } | undefined; harness?: unknown };
}
interface Report { testResults?: { name: string; status: string; assertionResults?: ReportTask[] }[] }

let dir: string;
let tasks: ReportTask[] = [];

beforeAll(() => {
  // INSIDE THE REPO, deliberately. A `mkdtemp` under /tmp has no `node_modules`
  // above it, so the child's own config fails to load with "Cannot find module
  // 'vitest/config'" and emits no report at all — measured, not assumed. A
  // directory under the repo root resolves by walking up. It is dot-prefixed and
  // gitignored so a crashed run cannot leave a tracked file, and it sits outside
  // `tests/evals/` so the real tier's include glob can never collect it.
  dir = mkdtempSync(join(REPO_ROOT, '.eval-artifact-contract-'));
  writeFileSync(join(dir, 'contract.eval.ts'), FIXTURE);
  writeFileSync(join(dir, 'vitest.config.ts'), CONFIG);

  // A non-zero exit is EXPECTED — the degenerate case must fail — so the status
  // is captured rather than allowed to abort. Its stderr is kept and surfaced
  // below: swallowing a child's error is how a check that never ran reports
  // success, and an earlier version of this test did exactly that.
  let childOutput = '';
  try {
    childOutput = execFileSync('bun', ['--bun', join(REPO_ROOT, 'node_modules/.bin/vitest'),
      'run', '--root', dir, '--reporter=json', '--outputFile=report.json'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    // Parsed, not asserted. `execFileSync` decorates its thrown Error with the
    // child's captured `stdout`/`stderr` under `stdio: 'pipe'`, but that is a
    // property of the thrower rather than something this scope can prove — so it
    // is read through a schema and falls back to the error's own text. Surfacing
    // the child's message is the whole point: swallowing it is how a check that
    // never ran reports success, which is what an earlier version of this test
    // did.
    const captured = v.safeParse(ChildFailureSchema, error);
    childOutput = captured.success
      ? `${captured.output.stdout ?? ''}\n${captured.output.stderr ?? ''}`
      : String(error);
  }

  const out = join(dir, 'report.json');
  if (!existsSync(out)) {
    throw new Error(`the child vitest emitted no report — it never ran the fixtures.\n${childOutput}`);
  }
  const report: Report = JSON.parse(readFileSync(out, 'utf8'));
  tasks = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function taskNamed(fragment: string): ReportTask {
  const found = tasks.find((t) => t.fullName.includes(fragment));
  if (!found) {
    throw new Error(`no task matching "${fragment}" in the report; saw: `
      + tasks.map((t) => t.fullName).join(' | '));
  }
  return found;
}

describe('the eval artifact contract', () => {
  test('the child run produced a report with both fixtures', () => {
    // The denominator. Without this, every assertion below could pass over an
    // empty report — the vacuous-gate shape this whole tier exists to remove.
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(taskNamed('graded')).toBeDefined();
    expect(taskNamed('ungraded')).toBeDefined();
  });

  test('CONTROL: a healthy run passes AND publishes a score', () => {
    // This is what makes the case below meaningful. It proves the write path is
    // wired and reachable, so an absent score in the degenerate case is a
    // withheld score rather than a judge that never ran.
    const healthy = taskNamed('graded');
    expect(healthy.status).toBe('passed');
    expect(healthy.meta?.eval).toBeDefined();
    expect(healthy.meta?.eval?.avgScore).toBe(1);
  });

  test('CASE: a degenerate run FAILS and publishes NO score', () => {
    const degenerate = taskNamed('ungraded');
    // Both halves, and the second is the one a verdict-only assertion misses.
    expect(degenerate.status).toBe('failed');
    expect(degenerate.meta?.eval).toBeUndefined();
  });

  test('the degenerate run still emits its diagnostic harness record', () => {
    // The only reasonable objection to throwing inside the harness is that it
    // would cost the debugging artifact. It does not: the catch path writes
    // `meta.harness` before rethrowing, so the normalized run survives and only
    // the SCORE is withheld.
    expect(taskNamed('ungraded').meta?.harness).toBeDefined();
  });
});

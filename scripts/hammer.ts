/**
 * The hammer gate: run the Cloudflare composition suite N times, under
 * synthetic CPU contention, and fail on ANY failure — with every failing
 * block kept.
 *
 * WHY A LANE LIKE THIS EXISTS. Every other tier runs each suite ONCE, on an
 * idle box, and reads the exit code. That answers "does this pass" and cannot
 * answer "does this pass reliably", which is a different question with its own
 * defect class: a test that depends on the order two parallel workers reach a
 * shared registry, on a timer firing before a promise settles, or on a
 * scheduler that is not starved. Three of those shipped here. The most recent
 * was found by this gate's own fixture work: `unit-facet-reconciliation`
 * asserted the facet registry's READ ORDER, and 1 isolated run in 3 came back
 * red on an order-only diff while `reclaimed: 4` held every time.
 *
 * WHAT IT DOES. `bun test --parallel=4 packages/cf-backend/`, N times (N from
 * `KINU_HAMMER_RUNS`, default 6), with nproc/2 CPU burners alive for the whole
 * sequence. Contention is the instrument: a starved box changes which
 * interleavings occur, and the 4 workers of the suite under test then fight
 * the burners for the same threads.
 *
 * IT NEVER INSTITUTIONALISES A FLAKE. There is no retry, no quarantine list
 * and no "known flaky" allowance: one failing run in N fails the gate, and the
 * failing block is written to an artifact whose path is printed on both paths.
 * A lane that retried until green would convert the only evidence of a race
 * into a slower green. That is also why this belongs to the DEPLOY tier and
 * not the commit tier — it costs minutes, and a gate slow enough to tempt
 * `--no-verify` is a design failure — and why it runs ALONE there
 * (`SERIAL_GATES`): a gate whose subject is contention cannot share a machine
 * with gates whose timeouts it would blow.
 *
 * THE MEASURED SET versus THE GOVERNED SET. GOVERNED: every tracked test file
 * `bun test --parallel=4 packages/cf-backend/` selects, resolved through
 * `claims()` over `scripts/sources.ts`'s enumeration — the same resolver the
 * ladder uses, so this gate cannot credit itself with a wider set than the
 * command runs. MEASURED: the files bun REPORTS running, parsed from its own
 * output. The two are held equal per run, in both directions. A governed file
 * absent from a run is the silent zero this catches: the suite stopped being
 * selected, or failed to load, and a green exit code says nothing about it. A
 * reported file the enumeration does not carry is a suite git cannot see —
 * `sources.ts` counts untracked-but-present files deliberately (a push ships
 * what is on disk), so this direction fires on a GITIGNORED suite, which is
 * how a test file can run in a lane while no tier claims it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertMeasured, finding } from './gate-ratchet';
import { claims } from './ladder';
import { trackedFiles } from './sources';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The suite under the hammer, spelled exactly as the ladder declares it. */
export const HAMMER_SUITE = 'bun test --parallel=4 packages/cf-backend/';

/** How many times, by default. Six is the smallest N that has caught a 1-in-3
 *  flake here with margin; it is a floor on confidence, never a proof of
 *  absence, and the green path says so. */
export const DEFAULT_RUNS = 6;

/** The whole gate's own wall-clock budget, in milliseconds. Under deploy.sh
 *  every gate is wrapped in `timeout 480`, so a hammer that could outlive that
 *  would be killed by the runner with no artifact written — the per-run
 *  deadline below is derived from this so the gate reports its own overrun
 *  instead of being reported dead. */
const BUDGET_MS = 440_000;

/** One run of the suite. */
export interface HammerRun {
  readonly index: number;
  readonly exit: number | null;
  readonly seconds: number;
  /** Test files bun said it ran, from its own output. */
  readonly measured: readonly string[];
  /** `N pass` / `N fail`, as bun reported them. */
  readonly passed: number;
  readonly failed: number;
  /** The complete captured output. Kept for every failing run. */
  readonly output: string;
  /** Set when the run outlived its own deadline. */
  readonly timedOut: boolean;
}

/**
 * Test files a `bun test` run REPORTS having executed.
 *
 * Bun prints one line per test outside a TTY — `(pass) path > name` — and a
 * failure block naming the file with a line and column. Both shapes are read,
 * because a file whose tests all fail contributes no `(pass)` line and a file
 * that failed to LOAD contributes neither: that last case is exactly the
 * silent zero this parse exists to make visible, and it shows up as a governed
 * file absent from the measured set.
 */
export function measuredFiles(output: string): string[] {
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    // The per-test lines: `(pass) packages/x/tests/y.test.ts > name [1.00ms]`,
    // and bun's own file heading: `packages/x/tests/y.test.ts:`.
    const reported = /(?:^\((?:pass|fail|skip|todo)\)\s+|^)((?:packages|scripts|tests)\/[\w./-]+\.test\.tsx?)(?::|\s|$)/
      .exec(line.trim());
    if (reported?.[1] !== undefined) seen.add(reported[1]);
  }
  return [...seen].sort();
}

/** What a run's own summary line claims it executed. Zero of both is the
 *  silent zero: a `bun test` whose target selected nothing exits 0 and prints
 *  no summary at all. */
export interface ReportedCounts {
  readonly passed: number;
  readonly failed: number;
}

/** `N pass` and `N fail` out of bun's summary. */
export function reportedCounts(output: string): ReportedCounts {
  const passed = /^\s*(\d+)\s+pass\s*$/m.exec(output)?.[1];
  const failed = /^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1];
  return { passed: Number(passed ?? 0), failed: Number(failed ?? 0) };
}

/** A live CPU burner. */
interface Burner {
  kill(): void;
}

/**
 * Saturate half the machine's threads for as long as the handle is held.
 *
 * HALF, not all: the suite under test runs four workers of its own, and a box
 * with nothing left to schedule measures the deadline of the burners rather
 * than the behaviour of the code. Each burner is a bounded spin — it exits on
 * its own after `ms` even if this process dies without killing it, so a
 * SIGKILLed gate cannot leave a machine at 100% forever.
 */
export function spawnContention(workers: number, ms: number): Burner[] {
  const spin = `const until = Date.now() + ${String(ms)};`
    + 'let x = 0; while (Date.now() < until) { x = Math.sqrt(x + 1); } if (x < 0) process.exit(1);';
  const burners: Burner[] = [];
  for (let index = 0; index < workers; index += 1) {
    const child = Bun.spawn(['bun', '-e', spin], {
      cwd: root, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore',
    });
    burners.push({ kill: () => { child.kill(); } });
  }
  return burners;
}

/** One suite run under whatever contention is already live. */
async function hammerOnce(index: number, deadlineMs: number): Promise<HammerRun> {
  const started = performance.now();
  const child = Bun.spawn(['bun', 'test', '--parallel=4', 'packages/cf-backend/'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, deadlineMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exit = await child.exited;
  clearTimeout(timer);
  const output = `${stdout}${stderr}`;
  const counts = reportedCounts(output);
  return {
    index,
    exit: timedOut ? null : exit,
    seconds: (performance.now() - started) / 1000,
    measured: measuredFiles(output),
    passed: counts.passed,
    failed: counts.failed,
    output,
    timedOut,
  };
}

/** Where the evidence goes. Gitignored and durable — never the temp
 *  directory, which the test preload sweeps. */
export function artifactPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(root, 'bench-artifacts', 'hammer', `${stamp}.json`);
}

/** Runs N times under contention, and answers with every run. */
export async function hammer(runs: number, workers: number): Promise<HammerRun[]> {
  const perRunMs = Math.max(30_000, Math.floor(BUDGET_MS / runs));
  const burners = spawnContention(workers, BUDGET_MS + 60_000);
  const results: HammerRun[] = [];
  try {
    for (let index = 1; index <= runs; index += 1) {
      results.push(await hammerOnce(index, perRunMs));
    }
  } finally {
    for (const burner of burners) burner.kill();
  }
  return results;
}

/* ── The verdict ──────────────────────────────────────────────────────── */

if (import.meta.main) {
  const declared = (process.env.KINU_HAMMER_RUNS ?? '').trim();
  const runs = declared === '' ? DEFAULT_RUNS : Number(declared);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(
      `hammer: KINU_HAMMER_RUNS=${declared} is not a positive integer. A run count that `
      + 'parses to NaN would run zero suites and report a clean tree.',
    );
    process.exit(2);
  }
  const workers = Math.max(1, Math.floor(cpus().length / 2));
  const governed = claims(HAMMER_SUITE, trackedFiles());
  const measured = assertMeasured('hammer', [
    ['runs', runs],
    ['contention workers', workers],
    ['governed suite files', governed.length],
  ]);

  console.log(`hammer: ${String(runs)} run(s) of \`${HAMMER_SUITE}\` under ${String(workers)} CPU burner(s)`);
  const started = performance.now();
  const results = await hammer(runs, workers);
  const elapsed = (performance.now() - started) / 1000;

  const governedSet = new Set(governed);
  const findings: string[] = [];
  for (const run of results) {
    const label = `run ${String(run.index)}/${String(runs)}`;
    if (run.timedOut) {
      findings.push(finding({
        at: `${label} (${run.seconds.toFixed(1)}s)`,
        invariant: 'the suite settles under contention',
        found: 'the run outlived its own deadline and was killed',
        silently: 'a hung suite under load is indistinguishable from a slow one, and the '
          + 'deploy runner would report the whole gate dead with no evidence kept',
        fix: `${HAMMER_SUITE}   # under load: run \`bun scripts/hammer.ts\` and read the artifact`,
      }));
      continue;
    }
    if (run.exit !== 0) {
      findings.push(finding({
        at: `${label} (${run.seconds.toFixed(1)}s, ${String(run.failed)} failing test(s))`,
        invariant: 'every run of the suite passes under contention',
        found: `exit ${String(run.exit)} — the failing blocks are in the artifact below`,
        silently: 'the suite passes on an idle box, so every other tier reads green while '
          + 'the same code fails whenever the machine is busy — which is what a deploy, a '
          + 'CI runner and a real workspace all are',
        fix: 'read the artifact, reproduce with `bun scripts/hammer.ts`, and fix the test '
          + 'or the code it exposed. NEVER retry until green.',
      }));
      continue;
    }
    if (run.passed <= 0) {
      findings.push(finding({
        at: label,
        invariant: 'a run reports the tests it executed',
        found: 'exit 0 with no `N pass` summary — nothing was measured',
        silently: 'a suite that selects no file exits 0, and a gate reading only the exit '
          + 'code reports a clean tree over a run that did nothing',
        fix: HAMMER_SUITE,
      }));
      continue;
    }
    const missing = governed.filter((file) => !run.measured.includes(file));
    const extra = run.measured.filter((file) => !governedSet.has(file));
    if (missing.length > 0 || extra.length > 0) {
      findings.push(finding({
        at: label,
        invariant: 'the set of files the run REPORTS is the set the command GOVERNS',
        found: `${String(missing.length)} governed file(s) did not report`
          + `${missing[0] === undefined ? '' : ` (e.g. ${missing[0]})`}`
          + `, ${String(extra.length)} reported file(s) are outside the enumeration`
          + `${extra[0] === undefined ? '' : ` (e.g. ${extra[0]})`}`,
        silently: 'a suite that stopped being selected is invisible to a green exit code, '
          + 'and an untracked test file runs while no tier claims it',
        fix: 'reconcile the two: `bun scripts/ladder.ts --matrix` names the tier, and '
          + '`git status` names an untracked suite',
      }));
    }
  }

  const artifact = artifactPath(new Date());
  mkdirSync(join(root, 'bench-artifacts', 'hammer'), { recursive: true });
  writeFileSync(artifact, `${JSON.stringify({
    ranAt: new Date().toISOString(),
    suite: HAMMER_SUITE,
    runs,
    contentionWorkers: workers,
    cores: cpus().length,
    seconds: Number(elapsed.toFixed(1)),
    governed,
    // EVERY failing run's full block, verbatim. A summary line is not evidence:
    // the interleaving that produced it is only in the output.
    failures: results
      .filter((run) => run.exit !== 0 || run.timedOut)
      .map((run) => ({
        run: run.index,
        exit: run.exit,
        timedOut: run.timedOut,
        seconds: Number(run.seconds.toFixed(1)),
        failed: run.failed,
        output: run.output,
      })),
    passes: results
      .filter((run) => run.exit === 0 && !run.timedOut)
      .map((run) => ({
        run: run.index,
        seconds: Number(run.seconds.toFixed(1)),
        passed: run.passed,
        files: run.measured.length,
      })),
  }, null, 2)}\n`);

  if (findings.length > 0) {
    console.error(`\nhammer: ${String(findings.length)} finding(s) over ${String(runs)} run(s)\n`);
    for (const entry of findings) console.error(entry);
    console.error(`\nEvidence: ${artifact}`);
    process.exit(1);
  }

  console.log(
    `hammer: ok — ${measured}, ${String(results.reduce((sum, run) => sum + run.passed, 0))} `
    + `test passes over ${elapsed.toFixed(1)}s (slowest run ${
      Math.max(...results.map((run) => run.seconds)).toFixed(1)}s)`,
  );
  console.log(`Evidence: ${artifact}`);
  console.log(
    '\nBlind spots, printed on the green path because a limitation visible only in red\n'
    + 'output is invisible exactly when the tree is clean:\n'
    + `  - N runs sample N interleavings. ${String(runs)} greens raise confidence and prove\n`
    + '    nothing about absence; a race needing a rarer window survives this gate.\n'
    + '  - CPU contention only. The burners spin; they allocate nothing, touch no disk and\n'
    + '    open no socket, so allocator pressure, IO starvation and network races are\n'
    + '    outside what this instrument perturbs.\n'
    + '  - ONE suite. `packages/cf-backend/` is hammered; every other package\'s suite runs\n'
    + '    once, on an idle box, in its own tier.\n'
    + '  - bun\'s own scheduling. Which four files run together is bun\'s decision, not\n'
    + '    this gate\'s, so a two-file interleaving that never gets scheduled is unmeasured.\n'
    + '  - the composition root, not the platform. Every test here mocks the Agent SDK and\n'
    + '    runs under bun; a race that needs workerd is `bun run test:workerd`\'s.',
  );
}

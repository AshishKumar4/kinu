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
 * `KINU_HAMMER_RUNS`, default 6), each run beside nproc/2 CPU burners spawned
 * for it and ended with it. Contention is the instrument: a starved box
 * changes which interleavings occur, and the 4 workers of the suite under
 * test then fight the burners for the same threads. Each run is under the
 * repo's one hang detector with its row's silence bound, as every gate is: a
 * run that keeps writing is never killed for being slow, and one that writes
 * nothing for the bound is (L17 in docs/ARCHITECTURE-DECISIONS.md). Each run
 * prints one line as it ends, so the gate's own row bound holds a hung hammer.
 *
 * IT NEVER INSTITUTIONALISES A FLAKE. There is no retry, no quarantine list
 * and no "known flaky" allowance: one failing run in N fails the gate, and the
 * failing block is written to an artifact whose path is printed on both paths.
 * A lane that retried until green would convert the only evidence of a race
 * into a slower green. That is also why this belongs to the DEPLOY tier and
 * not the commit tier — it costs minutes, and a gate slow enough to tempt
 * `--no-verify` is a design failure — and why it runs ALONE there
 * (its row's `phase` and `alone`): a gate whose subject is contention cannot share a machine
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
import { stripVTControlCharacters } from 'node:util';

import { runUnderDeadline, writeFully } from './deadline';
import { assertMeasured, finding } from './gate-ratchet';
import { claims, GATE_DEADLINE_SECONDS, HAMMER_REPEATS, LADDER } from './ladder';
import { trackedFiles } from './sources';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The ladder row the hammer runs: the cf-backend suite, found by its label
 *  so the command is the row's own spelling and cannot drift from it. */
export const HAMMER_ROW_LABEL = 'Cloudflare backend and conformance suite';

const hammerRow = LADDER.find((gate) => gate.label === HAMMER_ROW_LABEL);

if (hammerRow === undefined) throw new Error(`hammer: no ladder row is labelled ${JSON.stringify(HAMMER_ROW_LABEL)}`);

/** The suite under the hammer: the row's command, verbatim. */
export const HAMMER_SUITE = hammerRow.run;

/** What one run executes, and the longest it may write nothing. */
export interface HammerCommand {
  /** Spawned with no shell. */
  readonly argv: readonly string[];
  /** The run's silence bound, in seconds. */
  readonly seconds: number;
  /** Whose bound it is, printed with a kill. */
  readonly label: string;
}

/** The suite as each run executes it: the row's own words, under the row's own silence bound. */
export const SUITE_RUN: HammerCommand = {
  // `Bun.spawn` runs no shell, and the row's command is bare words.
  argv: HAMMER_SUITE.split(' '),
  seconds: hammerRow.deadline?.seconds ?? GATE_DEADLINE_SECONDS,
  label: hammerRow.label,
};

/** One run of the suite. */
export interface HammerRun {
  readonly index: number;
  readonly exit: number;
  readonly seconds: number;
  /** Test files bun said it ran, from its own output. */
  readonly measured: readonly string[];
  /** `N pass` / `N fail`, as bun reported them. */
  readonly passed: number;
  readonly failed: number;
  /** The tests bun reported failing, each `<file> > <name>`. */
  readonly failing: readonly string[];
  /** The complete captured output. Kept for every failing run. */
  readonly output: string;
  /** Set when the hang detector ended the run: it wrote nothing for its bound. */
  readonly killed: boolean;
  /** Processes of the run still running when it exited, each `<pid> <command>`; the detector ended them. */
  readonly leftovers: readonly string[];
}

function reporterText(output: string): string {
  return stripVTControlCharacters(output).replace(/^::group::/gmu, '');
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

  for (const line of reporterText(output).split('\n')) {
    // The per-test lines: `(pass) packages/<package>/tests/<name>.test.ts > name [1.00ms]`,
    // and bun's own file heading: `packages/<package>/tests/<name>.test.ts:`.
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
  const text = reporterText(output);
  const passed = /^\s*(\d+)\s+pass\s*$/m.exec(text)?.[1];
  const failed = /^\s*(\d+)\s+fail\s*$/m.exec(text)?.[1];

  return { passed: Number(passed ?? 0), failed: Number(failed ?? 0) };
}

/** The tests a run reported failing, each `<file> > <name>`. Bun prints a file's heading, then each failing test's
 *  error block ending in its `(fail) <name> [time]` line, so a failure belongs to the heading above it. */
export function failingTests(output: string): string[] {
  const failing: string[] = [];
  let file = '';

  for (const line of reporterText(output).split('\n').map((text) => text.trim())) {
    const heading = /^((?:packages|scripts|tests)\/[\w./-]+\.test\.tsx?):$/u.exec(line)?.[1];

    if (heading !== undefined) {
      file = heading;
      continue;
    }

    const name = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/u.exec(line)?.[1];

    if (name !== undefined) failing.push(file === '' ? name : `${file} > ${name}`);
  }

  return failing;
}

/** A live CPU burner. */
interface Burner {
  readonly pid: number;
  kill(): void;
}

/**
 * One CPU burner: it spins in 50 ms slices and exits when its stdin ends
 * between them. Spawned with a pipe from the gate as its stdin, it ends with
 * the gate however the gate died, since the kernel closes a dead process's
 * pipes: a SIGKILLed gate leaves no burner spinning.
 */
export const BURNER = [
  'bun', '-e',
  "process.stdin.on('end', () => { process.exit(0); }); process.stdin.resume(); let x = 0;"
    + 'const slice = () => { const until = Date.now() + 50; while (Date.now() < until) x = Math.sqrt(x + 1); setImmediate(slice); };'
    + 'slice();',
] as const;

/**
 * Saturate half the machine's threads with {@link BURNER}s until the handles are dropped or this process dies.
 *
 * HALF, not all: the suite under test runs four workers of its own, and a box
 * with nothing left to schedule measures the burners rather than the
 * behaviour of the code. `kill` ends a burner sooner, and killing twice is
 * safe. A burner writes nothing but holds this process's output open, so the
 * ladder's hang detector ends one that outlives the gate.
 */
export function spawnContention(workers: number): Burner[] {
  const burners: Burner[] = [];

  for (let index = 0; index < workers; index += 1) {
    const child = Bun.spawn([...BURNER], {
      cwd: root, stdout: 'inherit', stderr: 'inherit', stdin: 'pipe',
    });

    burners.push({ pid: child.pid, kill: () => { child.kill(); } });
  }

  return burners;
}

/** One run of `command` under whatever contention is live, under the repo's one hang detector (scripts/deadline.ts):
 *  ended once it has written nothing for its bound, however long it runs while writing, and with every process it
 *  leaves behind ended and named. */
export async function hammerOnce(index: number, command: HammerCommand): Promise<HammerRun> {
  const outcome = await runUnderDeadline({ ...command, cwd: root, stdio: 'pipe' });
  const output = `${outcome.stdout}${outcome.stderr}`;
  const counts = reportedCounts(output);

  return {
    index,
    exit: outcome.exitCode,
    seconds: outcome.seconds,
    measured: measuredFiles(output),
    passed: counts.passed,
    failed: counts.failed,
    failing: failingTests(output),
    output,
    killed: outcome.killed,
    leftovers: outcome.leftovers,
  };
}

/** Where the evidence goes. Gitignored and durable — never the temp
 *  directory, which the test preload sweeps. */
export function artifactPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  return join(root, 'bench-artifacts', 'hammer', `${stamp}.json`);
}

/** The line a run prints as it ends. */
function runLine(run: HammerRun, runs: number, command: HammerCommand): string {
  const at = `hammer: run ${String(run.index)}/${String(runs)}:`;

  const head = run.killed
    ? `${at} killed after ${String(command.seconds)}s with no output, ${run.seconds.toFixed(1)}s in; `
      + `${String((run.output.match(/^\(pass\)/gmu) ?? []).length)} test(s) had passed`
    : `${at} ${String(run.passed)} pass, ${String(run.failed)} fail, ${run.seconds.toFixed(1)}s`;

  const notes = [
    ...(run.failing.length === 0 ? [] : [`failing: ${run.failing.join('; ')}`]),
    ...(run.leftovers.length === 0 ? [] : [`${String(run.leftovers.length)} process(es) of its own left running, now ended`]),
  ];

  return [head, ...notes].join(' — ');
}

/** Runs `command` N times, each beside burners spawned for it and ended with it, and answers with every run. Each
 *  run prints its line as it ends, and the write is waited on: the gate's output is then never silent across runs,
 *  so its row's silence bound holds a hung hammer as it holds any gate. */
export async function hammer(runs: number, workers: number, command: HammerCommand = SUITE_RUN): Promise<HammerRun[]> {
  const results: HammerRun[] = [];

  for (let index = 1; index <= runs; index += 1) {
    const burners = spawnContention(workers);

    const run = await hammerOnce(index, command).finally(() => {
      for (const burner of burners) burner.kill();
    });

    await writeFully(process.stdout, `${runLine(run, runs, command)}\n`);
    results.push(run);
  }

  return results;
}

/** Coverage is part of the verdict: an exit-zero run that did not report every governed file stays in red evidence. */
export function completeRun(run: HammerRun, governed: readonly string[]): boolean {
  const files = new Set(run.measured);

  return run.exit === 0 && !run.killed && run.leftovers.length === 0 && run.passed > 0
    && files.size === governed.length && governed.every((file) => files.has(file));
}

/* ── The verdict ──────────────────────────────────────────────────────── */

if (import.meta.main) {
  const selected = process.argv.find((argument) => argument.startsWith('--run='))?.slice('--run='.length);

  if (selected !== undefined && (!Number.isInteger(Number(selected)) || Number(selected) < 1 || Number(selected) > HAMMER_REPEATS)) {
    console.error('hammer: --run must name one of the ' + String(HAMMER_REPEATS) + ' required CI runs');
    process.exit(2);
  }

  const declared = selected === undefined ? (process.env.KINU_HAMMER_RUNS ?? '').trim() : '1';
  const runs = declared === '' ? HAMMER_REPEATS : Number(declared);

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

  if (selected !== undefined) console.log('hammer: independent CI run ' + selected + '/' + String(HAMMER_REPEATS));
  const started = performance.now();
  const results = await hammer(runs, workers);
  const elapsed = (performance.now() - started) / 1000;

  const governedSet = new Set(governed);
  const findings: string[] = [];

  for (const run of results) {
    const label = `run ${String(run.index)}/${String(runs)}`;

    if (run.leftovers.length > 0) {
      findings.push(finding({
        at: label,
        invariant: 'a run ends what it starts',
        found: `it exited with ${String(run.leftovers.length)} process(es) of its own still running, now ended: `
          + run.leftovers.join('; '),
        silently: 'a leftover keeps loading the machine every later run is measured on',
        fix: 'end it in whatever started it',
      }));
    }

    if (run.killed) {
      findings.push(finding({
        at: `${label} (${run.seconds.toFixed(1)}s)`,
        invariant: 'the suite settles under contention',
        found: `it wrote nothing for its ${String(SUITE_RUN.seconds)}s bound and the hang detector ended it`,
        silently: 'a suite that hangs only when the machine is busy reads green on every idle tier',
        fix: `${HAMMER_SUITE}   # under load: run \`bun scripts/hammer.ts\` and read the artifact`,
      }));
      continue;
    }

    if (run.exit !== 0) {
      findings.push(finding({
        at: `${label} (${run.seconds.toFixed(1)}s, ${String(run.failed)} failing test(s))`,
        invariant: 'every run of the suite passes under contention',
        found: `exit ${String(run.exit)}${run.failing.length === 0 ? '' : `, failing ${run.failing.join('; ')}`}`
          + ' — the failing blocks are in the artifact below',
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
    runIndex: selected === undefined ? undefined : Number(selected),
    contentionWorkers: workers,
    cores: cpus().length,
    seconds: Number(elapsed.toFixed(1)),
    governed,
    // EVERY failing run's full block, verbatim. A summary line is not evidence:
    // the interleaving that produced it is only in the output.
    failures: results
      .filter((run) => !completeRun(run, governed))
      .map((run) => ({
        run: run.index,
        exit: run.exit,
        killed: run.killed,
        seconds: Number(run.seconds.toFixed(1)),
        failed: run.failed,
        failing: run.failing,
        leftovers: run.leftovers,
        output: run.output,
      })),
    passes: results
      .filter((run) => completeRun(run, governed))
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
    + '    runs under bun; a race that needs workerd is `bun run test:workerd`\'s.\n'
    + '  - a run that keeps writing and never ends is not killed: its bound is silence, as\n'
    + '    every gate\'s is (scripts/deadline.ts).',
  );
}

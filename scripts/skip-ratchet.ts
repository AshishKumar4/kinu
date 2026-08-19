#!/usr/bin/env bun
/**
 * The skip ratchet: a skipped test is a declared skip or a failure.
 *
 * `bun test ./tests/` reports `3 pass, 19 skip, 0 fail` and exits 0. That is
 * the false green this repo has paid for repeatedly, in its purest form — the
 * four suites that are the ONLY evidence for multi-turn tool calling, memory
 * across a reopen, MCTS evolution and cross-session transfer skipped at every
 * commit, and the exit code said everything was fine. Nineteen tests proving
 * nothing is indistinguishable from nineteen tests proving something when the
 * only thing anyone reads is the exit code.
 *
 * So the set of skipped tests is LOCKED. A test that starts skipping fails this
 * gate; a test that stops skipping fails it too, and the lock is rewritten to
 * record the win. That is strictly stronger than a count: a count of 19 cannot
 * tell you that a different 19 are skipping now.
 *
 * Three things make it more than a bookkeeping exercise.
 *
 *   1. IT PROVES IT EXECUTED. A gate over a test report is only as good as the
 *      report, and an empty report reads as a clean tree. Every target file
 *      must contribute at least one testcase, and the run must have a non-zero
 *      total. `bun test tests` and `bun test tests/` both silently match
 *      NOTHING in this repo — only `./tests/` selects them — so a path typo
 *      here would otherwise produce a green gate over zero tests. That is the
 *      same defect one level up, which is the defect this file exists for.
 *   2. IT NAMES THE COST OF EACH SKIP. The lock stores a reason per entry, so
 *      "19 skips" is a list someone can argue with rather than a number nobody
 *      reads.
 *   3. IT COVERS BOTH RUNNERS. The eval tier has two, split by file extension:
 *      `bun test ./tests/` and `vitest --config vitest.evals.config.ts` over
 *      `tests/evals/**\/*.eval.ts`, which bun's matcher cannot see. This gate
 *      read only the first, so the vitest arm reported 36 tests, 35 skipped and
 *      exit 0 with nothing declaring any of them — the same false green, one
 *      runner over, inside the tier built to prevent it. `./tests/` could not
 *      catch it either: the bun arm satisfies that target by itself, which is
 *      why the vitest arm is named as a FILE.
 *
 * Run it standalone — credential-free, both arms, everything live skips and the
 * ratchet says so — or hand it a live run's reports with one `--junit <path>` per
 * arm so the eval tier does not pay for the suites twice. Add `--expect-live`
 * there: with a target resolved, a locked skip that RAN is the tier working, not
 * debt, and calling it debt made the tier unable to pass on a credentialed
 * machine.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { INFRA_FAILURE_MARKER } from '../packages/test-utils/src/live-model';

const root = new URL('..', import.meta.url).pathname;

/**
 * The bun suites this gate covers, as `bun test` argv. Note `./tests/` — the
 * leading `./` is load bearing, and `assertMeasured` below is what keeps it
 * honest.
 */
export const SKIP_RATCHET_TARGETS: readonly string[] = ['./tests/'];

/**
 * The vitest side of the eval tier, named as FILES rather than a directory.
 *
 * `./tests/` is satisfied by the bun arm alone, so before this existed the gate
 * could not tell a MISSING vitest report from a clean one — and the vitest arm
 * reports 36 tests of which 35 skip, credential-free, exiting 0. That is the
 * exact false green this file exists for, one runner over. `bun test` cannot see
 * these files (it matches only `*.test.*` / `*_test.*` / `*.spec.*`), so they can
 * never appear in the bun report and a directory target cannot distinguish them.
 *
 * ONE ENTRY PER ARM, because `unmatchedTargets` proves a target non-empty and an arm
 * is what can go missing: `eval-tier.sh` runs the behaviour eval and the live swarm
 * eval as separate invocations with separate spend files, so a target naming only the
 * first would be satisfied while the second produced no report at all.
 *
 * A rename therefore fails this gate loudly with the path it looked for, which is
 * the correct outcome: the arm moved and nobody re-pointed the gate at it.
 */
export const SKIP_RATCHET_VITEST_TARGETS: readonly string[] = [
  './tests/evals/behaviour.eval.ts',
  './tests/evals/swarm.eval.ts',
];

/** Every target, both runners. What `unmatchedTargets` proves by default. */
export const ALL_SKIP_RATCHET_TARGETS: readonly string[] = [
  ...SKIP_RATCHET_TARGETS, ...SKIP_RATCHET_VITEST_TARGETS,
];

export const SKIP_LOCK_PATH = resolve(root, 'scripts/skip-ratchet.lock.json');

/** One skipped test, keyed by identity rather than by line so an edit above it
 *  does not read as a new skip. */
export interface SkippedTest {
  /** `<file> › <suite> › <test>` — stable across edits. */
  readonly key: string;
  readonly file: string;
}

/**
 * One failed test and enough of its message to tell WHICH KIND of failure it is.
 *
 * `failures: number` used to be all this carried, so the gate's refusal read
 * `N test failure(s) in the report` for every N — identical whether the model
 * answered wrongly or the deployment never answered at all. In a tier that runs
 * against a live account those are opposite repairs, and a reader who cannot
 * tell them apart goes hunting a behavioural regression during an outage.
 */
export interface FailedTest {
  readonly key: string;
  readonly file: string;
  /** True when the failure was raised at a declared environment boundary —
   *  `infraBoundary` in packages/test-utils/src/live-model.ts marked it. */
  readonly infra: boolean;
}

export interface TestReport {
  readonly total: number;
  readonly failed: readonly FailedTest[];
  readonly skipped: readonly SkippedTest[];
  /** Every file that contributed at least one testcase. */
  readonly files: ReadonlySet<string>;
}

// `&amp;` is replaced LAST: unescaping it first would turn `&amp;lt;` into
// `&lt;` and then into `<`, inventing markup the report never contained.
const XML_ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&',
} satisfies Record<string, string>;

function unescapeXML(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(XML_ENTITIES)) out = out.replaceAll(entity, char);
  return out;
}

function attribute(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] === undefined ? '' : unescapeXML(match[1]);
}

/**
 * Parse a JUnit report from either runner in the eval tier.
 *
 * A `<testcase>` is self-closing when it passed and carries a `<skipped />` or
 * `<failure>` child otherwise, so both forms have to be matched — treating only
 * the self-closing form as a testcase would silently count zero skips, which is
 * the failure mode this gate is about.
 *
 * THE TWO REPORTERS DISAGREE ABOUT WHERE THE FILE IS. Bun writes
 * `file="tests/a.test.ts" classname="Suite A"`; vitest writes no `file` at all
 * and puts the path in `classname`, with the describe path already folded into
 * `name`. Reading only `file` therefore attributed every vitest testcase to the
 * empty string, so `files` came back empty, `unmatchedTargets` called the target
 * missing, and the vitest arm could not be ratcheted at all — measured
 * credential-free at 36 tests, 35 skipped, exit 0, none of them visible here.
 */
export function parseJUnit(xml: string): TestReport {
  const skipped: SkippedTest[] = [];
  const failed: FailedTest[] = [];
  const files = new Set<string>();
  let total = 0;

  const testcase = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    total += 1;
    const classname = attribute(attrs, 'classname');
    const name = attribute(attrs, 'name');
    const declared = attribute(attrs, 'file');
    const file = declared || classname;
    if (file) files.add(file);
    // With the path in `classname` there is no separate suite to name — vitest
    // already joined the describe path into `name` — so spelling one would put
    // the file in the key twice.
    const key = declared ? `${file} › ${classname} › ${name}` : `${file} › ${name}`;
    if (body.includes('<failure')) {
      // The MARKER decides, never a guess at the message. A classifier that
      // sniffed for "timeout" or "503" would let a real behavioural failure hide
      // behind an infrastructure excuse the moment a model wrote one of those
      // words into its answer. Unmarked therefore means behavioural HERE, which
      // under-claims infrastructure rather than over-claiming it — and the
      // refusal below states that so the count is read for what it is.
      failed.push({
        key,
        file,
        infra: unescapeXML(body).includes(INFRA_FAILURE_MARKER),
      });
    }
    if (body.includes('<skipped')) skipped.push({ key, file });
  }
  return { total, failed, skipped, files };
}

/** A locked skip and why it is acceptable. A skip whose reason nobody wrote
 *  down is a skip nobody has to justify. */
const LockEntrySchema = v.object({
  key: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1)),
  /**
   * `key` names a PARAMETRISED FAMILY: every skip whose key begins with it is
   * declared by this one entry, and the entry is satisfied only if at least one
   * did.
   *
   * Legitimate exactly where the cases are GENERATED FROM DATA behind a single
   * `skipIf`, so no individual case can begin skipping on its own, and where the
   * data's own shape is asserted somewhere that runs. Both hold for the behaviour
   * arm: its 34 cases are `corpus × repeats` from one `it.for`, and the corpus is
   * gated credential-free by its own `the corpus is large enough for significance
   * to be reachable`. Enumerating the 34 would restate that assertion worse and
   * couple a commit-tier gate to `PROTEUS_EVAL_REPEATS`.
   *
   * Spell the whole `<file> › <suite>` prefix. A bare file would declare tests
   * nobody looked at, which is this gate's own defect class.
   */
  family: v.optional(v.literal(true)),
});
const LockSchema = v.array(LockEntrySchema);
export type SkipLockEntry = v.InferOutput<typeof LockEntrySchema>;

export function readSkipLock(path = SKIP_LOCK_PATH): SkipLockEntry[] {
  if (!existsSync(path)) return [];
  return v.parse(LockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export interface SkipVerdict {
  /** Skipping now, declared by no entry — new debt. */
  readonly added: readonly string[];
  /** An exact entry that no longer skips, or a family entry nothing matched —
   *  either way the lock owes an update. */
  readonly stale: readonly string[];
}

export function reconcileSkips(
  report: TestReport,
  lock: readonly SkipLockEntry[],
): SkipVerdict {
  const exact = new Set(lock.filter((entry) => entry.family !== true).map((entry) => entry.key));
  const families = lock.filter((entry) => entry.family === true).map((entry) => entry.key);
  const found = report.skipped.map((s) => s.key);
  return {
    added: [...new Set(found.filter((key) =>
      !exact.has(key) && !families.some((prefix) => key.startsWith(prefix))))].sort(),
    stale: [
      ...[...exact].filter((key) => !found.includes(key)),
      ...families.filter((prefix) => !found.some((key) => key.startsWith(prefix))),
    ].sort(),
  };
}

/**
 * Which half of the verdict this run is answerable for.
 *
 * WHAT `stale` MEANS DEPENDS ON WHETHER A TARGET WAS RESOLVED, and nothing but
 * the caller knows that. Credential-free, a locked entry that ran is the lock
 * owing an update and the ratchet tightens. With a target it is the tier doing
 * the one thing it exists for — every locked entry is gated on `skipIf(!TARGET)`
 * — so reading it as debt made `bash scripts/eval-tier.sh` unable to exit 0 on
 * the only kind of machine that pays for it: 25 locked entries run, 25 report
 * stale, exit 1.
 *
 * `added` is debt in BOTH modes, which is the invariant this gate actually owns.
 * There is deliberately no liveness assertion here — `eval-spend.ts
 * --expect-live` already holds the run to a model call and a token count, and a
 * gate restating another gate's policy is the drift this repo keeps paying for.
 */
export function skipDebt(
  verdict: SkipVerdict, opts: { readonly expectLive: boolean },
): readonly string[] {
  return opts.expectLive ? verdict.added : [...verdict.added, ...verdict.stale];
}

/**
 * Every target must have produced at least one testcase.
 *
 * Targets hold path prefixes; a file the report names satisfies the target it
 * sits under. A target matching nothing means the gate looked at an empty set
 * and would have reported clean.
 *
 * A FILE SATISFIES ONLY THE NARROWEST TARGET THAT CLAIMS IT, and that is what
 * makes the two arms independently provable. `tests/evals/behaviour.eval.ts` sits
 * under `./tests/`, so plain prefix matching let EITHER arm satisfy BOTH targets:
 * a run that reported only the vitest arm looked complete, and so did a run that
 * reported only bun. Narrowest-claim gives each arm a target nothing else can
 * answer for.
 */
export function unmatchedTargets(
  report: TestReport,
  targets: readonly string[] = ALL_SKIP_RATCHET_TARGETS,
): readonly string[] {
  const prefixes = targets.map((target) => target.replace(/^\.\//, ''));
  const seen = [...report.files];
  return targets.filter((_target, index) => {
    const prefix = prefixes[index] ?? '';
    return !seen.some((file) => file.startsWith(prefix)
      && !prefixes.some((other) => other.length > prefix.length && file.startsWith(other)));
  });
}

/**
 * Run both arms of the tier and hand back both reports.
 *
 * Both, not one: `bun test` cannot see `*.eval.ts` and vitest is not given the
 * bun suites, so a single runner covers a strict subset of what this gate
 * governs. Running only bun here is what let 35 vitest skips exist outside the
 * lock. `bun --bun` is required for the vitest arm — the spine under test opens
 * its store through `bun:sqlite`, and node-hosted vitest fails at import and
 * collects ZERO tests, which would read as a clean arm.
 */
function runTargets(): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-skip-ratchet-'));
  const arms: readonly { readonly what: string; readonly argv: readonly string[] }[] = [
    { what: 'bun test', argv: ['test', ...SKIP_RATCHET_TARGETS, '--reporter=junit'] },
    {
      what: 'vitest',
      argv: ['--bun', './node_modules/.bin/vitest', 'run', '--config', 'vitest.evals.config.ts',
        '--reporter=junit'],
    },
  ];
  try {
    return arms.map(({ what, argv }, index) => {
      const out = join(dir, `junit-${String(index)}.xml`);
      const result = spawnSync(
        'bun',
        // Bun spells the destination `--reporter-outfile`, vitest `--outputFile`.
        [...argv, what === 'vitest' ? `--outputFile=${out}` : `--reporter-outfile=${out}`],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (!existsSync(out)) {
        throw new Error(
          `skip-ratchet: ${what} produced no JUnit report (exit ${String(result.status)}) — `
          + 'nothing to measure, so the gate cannot pass',
        );
      }
      return readFileSync(out, 'utf8');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One report over every arm's report. Unioned rather than concatenated as text
 *  so a caller cannot accidentally depend on document order. */
export function mergeReports(reports: readonly TestReport[]): TestReport {
  return {
    total: reports.reduce((sum, r) => sum + r.total, 0),
    failed: reports.flatMap((r) => [...r.failed]),
    skipped: reports.flatMap((r) => [...r.skipped]),
    files: new Set(reports.flatMap((r) => [...r.files])),
  };
}

/** Every `--junit <path>` on the command line, in order. Repeatable because the
 *  tier has two runners and hands over one report each; a single-valued flag
 *  silently measured whichever arm the caller happened to name. */
function junitPaths(argv: readonly string[]): readonly string[] | null {
  const paths: string[] = [];
  for (const [index, arg] of argv.entries()) {
    if (arg !== '--junit') continue;
    const path = argv[index + 1];
    if (path === undefined || path.startsWith('--')) return null;
    paths.push(path);
  }
  return paths;
}

function main(argv: readonly string[]): number {
  const lockRequested = argv.includes('--lock');
  // A resolved live target changes what the lock MEANS, not how strict this gate
  // is. Every locked entry is `skipIf(!TARGET)`, so with a target they run — and
  // reading that as `stale` made the eval tier's own ratchet unpassable on the
  // one machine that pays for it. Set from `EXPECT_LIVE` in eval-tier.sh, beside
  // the banner, so the line a reader sees and the mode this runs in agree.
  const expectLive = argv.includes('--expect-live');
  const paths = junitPaths(argv);
  if (paths === null) {
    console.error('skip-ratchet: --junit needs a path');
    return 1;
  }

  const xmls = paths.length === 0 ? runTargets() : paths.map((p) => readFileSync(p, 'utf8'));
  const report = mergeReports(xmls.map(parseJUnit));
  const missing = unmatchedTargets(report);
  if (missing.length > 0) {
    console.error(finding({
      invariant: 'every skip-ratchet target contributes at least one test',
      at: `scripts/skip-ratchet.ts targets: ${missing.join(', ')}`,
      found: `the report names ${String(report.files.size)} file(s), none under those targets`,
      silently: 'the ratchet reconciles an empty skip set against the lock, so every locked '
        + 'entry reads as stale and no new skip can ever be added — a gate over nothing',
      fix: 'a bun target missing is a path-form defect — `bun test tests` and `bun test '
        + 'tests/` both match NOTHING here, only `./tests/` selects the root suites. A '
        + 'vitest target missing means the eval tier ran only its bun arm, or the '
        + '`*.eval.ts` file moved: pass its report with a second --junit, or re-point '
        + 'SKIP_RATCHET_VITEST_TARGETS at where the arm now lives',
    }));
    return 1;
  }

  const measured = assertMeasured('skip-ratchet', [
    ['tests reported', report.total],
    ['files reported', report.files.size],
  ]);

  if (lockRequested) {
    console.error(
      'skip-ratchet: --lock does not write. Each entry needs a REASON, and a reason is '
      + `not something a script can generate. Edit ${SKIP_LOCK_PATH} by hand:\n`
      + JSON.stringify(report.skipped.map((s) => ({ key: s.key, reason: 'TODO' })), null, 2),
    );
    return 1;
  }

  const lock = readSkipLock();
  const verdict = reconcileSkips(report, lock);

  if (report.failed.length > 0) {
    const infra = report.failed.filter((test) => test.infra);
    const behavioural = report.failed.filter((test) => !test.infra);
    console.error(`skip-ratchet: ${String(report.failed.length)} test failure(s) in the report — `
      + `${String(infra.length)} infrastructure, ${String(behavioural.length)} behavioural. `
      + 'Fix those first; the skip set is only meaningful over a run that otherwise passed.');
    if (infra.length > 0) {
      console.error('\n  INFRASTRUCTURE — the environment did not answer. Nothing here is a '
        + 'statement about the agent:');
      for (const test of infra) console.error(`    ${test.key}`);
    }
    if (behavioural.length > 0) {
      console.error('\n  BEHAVIOURAL — or unmarked. A failure counts as infrastructure only '
        + 'where the code raising it said so through `infraBoundary`, so an environment '
        + 'error thrown outside one of those boundaries lands in this list:');
      for (const test of behavioural) console.error(`    ${test.key}`);
    }
    return 1;
  }

  const debt = skipDebt(verdict, { expectLive });
  if (debt.length === 0) {
    console.log(
      `skip-ratchet: ok — ${measured}, ${String(report.skipped.length)} skipped, all declared`
      + (expectLive
        ? `; ${String(verdict.stale.length)} locked skip(s) RAN against the resolved target`
        : ''),
    );
    return 0;
  }

  if (verdict.added.length > 0) {
    console.error(`skip-ratchet: ${String(verdict.added.length)} undeclared skip(s)\n`);
    for (const key of verdict.added) {
      console.error(finding({
        invariant: 'a skipped test is declared in the skip lock with a reason',
        at: key,
        found: 'skipping, and absent from scripts/skip-ratchet.lock.json',
        silently: 'reports as part of a green run while asserting nothing',
        fix: expectLive
          ? 'a target WAS resolved, so this is not a missing credential: either the test '
            + 'skips on something else the target does not supply — name it in the lock — '
            + 'or make it run'
          : 'make it run — or add it to the lock with the reason it cannot, which is a '
            + 'sentence someone will have to defend',
      }));
    }
  }
  if (!expectLive && verdict.stale.length > 0) {
    console.error(
      `\nskip-ratchet: ${String(verdict.stale.length)} locked skip(s) now run. Ratchet down — `
      + `remove these from ${SKIP_LOCK_PATH}:`,
    );
    for (const key of verdict.stale) console.error(`  ${key}`);
  }
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

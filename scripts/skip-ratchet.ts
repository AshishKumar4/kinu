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
 * Two things make it more than a bookkeeping exercise.
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
 *
 * Run it standalone (credential-free — everything skips, and the ratchet says
 * so), or hand it the JUnit file from a live run with `--junit` so the eval
 * tier does not pay for the suites twice.
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
 * The suites this gate covers. Note `./tests/` — the leading `./` is load
 * bearing, and `assertMeasured` below is what keeps it honest.
 */
export const SKIP_RATCHET_TARGETS: readonly string[] = ['./tests/'];

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
 * Parse Bun's JUnit report.
 *
 * A `<testcase>` is self-closing when it passed and carries a `<skipped />` or
 * `<failure>` child otherwise, so both forms have to be matched — treating only
 * the self-closing form as a testcase would silently count zero skips, which is
 * the failure mode this gate is about.
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
    const file = attribute(attrs, 'file');
    if (file) files.add(file);
    const suite = attribute(attrs, 'classname');
    const name = attribute(attrs, 'name');
    if (body.includes('<failure')) {
      // The MARKER decides, never a guess at the message. A classifier that
      // sniffed for "timeout" or "503" would let a real behavioural failure hide
      // behind an infrastructure excuse the moment a model wrote one of those
      // words into its answer. Unmarked therefore means behavioural HERE, which
      // under-claims infrastructure rather than over-claiming it — and the
      // refusal below states that so the count is read for what it is.
      failed.push({
        key: `${file} › ${suite} › ${name}`,
        file,
        infra: unescapeXML(body).includes(INFRA_FAILURE_MARKER),
      });
    }
    if (body.includes('<skipped')) {
      skipped.push({ key: `${file} › ${suite} › ${name}`, file });
    }
  }
  return { total, failed, skipped, files };
}

/** A locked skip and why it is acceptable. A skip whose reason nobody wrote
 *  down is a skip nobody has to justify. */
const LockEntrySchema = v.object({
  key: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1)),
});
const LockSchema = v.array(LockEntrySchema);
export type SkipLockEntry = v.InferOutput<typeof LockEntrySchema>;

export function readSkipLock(path = SKIP_LOCK_PATH): SkipLockEntry[] {
  if (!existsSync(path)) return [];
  return v.parse(LockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export interface SkipVerdict {
  /** Skipping now, absent from the lock — new debt. */
  readonly added: readonly string[];
  /** Locked, no longer skipping — the lock owes an update. */
  readonly stale: readonly string[];
}

export function reconcileSkips(
  report: TestReport,
  lock: readonly SkipLockEntry[],
): SkipVerdict {
  const locked = new Set(lock.map((entry) => entry.key));
  const found = new Set(report.skipped.map((s) => s.key));
  return {
    added: [...found].filter((key) => !locked.has(key)).sort(),
    stale: [...locked].filter((key) => !found.has(key)).sort(),
  };
}

/**
 * Every target must have produced at least one testcase.
 *
 * `SKIP_RATCHET_TARGETS` holds directory prefixes; a file the report names
 * satisfies the target it sits under. A target matching nothing means the gate
 * looked at an empty set and would have reported clean.
 */
export function unmatchedTargets(
  report: TestReport,
  targets: readonly string[] = SKIP_RATCHET_TARGETS,
): readonly string[] {
  const seen = [...report.files];
  return targets.filter((target) => {
    const prefix = target.replace(/^\.\//, '');
    return !seen.some((file) => file.startsWith(prefix));
  });
}

function runTargets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-skip-ratchet-'));
  const out = join(dir, 'junit.xml');
  try {
    const result = spawnSync(
      'bun',
      ['test', ...SKIP_RATCHET_TARGETS, '--reporter=junit', `--reporter-outfile=${out}`],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (!existsSync(out)) {
      throw new Error(
        `skip-ratchet: bun test produced no JUnit report (exit ${String(result.status)}) — `
        + 'nothing to measure, so the gate cannot pass',
      );
    }
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): number {
  const lockRequested = argv.includes('--lock');
  const junitFlag = argv.indexOf('--junit');
  const junitPath = junitFlag >= 0 ? argv[junitFlag + 1] : undefined;
  if (junitFlag >= 0 && junitPath === undefined) {
    console.error('skip-ratchet: --junit needs a path');
    return 1;
  }

  const xml = junitPath === undefined ? runTargets() : readFileSync(junitPath, 'utf8');
  const report = parseJUnit(xml);

  const missing = unmatchedTargets(report);
  if (missing.length > 0) {
    console.error(finding({
      invariant: 'every skip-ratchet target contributes at least one test',
      at: `scripts/skip-ratchet.ts SKIP_RATCHET_TARGETS: ${missing.join(', ')}`,
      found: `the report names ${String(report.files.size)} file(s), none under those targets`,
      silently: 'the ratchet reconciles an empty skip set against the lock, so every locked '
        + 'entry reads as stale and no new skip can ever be added — a gate over nothing',
      fix: 'check the path form: `bun test tests` and `bun test tests/` both match NOTHING '
        + 'in this repo, only `./tests/` selects the root suites',
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

  if (verdict.added.length === 0 && verdict.stale.length === 0) {
    console.log(
      `skip-ratchet: ok — ${measured}, ${String(report.skipped.length)} skipped, all declared`,
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
        fix: 'make it run — or add it to the lock with the reason it cannot, which is a '
          + 'sentence someone will have to defend',
      }));
    }
  }
  if (verdict.stale.length > 0) {
    console.error(
      `\nskip-ratchet: ${String(verdict.stale.length)} locked skip(s) now run. Ratchet down — `
      + `remove these from ${SKIP_LOCK_PATH}:`,
    );
    for (const key of verdict.stale) console.error(`  ${key}`);
  }
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

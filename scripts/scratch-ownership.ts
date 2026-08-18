/**
 * Every temp directory a suite mints has an owner that removes it.
 *
 * This gate exists because the number was watched and nothing acted on it.
 * `scripts/preflight.ts` has reported a rising count of our own leaked scratch
 * all along; on 2026-08-17 it went from 2,434 to 10,124 entries in one evening
 * with fifteen agents running suites, and three of them wrongly blamed that
 * count for an unrelated test failure — a real unowned defect is also a
 * plausible excuse, which is its own cost.
 *
 * WHY THIS IS NOT A THRESHOLD. preflight already argues it and the argument
 * holds: a count of live scratch is legitimately high on a box running many
 * suites at once, so a ceiling would be raised the first time it fired and
 * deleted the second. Free inodes are the runtime invariant and preflight owns
 * them. What can be enforced statically is OWNERSHIP — that the code which
 * mints a directory is the code that gets rid of it — and that is what this
 * checks, at the commit tier, where a new leak is one line old.
 *
 * Three rules, each one a shape that leaked in production:
 *
 *   1. NO UNOWNED UNIQUE NAME. `/tmp/proteus-test-${Date.now()}` is unique,
 *      unowned and unattributable: 5,489 directories of that shape were on the
 *      box, and the name could not say which file made them. Measured source:
 *      `makeAuthFile` in cli-backend's opencode-provider.test.ts, plus four
 *      `dbPath` sites — 16 per suite run, forever.
 *   2. EVERY PREFIX IS CATALOGUED. preflight counts and reclaims by prefix, so a
 *      prefix it does not know is simultaneously uncollected and INVISIBLE. Its
 *      hand-written copy of the list drifted exactly that way and under-reported
 *      our own garbage by ~30% (6,102 of 8,643): `proteus-scaffold-test-`,
 *      `proteus-runtimes-`, `proteus-webhook-`, `proteus-vfs-`, `proteus-gepa-`,
 *      `proteus-codex-auth-`, `proteus-shared-`, `proteus-mcp-test-` and every
 *      `agent-core-*` were unseen. The catalogue now lives beside the minting
 *      helper (`packages/test-utils/src/scratch.ts`) and this gate is what keeps
 *      it complete.
 *   3. EVERY MINTING TEST FILE RELEASES, THROUGH A THROW. A test that fails must
 *      still clean up; "the sweeper catches it later" is how this recurred.
 *      `scratchDir()` satisfies it for free (one process-level release, so no
 *      suite has to remember), and a file that already removes its own scratch
 *      in `afterEach`/`afterAll`/`finally` satisfies it too and is left alone.
 *
 * What it does NOT see: a directory created by a program this repo merely runs
 * (the `external/` clones mint `agent-core-*`), and a leak inside a helper that
 * takes the path as an argument — the mint site is what is checkable, and the
 * mint site is where the name is chosen.
 */

import { readMatching, isTestFile, isParseable } from './sources.ts';
import { assertMeasured, finding } from './gate-ratchet.ts';
import { SCRATCH_PREFIXES, SCRATCH_ROOT_PREFIX } from '@proteus/test-utils';

/**
 * The corpus: every enumerated `.ts` this repo owns. `trackedFiles()` via
 * `readMatching` rather than a private glob, because a gate that selects its own
 * population reports green over whatever it happened to look at — which is the
 * defect `gate-set-equality` exists to refuse, and it refused this gate's first
 * version for exactly that.
 */
const isScannable = (file: string): boolean =>
  isParseable(file) && !file.startsWith('external/') && !file.includes('/dist/');

/**
 * Files held to the RELEASE rule: suites and the fixtures they call. A suite's
 * scratch dies with the suite; a long-running program's does not, and
 * `scripts/nimbus-runtime-probe.ts` minting a directory it hands to an operator
 * is not the defect this gate is about. `isTestFile` is the same predicate
 * `no-ambient-git-in-tests` governs test code with — one spelling, imported.
 */
const isSuiteFile = (file: string): boolean =>
  isTestFile(file) || file.startsWith('packages/test-utils/src/');

/**
 * Files whose CONTENT is the defect on purpose.
 *
 * `scripts/test-preload.ts` owns the throwaway PROTEUS_HOME for every test
 * process AND registers the global release, so holding it to "call the helper"
 * would be circular; its prefix is catalogued, so preflight still sees it.
 *
 * `scripts/scratch-ownership.test.ts` is this gate's own red fixtures — it
 * builds the rejected shapes as strings and asserts they are rejected. It mints
 * nothing. A gate that fires on its own proof gets the proof deleted, which is
 * the same trade as reading code rather than comments.
 *
 * `packages/test-utils/src/scratch.ts` IS the mint: it holds the one
 * `mkdtempSync` every suite now goes through and defines `scratchDir` in the
 * same file, which is the half-migrated shape by construction and the opposite
 * of a defect here.
 */
const EXEMPT = [
  'scripts/test-preload.ts',
  'scripts/scratch-ownership.test.ts',
  'packages/test-utils/src/scratch.ts',
] as const;

/**
 * A temp path composed at the call site instead of minted.
 *
 * ANY interpolation into a `/tmp/` literal, not a list of known uniquifiers:
 * `Date.now()` and `performance.now()` were the first two found and
 * `crypto.randomUUID()` was the third, eight leaked `.sqlite` FILES per run in
 * core's step-persistence suite — a list of spellings would have missed it, and
 * the next one too. The shape is the defect: a name nothing owns.
 */
const UNOWNED_UNIQUE = /['"`][^'"`\n]*\/tmp\/[^'"`\n]*\$\{/;

/**
 * A file that writes to THIS box's filesystem — which is what makes a composed
 * `/tmp/` path a leak rather than a string.
 *
 * Without this, the rule fired on three sites that write nothing here: two
 * prose/`exec.writeFile` paths inside the SANDBOX's own filesystem
 * (core/execution/sandbox.ts, core/release/engine.ts) and one suite asserting on
 * such a path. `:memory:` is excluded from the SQLite arm on purpose — an
 * in-memory database is the one `new Database` that touches no disk, and
 * unit-release-engine.test.ts is exactly that case.
 */
const WRITES_HOST_FILES = /from 'node:fs'|dbPath\s*:|new Database\((?!\s*['"`]:memory:)/;

/** `mkdtempSync(join(tmpdir(), '<prefix>'` — the prefix literal is what
 *  preflight has to recognise. */
const MKDTEMP_PREFIX = /mkdtempSync\(\s*join\(\s*tmpdir\(\)\s*,\s*['"`]([^'"`]+)['"`]/g;

/** Any mint of a directory under the temp dir. `mkdirSync` counts: an eager one
 *  in cli-backend's branch spawner wrote a directory per runtime construction —
 *  107 per suite run — which is how this whole class was found. */
const MINTS = /mkdtempSync\(|mkdirSync\(\s*[^)]*(?:tmpdir\(\)|\/tmp\/)/;

/** A removal that still runs when the test body threw. */
const RELEASES = /afterEach\(|afterAll\(|finally\s*\{/;
const REMOVES = /rmSync\(|\brm\(/;
const USES_HELPER = /\bscratch(?:Dir|Path)\b/;

/** A mint that is NOT the helper — the other half of a half-migrated file. */
const RAW_MINT = /mkdtempSync\(/;

/**
 * Source with comment lines blanked, positions preserved.
 *
 * Rules 1 and 3 read CODE, and this file's own doc comments quote the very
 * shapes they reject — a gate that fires on prose about the defect cannot
 * document the defect, and the first thing anyone would do is stop writing the
 * explanation down. Blanked rather than removed so a reported line number still
 * points at the line the reader has to open.
 */
function code(source: string): string {
  const lines = source.split('\n');
  let inBlock = false;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return '';
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return '';
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
    return line;
  }).join('\n');
}

interface Problem {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface ScratchAudit {
  readonly files: number;
  readonly mintingFiles: number;
  readonly prefixes: readonly string[];
  readonly problems: readonly Problem[];
}

/** Line number of the first match, 1-based, for a finding a reader can open. */
function lineOf(source: string, pattern: RegExp): number {
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (new RegExp(pattern.source).test(line)) return index + 1;
  }
  return 1;
}

export function auditScratchOwnership(sources: ReadonlyMap<string, string>): ScratchAudit {
  const problems: Problem[] = [];
  const prefixes = new Set<string>();
  let mintingFiles = 0;

  for (const [path, source] of sources) {
    if (EXEMPT.some((exempt) => exempt === path)) continue;
    for (const match of code(source).matchAll(MKDTEMP_PREFIX)) {
      const prefix = match[1];
      // A composed prefix is the helper minting its own namespace, which is
      // catalogued by construction — there is no literal to check.
      if (prefix === undefined || prefix.includes('${')) continue;
      prefixes.add(prefix);
      if (!SCRATCH_PREFIXES.some((known) => prefix.startsWith(known))) {
        problems.push({
          rule: 'catalogued',
          file: path,
          line: lineOf(source, new RegExp(`mkdtempSync[^\n]*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
          detail: `mints "${prefix}", which no entry of SCRATCH_PREFIXES covers, so preflight `
            + 'neither counts nor reclaims it',
        });
      }
    }

    const body = code(source);

    if (isSuiteFile(path) && WRITES_HOST_FILES.test(body) && UNOWNED_UNIQUE.test(body)) {
      problems.push({
        rule: 'unowned-unique',
        file: path,
        line: lineOf(body, UNOWNED_UNIQUE),
        detail: 'builds a temp path from a uniquifier, so nothing owns it and its name '
          + 'cannot say which suite minted it',
      });
    }

    // HALF-MIGRATED. Rule 3 below is FILE-level, so the first mint converted to
    // the helper silences it for every raw mint left in the same file — a
    // partial conversion that reads as clean. Two files hit this during the
    // migration that introduced the helper, both with working cleanup for their
    // raw mints, so the cost of the rule is two honest findings and the benefit
    // is that a half-finished conversion cannot hide the rest. (Found by review,
    // as the latent shape: nobody's file was actually leaking through it.)
    if (isSuiteFile(path) && USES_HELPER.test(body) && RAW_MINT.test(body)) {
      problems.push({
        rule: 'half-migrated',
        file: path,
        line: lineOf(body, RAW_MINT),
        detail: 'mints through the helper AND through raw `mkdtempSync`, so this file has two '
          + 'owners and the release rule can no longer see the raw ones. Convert the rest, '
          + 'and drop the cleanup plumbing that then has nothing to clean',
      });
    }

    if (!MINTS.test(body)) continue;
    mintingFiles += 1;
    if (!isSuiteFile(path)) continue;
    if (USES_HELPER.test(body)) continue;
    if (RELEASES.test(body) && REMOVES.test(body)) continue;
    problems.push({
      rule: 'released',
      file: path,
      line: lineOf(body, MINTS),
      detail: 'mints temp scratch and never removes it. Use `scratchDir(label)` from '
        + '@proteus/test-utils, which the preload releases for the whole run — including '
        + 'a run where this file failed — or remove it in afterEach/afterAll/finally',
    });
  }

  return {
    files: sources.size,
    mintingFiles,
    prefixes: [...prefixes].sort(),
    problems,
  };
}

/** The governed corpus, from the one enumeration every gate is measured
 *  against. */
export function readScannableSources(): Map<string, string> {
  return readMatching(isScannable);
}

if (import.meta.main) {
  const audit = auditScratchOwnership(readScannableSources());
  const measured = assertMeasured('scratch-ownership', [
    ['source files read', audit.files],
    ['files that mint temp scratch', audit.mintingFiles],
    ['distinct mkdtemp prefixes', audit.prefixes.length],
    ['catalogued prefixes', SCRATCH_PREFIXES.length],
  ]);
  if (audit.problems.length === 0) {
    console.log(
      `scratch-ownership: ok — ${measured}, every suite that mints releases through `
      + `${SCRATCH_ROOT_PREFIX}* or its own hook`,
    );
    process.exit(0);
  }
  console.error(`scratch-ownership: ${String(audit.problems.length)} unowned scratch site(s)\n`);
  for (const problem of audit.problems) {
    console.error(finding({
      at: `${problem.file}:${String(problem.line)} (${problem.rule})`,
      invariant: 'a suite that mints a temp directory is the code that removes it, and every '
        + 'prefix it uses is one preflight counts',
      found: problem.detail,
      silently: 'the directory survives every run forever. Measured: 10,124 of our own '
        + 'entries in the temp directory in one evening, which then reads as "this test '
        + 'timed out after 5000ms" in whichever suite writes next — never in the one that '
        + 'leaked, and it was blamed for three unrelated failures',
      fix: 'mint through `scratchDir(label)` from @proteus/test-utils, or remove the '
        + 'directory in afterEach/afterAll/finally so a failing assertion still cleans up',
    }));
  }
  process.exit(1);
}

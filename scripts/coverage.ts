#!/usr/bin/env bun
/**
 * Coverage over the UNION of suites the repo's runners claim, not a hand-picked
 * subset.
 *
 * `bash scripts/test.sh --coverage` exists but measures one command's own
 * selection: core + cf-backend + cli-backend + cli in a single `bun test`.
 * Measured 2026-09-01 in this worktree, that is 8,655 tests across 600 files in
 * 339 s and a single merged text table — no agent-utils, no devbox, no
 * compaction, no pc-agent, no scripts gates, no root `tests/`, no workerd
 * layer. A number that names itself "coverage" while missing most of the
 * packages is the same defect as a green CI badge over 339 of 400 files, one
 * level down.
 *
 * What this runs instead, each into its own `coverage/<pkg>` directory as lcov:
 *
 *   bun suites     every bun-discoverable suite, grouped so one `bun test`
 *                  invocation covers one package's own tests (per-package
 *                  lcov, the merge is exact rather than reconstructed)
 *   vitest workerd `packages/cf-backend/tests/workerd` and
 *                  `packages/devbox/tests/workerd` under
 *                  `@cloudflare/vitest-pool-workers` with the istanbul
 *                  provider — the v8 provider cannot work there (it needs
 *                  `node:inspector`, which the Workers runtime has not), and
 *                  the pool says so itself rather than failing silently
 *   node suites    the anti-slop rule suites, which run under raw node via
 *                  `bun run test:anti-slop` (oxlint RuleTester throws under
 *                  bun) — coverage NOT collected, named in the summary
 *
 * The workerd layer is the one place coverage needs a caveat: istanbul
 * instruments the transformed module the pool serves, so the lcov's `SF:` paths
 * are the vite-root-relative forms (e.g. `src/user/device-inflight.ts` for
 * cf-backend). The merge step re-anchors them onto repo-relative paths using
 * each vitest root, so one merged `coverage/lcov.info` stays navigable.
 *
 * Merge correctness is not asserted by hope: `scripts/coverage-merge.test.ts`
 * feeds a two-file fixture pair through the same parser and merger and expects
 * the summed line counts. A merger that dropped or double-counted a record
 * would pass every way but that one.
 *
 * Output:
 *   coverage/lcov.info     one merged lcov over every instrumented suite
 *   coverage/html/         an HTML report over the merged lcov
 *   stdout                 per-package table + the 25 least-covered files,
 *                          the runner that claimed each suite group, and the
 *                          wall time of the whole command
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { trackedTestFiles, bunWouldSkip } from './ladder';
import { isAntiSlopRuleSuite, isBunDiscoverableSuite, isPythonSuite, isVitestEvalSuite } from './sources';
import { parseLcov, mergeLcov } from './coverage-lcov';
import type { LcovRecord } from './coverage-lcov';

const ROOT = new URL('..', import.meta.url).pathname;

/** One runner's suite group: what it runs, where its lcov lands, and the
 *  command that owns it — named so the summary can say WHO claimed a suite
 *  rather than only that somebody did. */
interface SuiteGroup {
  readonly label: string;
  /** The package a merged record is attributed to (directory name). */
  readonly pkg: string;
  /** The exact argv, no shell. */
  readonly argv: readonly string[];
  /** Working directory for the runner, repo-relative. */
  readonly cwd: string;
  /** Where the runner writes lcov (`coverage/<pkg>/lcov.info`). */
  readonly lcovPath: string;
  /** The vitest root, when the runner is a workerd pool; the `SF:` paths in
   *  its lcov are relative to it and must be re-anchored. */
  readonly vitestRoot?: string;
  /** Suites this group runs, repo-relative, for the claimed-count summary. */
  readonly suites: readonly string[];
}

/** Every suite `bun test` can really discover, from the ONE enumeration — the
 *  same `isBunDiscoverableSuite` + `bunWouldSkip` pair `scripts/ladder.ts`
 *  credits a bun gate with, so "what coverage ran" and "what the ladder says a
 *  bun gate runs" cannot drift into two answers. */
function allBunSuites(): string[] {
  return trackedTestFiles()
    .filter((file) => isBunDiscoverableSuite(file) && !bunWouldSkip(file))
    .sort();
}

/**
 * The bun groups, GROUPED FROM THE ENUMERATION rather than from a list of
 * packages. A hand-maintained list is how the next package added to this repo
 * would silently stop being measured — the same defect `sources.ts` exists to
 * prevent one level up. Every bun-discoverable suite is bucketed by the root
 * that owns it: `packages/<name>/**` becomes group `<name>`, `scripts/**`
 * becomes `scripts`, everything else at the root becomes `tests`.
 *
 * Each group runs from the repo ROOT, never with `--cwd`: a per-package
 * bunfig.toml would drop the root `preload` and the `pathIgnorePatterns` that
 * keep `tests/workerd` out of bun's reach (docs/TESTING.md, "A bare package
 * path is a substring filter"). Suites are passed as explicit FILE arguments
 * for the same reason — a bare directory target is a substring filter, and
 * `packages/cli` would sweep `packages/cli-backend` into the wrong group.
 */
function bunGroups(): SuiteGroup[] {
  const buckets = new Map<string, string[]>();
  for (const suite of allBunSuites()) {
    const parts = suite.split('/');
    const owner = suite.startsWith('packages/') ? parts[1] ?? 'packages'
      : suite.startsWith('scripts/') ? 'scripts'
        : 'tests';
    // ONE exception to owner-grouping, and it is measured rather than stylistic.
    // `bun test --coverage` over all 62 `packages/cli` suites dies with
    // `panic(main thread): Segmentation fault` (exit 139, Bun 1.4.0, reproduced
    // twice, bun.report/1.4.0/lt134cbb9aiDskooCmi5jB…), and a crashed process
    // writes NO lcov — so one Bun defect erased the whole package's coverage.
    // Splitting the `.tsx` TUI suites into their own group contains it: the 51
    // `.test.ts` suites report, and if the `.tsx` group still crashes it is
    // named under NO COVERAGE DATA instead of taking the package with it.
    // Delete this branch once a `bun test --coverage` over the whole package
    // survives; the group boundary has no other reason to exist.
    const label = owner === 'cli' && suite.endsWith('.tsx') ? 'cli-tsx' : owner;
    const bucket = buckets.get(label);
    if (bucket === undefined) buckets.set(label, [suite]);
    else bucket.push(suite);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, suites]) => ({
      label,
      // `cli-tsx` is a RUNNER group, not a package: its records belong to cli,
      // and `packageOf` attributes them by path, so the table stays per-package.
      pkg: label === 'cli-tsx' ? 'cli' : label,
      argv: [
        'bun', 'test', '--coverage', '--coverage-reporter=lcov',
        '--coverage-dir', `coverage/${label}`, ...suites,
      ],
      cwd: ROOT,
      lcovPath: `coverage/${label}/lcov.info`,
      suites,
    }));
}

/** The workerd pools. The pool REQUIRES the istanbul provider — its own config
 *  hook throws on `v8` ("V8 native coverage requires `node:inspector` which is
 *  not functional in the Workers runtime") — so the flag is not a choice here. */
function workerdGroups(): SuiteGroup[] {
  // `bunx vitest run --root R tests/workerd/` is the spelling `package.json`'s
  // `test:workerd` and `claims()` already use, spawned as a CHILD PROCESS. No
  // vitest or vite API is imported here on purpose: an import would pull
  // `packages/cf-backend/vite.config` and its `@vitejs/plugin-react` types into
  // the scripts tsconfig program, which is a different program's problem to
  // carry.
  return [
    {
      label: 'cf-backend (workerd)',
      pkg: 'cf-backend',
      argv: [
        'bunx', 'vitest', 'run', '--root', 'packages/cf-backend',
        '--coverage.enabled', '--coverage.provider=istanbul', '--coverage.reporter=lcovonly',
        '--coverage.reportsDirectory=../../coverage/cf-backend-workerd',
        '--coverage.reportOnFailure', 'tests/workerd/',
      ],
      cwd: ROOT,
      lcovPath: 'coverage/cf-backend-workerd/lcov.info',
      vitestRoot: 'packages/cf-backend',
      suites: ['packages/cf-backend/tests/workerd/*.test.ts'],
    },
    {
      label: 'devbox (workerd)',
      pkg: 'devbox',
      argv: [
        'bunx', 'vitest', 'run', '--root', 'packages/devbox',
        '--coverage.enabled', '--coverage.provider=istanbul', '--coverage.reporter=lcovonly',
        '--coverage.reportsDirectory=../../coverage/devbox-workerd',
        '--coverage.reportOnFailure', 'tests/workerd/',
      ],
      cwd: ROOT,
      lcovPath: 'coverage/devbox-workerd/lcov.info',
      vitestRoot: 'packages/devbox',
      suites: ['packages/devbox/tests/workerd/*.test.ts'],
    },
  ];
}

/** A runner family this command does not instrument, with the reason it does
 *  not. The reason is part of the contract: an absence with no reason beside it
 *  is how a suite silently leaves the corpus. */
interface UninstrumentedGroup {
  readonly label: string;
  readonly why: string;
  readonly suites: readonly string[];
}

/** Runner groups that are claimed by the repo's runners but whose coverage
 *  this command does NOT collect. Stated in the summary rather than silent —
 *  a suite absent from the merged lcov with no reason is how coverage
 *  disappears while the number keeps moving. */
function uninstrumentedGroups(): readonly UninstrumentedGroup[] {
  const tracked = trackedTestFiles();
  return [
    {
      label: 'anti-slop rule suites (node)',
      why: 'they run under raw node via `bun run test:anti-slop` because oxlint RuleTester '
        + 'throws under bun; bun coverage cannot see a node process it did not start',
      suites: tracked.filter(isAntiSlopRuleSuite).sort(),
    },
    {
      label: 'python suites (bench)',
      why: 'unittest discovery in bench/; no JS coverage tool instruments Python',
      suites: tracked.filter(isPythonSuite).sort(),
    },
    {
      label: 'vitest eval suites',
      why: 'the eval tier calls a real model when credentialed and is the terminal tier, '
        + 'never a coverage input; its credential-free halves are bun suites covered above',
      suites: tracked.filter(isVitestEvalSuite).sort(),
    },
  ];
}

/** What one runner invocation cost and whether it succeeded. */
interface RunnerOutcome {
  readonly seconds: number;
  readonly ok: boolean;
}

function run(argv: readonly string[], cwd: string): RunnerOutcome {
  const started = performance.now();
  const proc = Bun.spawnSync([...argv], { cwd, stdout: 'inherit', stderr: 'inherit' });
  return { seconds: (performance.now() - started) / 1000, ok: proc.exitCode === 0 };
}

/** Re-anchor a vitest lcov's `SF:` paths onto repo-relative form. The pool's
 *  lcov is relative to the vite root (`src/...`, `tests/workerd/...`), so a
 *  naive merge would produce a second tree the HTML report cannot place. */
function reanchor(record: LcovRecord, vitestRoot: string): LcovRecord {
  if (record.file.startsWith('/') || record.file.includes('..')) return record;
  return { ...record, file: `${vitestRoot}/${record.file}` };
}

/** Per-record package attribution: the first path segment under packages/, or
 *  `scripts` / `tests` for the root suites. */
function packageOf(file: string): string {
  if (file.startsWith('packages/')) return file.split('/')[1] ?? 'packages';
  if (file.startsWith('scripts/')) return 'scripts';
  return 'tests';
}

interface FileCoverage {
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
  branchesHit: number;
  branchesFound: number;
}

function tally(record: LcovRecord): FileCoverage {
  return {
    linesHit: record.lines.hit, linesFound: record.lines.found,
    functionsHit: record.functions.hit, functionsFound: record.functions.found,
    branchesHit: record.branches.hit, branchesFound: record.branches.found,
  };
}

function mergeTally(a: FileCoverage, b: FileCoverage): FileCoverage {
  return {
    linesHit: a.linesHit + b.linesHit, linesFound: a.linesFound + b.linesFound,
    functionsHit: a.functionsHit + b.functionsHit, functionsFound: a.functionsFound + b.functionsFound,
    branchesHit: a.branchesHit + b.branchesHit, branchesFound: a.branchesFound + b.branchesFound,
  };
}

const pct = (hit: number, found: number): string =>
  found === 0 ? '  -  ' : `${((hit / found) * 100).toFixed(1).padStart(5)}%`;

/**
 * Is this record a file of THIS repository?
 *
 * The mutation suites (`packages/core/tests/mutation-*.test.ts`) write mutant
 * copies of production modules into a scratch directory and import them, so
 * every coverage run picks up ~20 files under `$TMPDIR` that exist for
 * milliseconds and belong to no package. They are in bun's own text report
 * too, where they drag the All-files average. A coverage report whose worst
 * files are throwaway copies of the code under test is measuring its own
 * fixtures.
 */
function isRepositoryFile(file: string): boolean {
  return !file.startsWith('/') && !file.startsWith('..');
}

/** Render the merged lcov as a static HTML index. `lcov`/`genhtml` are not on
 *  this box, so this is a small TS renderer over the lcov records: one row per
 *  file, linked per-package sections, and the source files with hit markers
 *  inlined so the report works from a file:// URL with no server. */
function renderHtml(records: readonly LcovRecord[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const esc = (s: string): string =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  const rows = records
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((record) => {
      const c = tally(record);
      return `<tr><td><a href="${encodeURIComponent(record.file)}.html">${esc(record.file)}</a></td>`
        + `<td class="num">${pct(c.linesHit, c.linesFound)}</td>`
        + `<td class="num">${pct(c.functionsHit, c.functionsFound)}</td>`
        + `<td class="num">${pct(c.branchesHit, c.branchesFound)}</td></tr>`;
    })
    .join('\n');

  const totals = records.reduce<FileCoverage>(
    (acc, r) => mergeTally(acc, tally(r)),
    { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0, branchesHit: 0, branchesFound: 0 },
  );

  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Kinu coverage</title>
<style>
 body{font-family:ui-monospace,monospace;margin:2rem;max-width:60rem}
 table{border-collapse:collapse;width:100%}
 td,th{padding:.15rem .6rem;text-align:left;border-bottom:1px solid #ddd}
 td.num,th.num{text-align:right}
 tr:hover{background:#f6f6f6}
</style></head><body>
<h1>Kinu coverage</h1>
<p>${records.length} source files. lines ${pct(totals.linesHit, totals.linesFound)}, functions ${pct(totals.functionsHit, totals.functionsFound)}, branches ${pct(totals.branchesHit, totals.branchesFound)}.</p>
<p>Generated by <code>bun run coverage</code>. The workerd pools are included via the istanbul provider; suites listed as not instrumented by the command's own summary are absent here by reason, not by oversight.</p>
<table><thead><tr><th>file</th><th class="num">lines</th><th class="num">funcs</th><th class="num">branches</th></tr></thead>
<tbody>
${rows}
</tbody></table></body></html>\n`,
  );

  // Per-file source pages with per-line hit markers.
  for (const record of records) {
    const page = filePage(record, esc);
    if (page === undefined) continue;
    const target = join(outDir, `${record.file}.html`);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, page);
  }
}

function filePage(record: LcovRecord, esc: (s: string) => string): string | undefined {
  const abs = join(ROOT, record.file);
  if (!existsSync(abs)) return undefined;
  const source = readFileSync(abs, 'utf8').split('\n');
  const hits = new Map<number, number>();
  for (const da of record.lines.data) hits.set(da.line, da.count);
  const body = source
    .map((line, index) => {
      const count = hits.get(index + 1);
      const mark = count === undefined
        ? '<span class="n">    </span>'
        : count > 0 ? '<span class="y">' + String(count).padStart(4) + '</span>' : '<span class="m">####</span>';
      return `<tr><td class="ln">${index + 1}</td><td class="mk">${mark}</td><td class="src">${esc(line)}</td></tr>`;
    })
    .join('\n');
  const c = tally(record);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(record.file)}</title>
<style>
 body{font-family:ui-monospace,monospace;margin:1rem}
 table{border-collapse:collapse}
 td{padding:0 .5rem;white-space:pre}
 td.ln{color:#999;text-align:right;user-select:none}
 td.mk span.y{color:#0a0}td.mk span.m{color:#d00;font-weight:bold}td.mk span.n{color:#ccc}
</style></head><body>
<h1>${esc(record.file)}</h1>
<p>lines ${pct(c.linesHit, c.linesFound)} · functions ${pct(c.functionsHit, c.functionsFound)} · branches ${pct(c.branchesHit, c.branchesFound)}
 · <a href="../index.html">index</a></p>
<table>${body}</table></body></html>\n`;
}

function writeSummaryJson(
  pkgTallies: Map<string, FileCoverage>,
  seconds: number,
  groups: readonly SuiteGroup[],
  withoutLcov: readonly string[],
): void {
  const perPackage = [...pkgTallies.entries()]
    .map(([name, t]) => ({
      package: name,
      lines: { hit: t.linesHit, found: t.linesFound, pct: t.linesFound === 0 ? null : Number(((t.linesHit / t.linesFound) * 100).toFixed(2)) },
      functions: { hit: t.functionsHit, found: t.functionsFound, pct: t.functionsFound === 0 ? null : Number(((t.functionsHit / t.functionsFound) * 100).toFixed(2)) },
      branches: { hit: t.branchesHit, found: t.branchesFound, pct: t.branchesFound === 0 ? null : Number(((t.branchesHit / t.branchesFound) * 100).toFixed(2)) },
    }))
    .sort((a, b) => a.package.localeCompare(b.package));
  const payload = {
    generatedAt: new Date().toISOString(),
    totalWallSeconds: Number(seconds.toFixed(1)),
    packages: perPackage,
    runnerGroups: groups.map((g) => ({ label: g.label, suites: g.suites.length })),
    groupsWithoutCoverageData: withoutLcov,
  };
  writeFileSync(join(ROOT, 'coverage', 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<number> {
  const started = performance.now();
  // `--merge-only` re-merges and re-renders from the per-package lcov files a
  // previous run left on disk. It exists because the merge and the report are
  // where the defects live, and a 32-minute suite re-run to test a renderer is
  // how a report stops being tested at all.
  const mergeOnly = process.argv.includes('--merge-only');
  if (!mergeOnly) {
    rmSync(join(ROOT, 'coverage'), { recursive: true, force: true });
    mkdirSync(join(ROOT, 'coverage'), { recursive: true });
  }

  const groups = [...bunGroups(), ...workerdGroups()];
  const failures: string[] = [];

  console.log(mergeOnly
    ? '→ coverage: merge and report only, over the lcov files already on disk\n'
    : '→ coverage over the union of claimed suites\n');
  for (const group of groups) {
    if (mergeOnly) {
      if (!existsSync(join(ROOT, group.lcovPath))) {
        failures.push(`${group.label}: no lcov at ${group.lcovPath}`);
      }
      continue;
    }
    console.log(`── ${group.label}  (${group.suites.length} suites)`);
    const { seconds, ok } = run(group.argv, group.cwd);
    console.log(`   ${ok ? 'ok' : 'FAILED'}  ${group.label}  (${seconds.toFixed(1)}s)\n`);
    if (!ok) failures.push(group.label);
    if (!existsSync(join(ROOT, group.lcovPath))) {
      // A runner that passes but writes no lcov is a coverage number made of
      // nothing; fail the command rather than merging absence.
      failures.push(`${group.label}: no lcov at ${group.lcovPath}`);
    }
  }

  const merged: LcovRecord[] = [];
  const pkgTallies = new Map<string, FileCoverage>();
  /** Groups whose lcov is absent: the runner crashed or wrote nothing. Named
   *  in the summary, because a package whose own suites contributed NO records
   *  still shows a percentage from other groups' transitive imports, and that
   *  number read as the package's coverage would be a lie. */
  const withoutLcov: string[] = [];
  for (const group of groups) {
    const path = join(ROOT, group.lcovPath);
    if (!existsSync(path)) {
      withoutLcov.push(group.label);
      continue;
    }
    const records = parseLcov(readFileSync(path, 'utf8')).filter((r) => isRepositoryFile(r.file));
    const vitestRoot = group.vitestRoot;
    const anchored = vitestRoot === undefined ? records : records.map((r) => reanchor(r, vitestRoot));
    const mergedRecords = mergeLcov([...merged, ...anchored]);
    merged.length = 0;
    merged.push(...mergedRecords);
  }
  for (const record of merged) {
    const pkg = packageOf(record.file);
    const t = tally(record);
    const prior = pkgTallies.get(pkg);
    pkgTallies.set(pkg, prior === undefined ? t : mergeTally(prior, t));
  }
  // A merged artifact over no file records is a coverage number made of
  // nothing. Every group can pass while writing an empty lcov, so the merge
  // itself is what has to refuse it — the same liveness rule
  // `coverage:check` holds on the artifact from the other side.
  if (merged.length === 0) {
    failures.push('merged lcov holds no file records');
  }

  // THE MERGED ARTIFACTS. Written even when a runner failed, so a red run
  // still shows what was measured; exit code carries the failure.
  writeFileSync(join(ROOT, 'coverage', 'lcov.info'), mergeLcov(merged).map((r) => r.raw).join(''));
  renderHtml(mergeLcov(merged), join(ROOT, 'coverage', 'html'));

  const uninstrumented = uninstrumentedGroups();
  console.log('┌────────────────────────────────────────────┬────────┬─────────┬──────────┬─────────┐');
  console.log('│ package                                    │  lines │  funcs  │ branches │  files  │');
  console.log('├────────────────────────────────────────────┼────────┼─────────┼──────────┼─────────┤');
  const total = { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0, branchesHit: 0, branchesFound: 0, files: 0 };
  for (const [pkg, t] of [...pkgTallies.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `│ ${pkg.padEnd(42)} │ ${pct(t.linesHit, t.linesFound)} │ ${pct(t.functionsHit, t.functionsFound)} │ ${pct(t.branchesHit, t.branchesFound)} │ ${String(merged.filter((r) => packageOf(r.file) === pkg).length).padStart(7)} │`,
    );
    total.linesHit += t.linesHit; total.linesFound += t.linesFound;
    total.functionsHit += t.functionsHit; total.functionsFound += t.functionsFound;
    total.branchesHit += t.branchesHit; total.branchesFound += t.branchesFound;
    total.files += merged.filter((r) => packageOf(r.file) === pkg).length;
  }
  console.log('├────────────────────────────────────────────┼────────┼─────────┼──────────┼─────────┤');
  console.log(
    `│ ${'TOTAL'.padEnd(42)} │ ${pct(total.linesHit, total.linesFound)} │ ${pct(total.functionsHit, total.functionsFound)} │ ${pct(total.branchesHit, total.branchesFound)} │ ${String(total.files).padStart(7)} │`,
  );
  console.log('└────────────────────────────────────────────┴────────┴─────────┴──────────┴─────────┘\n');

  const worst = merged
    .map((record) => ({ record, t: tally(record) }))
    .filter(({ t }) => t.linesFound > 0)
    .sort((a, b) => (a.t.linesHit / a.t.linesFound) - (b.t.linesHit / b.t.linesFound))
    .slice(0, 25);
  console.log('25 least-covered source files by line %:');
  for (const { record, t } of worst) {
    console.log(
      `  ${pct(t.linesHit, t.linesFound)}  ${String(t.linesFound).padStart(4)} lines  ${record.file}`,
    );
  }

  console.log('\nnot instrumented (named, never silently absent):');
  for (const group of uninstrumented) {
    console.log(`  ${group.label} — ${group.suites.length} suites: ${group.why}`);
  }
  if (withoutLcov.length > 0) {
    console.log('\nNO COVERAGE DATA — these groups produced no lcov, so their package rows above');
    console.log('carry only what OTHER groups imported transitively. Do not read those as the');
    console.log(`package's coverage: ${withoutLcov.join(', ')}`);
  }

  const seconds = (performance.now() - started) / 1000;
  writeSummaryJson(pkgTallies, seconds, groups, withoutLcov);
  console.log(`\ncoverage: ${merged.length} files → coverage/lcov.info, coverage/html/index.html`);
  console.log(`coverage total wall time: ${seconds.toFixed(1)}s`);

  if (failures.length > 0) {
    console.error(`\nFAILED groups: ${failures.join('; ')}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());

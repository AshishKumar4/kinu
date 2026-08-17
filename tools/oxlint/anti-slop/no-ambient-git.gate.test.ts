// Proteus-only gate; see upstream.json's `proteusRules` and `proteusRuleGates`.
//
// `rules/no-ambient-git-in-tests.test.ts` proves the rule function behaves. It does not prove the
// rule is reachable through the command the repo gates on, that it is enabled at error, or that
// there are any test files for it to look at. This file runs the real `oxlint` binary with the real
// `.oxlintrc.json` over the historical defect and over its corrected form, asserts red then green,
// and asserts the live denominator.
//
// The denominator matters unusually much here. The rule is scoped to `*.test.ts` by filename. If the
// suffix convention changed, or the sources moved, the rule would match nothing, report nothing, and
// be indistinguishable from a clean tree — which is precisely the failure it exists to prevent in
// another form.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { isParseable, isTestFile, trackedFiles } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

type Diagnostic = { readonly code?: string; readonly filename?: string };
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

/**
 * The fixture exactly as `packages/core/tests/unit-workspace-diff.test.ts:264-270` stood before the
 * repair. Every one of these five calls executed against the REAL repository during `git push`,
 * because the pre-push hook exports `GIT_DIR` and git obeys it over `cwd`. Between them they left
 * commits named `seed` on the branch being pushed, set `user.name=Proteus Test` repository-wide, and
 * set `core.bare=true` beside `core.worktree` — after which every git command in the primary
 * checkout answered `fatal: unable to set up work tree using invalid config`.
 *
 * Pinned by digest so it cannot be quietly reworded into something the rule happens to catch.
 */
const HISTORICAL_FIXTURE = `    const repo = mkdtempSync(join(tmpdir(), 'proteus-output-diff-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'proteus@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Proteus Test'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'before\\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
`;
const HISTORICAL_DIGEST = createHash("sha256").update(HISTORICAL_FIXTURE).digest("hex");
const HISTORICAL_SOURCE = {
  commit: "d9a7daf7c~1",
  path: "packages/core/tests/unit-workspace-diff.test.ts",
  lines: [264, 270] as const,
};

const historical = spawnSync(
  "git",
  ["show", `${HISTORICAL_SOURCE.commit}:${HISTORICAL_SOURCE.path}`],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (historical.status === 0) {
  const [from, to] = HISTORICAL_SOURCE.lines;
  const actual = `${historical.stdout.split("\n").slice(from - 1, to).join("\n")}\n`;
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    HISTORICAL_DIGEST,
    `${HISTORICAL_SOURCE.path}:${from}-${to} at ${HISTORICAL_SOURCE.commit} is not the fixture this gate claims to replay; got:\n${actual}`,
  );
} else {
  process.stdout.write(
    `no-ambient-git: ${HISTORICAL_SOURCE.commit} unreachable from this checkout; fixture verified by pinned digest only\n`,
  );
}

const PRELUDE = `declare function execFileSync(file: string, args: string[], options?: unknown): string;
declare function mkdtempSync(prefix: string): string;
declare function writeFileSync(path: string, data: string): void;
declare function join(...parts: string[]): string;
declare function tmpdir(): string;
declare function git(repo: string, ...args: string[]): string;
declare function initRepo(repo: string): void;
export const run = (): void => {
`;

const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
  /** The historical defect is five spawns, so red is five findings, not one. A rule that fired once
   *  on this fixture would be matching the file rather than the call. */
  readonly expected: number;
}> = [
  {
    rule: "no-ambient-git-in-tests",
    expected: 5,
    bad: `${PRELUDE}${HISTORICAL_FIXTURE}};\n`,
    good: `${PRELUDE}    const repo = mkdtempSync(join(tmpdir(), 'proteus-output-diff-'));
    initRepo(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'before\\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-qm', 'seed');
};\n`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/** The lint's own exclusions, read from the config so this count cannot claim a file oxlint skips. */
const ignorePatterns: readonly string[] = config.ignorePatterns ?? [];

/**
 * The live denominator, and it must be the set the rule GOVERNS rather than the set a regex
 * matches. Deriving it from `TEST_FILE` over `git ls-files` alone certified 646 files while the
 * rule could reach 448 — the third appearance of this shape in this gate. Two whole populations
 * were being counted that oxlint never sees:
 *
 *   168 files it cannot parse (159 `.patch`, 5 `.jsonl`, 4 `.py`), swept in by the directory arm
 *       once it started matching everything under `tests/` — `tests/bench/patches/` is data.
 *    30 files inside `.oxlintrc.json`'s own `ignorePatterns`, which is this plugin's directory.
 *       Read from the config rather than hardcoded, so the two cannot drift apart. That blind
 *       spot is where THIS FILE lives, and it holds bare `git` spawns of its own (the
 *       `git show` calls below): the rule cannot govern its own gate, and the count must not
 *       pretend otherwise.
 *
 * Reported as a partition that has to add up, so a fourth category cannot appear silently.
 *
 * The enumeration and both predicates come from `scripts/sources.ts`. This held a `git ls-files`
 * of its own — tracked-only, so a brand-new test file was outside the count while being inside
 * the lint — and its own `/\.[cm]?[jt]sx?$/`. `isTestFile` is the rule's whole pattern and
 * `isParseable` is what oxc can read, so all three sets are the ones every other gate divides by.
 */
function corpus(): {
  readonly counted: number;
  readonly governed: number;
  readonly unparsable: number;
  readonly ignoredByConfig: number;
  readonly remedyExports: readonly string[];
} {
  const counted = trackedFiles().filter(isTestFile);
  const parsable = counted.filter(isParseable);
  const ignored = parsable.filter((file) =>
    ignorePatterns.some((pattern) => file === pattern || file.startsWith(`${pattern}/`)),
  );

  const helper = join(repoRoot, "packages/test-utils/src/git.ts");
  const source = readFileSync(helper, "utf8");
  const remedyExports = ["git", "gitEnv", "initRepo"].filter((name) =>
    new RegExp(`export (function|const) ${name}\\b`).test(source),
  );
  return {
    counted: counted.length,
    governed: parsable.length - ignored.length,
    unparsable: counted.length - parsable.length,
    ignoredByConfig: ignored.length,
    remedyExports,
  };
}

const { counted, governed, unparsable, ignoredByConfig, remedyExports } = corpus();
assert.ok(
  governed > 0,
  `${counted} files match the rule's TEST_FILE pattern but 0 of them are inside the lint: it would match nothing by construction`,
);
assert.equal(
  counted,
  governed + unparsable + ignoredByConfig,
  "the corpus partition does not add up, so one of these populations is being counted twice or not at all",
);
assert.deepEqual(
  [...remedyExports].sort(),
  ["git", "gitEnv", "initRepo"],
  "packages/test-utils/src/git.ts no longer exports the helpers this rule's message tells people to use",
);

// The remedy must actually be adopted, not merely available: zero raw `git` spawns should remain in
// any tracked test file. This is the assertion that turns the rule from a promise into a fact.
// The WHOLE tree, not `packages`. Scoping this to `packages` is the first thing I got wrong: the
// rule's first run over the full repo found three more live sites the narrow scan had not looked at
// — two in scripts/bench.test.ts and one in scripts/ladder.test.ts. A gate whose live-tree
// assertion covers less than the lint it claims to enforce reports zero and means nothing.
const offenders = spawnSync(
  "./node_modules/.bin/oxlint",
  ["-c", ".oxlintrc.json", "-f", "json", "."],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
assert.ok(offenders.stdout.length > 0, `oxlint produced no JSON over packages:\n${offenders.stderr}`);
const live: LintReport = JSON.parse(offenders.stdout);
const liveHits = live.diagnostics.filter((d) => d.code === "anti-slop(no-ambient-git-in-tests)");
assert.equal(
  liveHits.length,
  0,
  `the tree still spawns git from ${liveHits.length} test site(s) with the ambient environment: ${JSON.stringify(liveHits.map((d) => d.filename))}`,
);

/**
 * THE BOUNDARY, pinned in both directions, because "the rule catches git spawns" is not a testable
 * sentence and the interesting failures are on the edges.
 *
 * Every row is seeded into a real file and run through the real `oxlint`, so this table is measured
 * rather than reasoned about. That distinction is not pedantry here: the first version of this rule
 * knew two of Bun's three spawn spellings and none of the shell family's, and an adversarial pass
 * found the one live site in the tree it could not see — `packages/cli/tests/cc-corpus.test.ts`
 * asking `git check-ignore` whether the owner's mined transcripts are ignored, with `cwd` and
 * nothing else, while this gate asserted zero. `cwd` was not protecting it: with GIT_DIR pointed at
 * another repository the same question answers NOT-IGNORED.
 *
 * The `caught: false` rows are the limit, on the record so the next reader inherits it. Three need
 * name resolution the rule does not have; the fourth would have to read shell strings inside
 * argument arrays, which fires on every test that merely ASSERTS about a git command line, and this
 * repo has those. A rule that cried wolf there would be disabled within a week.
 */
const BOUNDARY: ReadonlyArray<{
  readonly file: string;
  readonly code: string;
  readonly caught: boolean;
}> = [
  // Shapes that must fire.
  { file: "b01.test.ts", code: "execFileSync('git', ['status'], { cwd: repo });", caught: true },
  { file: "b02.test.ts", code: "spawnSync(['git', 'status'], { cwd: repo });", caught: true },
  { file: "b03.test.ts", code: "execFileSync('/usr/bin/git', ['status'], { cwd: repo });", caught: true },
  { file: "b04.test.ts", code: "execFileSync('git.exe', ['status'], { cwd: repo });", caught: true },
  { file: "b05.test.ts", code: "childProcess.execFileSync('git', ['status'], { cwd: repo });", caught: true },
  { file: "b06.test.ts", code: "childProcess?.execFileSync?.('git', ['status'], { cwd: repo });", caught: true },
  { file: "b07.test.ts", code: "execFileSync('git', ['status']);", caught: true },
  { file: "b08.test.ts", code: "Bun.spawnSync(['git', 'status'], { cwd: repo });", caught: true },
  // The live site's shape: Bun's single-object form, which `spawnedProgram` did not read.
  { file: "b09.test.ts", code: "Bun.spawnSync({ cmd: ['git', 'check-ignore', '-q', p], cwd: repo });", caught: true },
  // The shell family takes a command LINE, so the program is the first token.
  { file: "b10.test.ts", code: "execSync('git status', { cwd: repo });", caught: true },
  { file: "b11.test.ts", code: "execSync(`git status`, { cwd: repo });", caught: true },
  { file: "b12.test.ts", code: "spawnSync('git status', { shell: true, cwd: repo });", caught: true },
  // `Bun.$` has no options object at all.
  { file: "b13.test.ts", code: "await Bun.$`git commit -m seed`;", caught: true },
  { file: "b14.test.ts", code: "await Bun.$`git status`.nothrow().quiet();", caught: true },
  // The scope arms: a `.eval.` suffix, and a helper under `tests/` with no suffix at all.
  { file: "b15.eval.ts", code: "execFileSync('git', ['worktree', 'add', d], { cwd: repo });", caught: true },
  { file: "tests/build-repo.ts", code: "execFileSync('git', ['init', '-q'], { cwd: scratch });", caught: true },

  // Green states: the environment is named, so the author has thought about it.
  { file: "g01.test.ts", code: "execFileSync('git', ['status'], { cwd: repo, env: gitEnv() });", caught: false },
  { file: "g02.test.ts", code: "Bun.spawnSync({ cmd: ['git', 'x'], cwd: repo, env: gitEnv() });", caught: false },
  { file: "g03.test.ts", code: "await Bun.$`git status`.env(gitEnv());", caught: false },
  { file: "g04.test.ts", code: "await Bun.$`git status`.nothrow().quiet().env(gitEnv());", caught: false },
  { file: "g05.test.ts", code: "git(work, 'add', '-A');", caught: false },
  { file: "g06.test.ts", code: "spawnSync('bash', ['-n', script], { cwd: repo });", caught: false },
  { file: "g07.test.ts", code: "await Bun.$`ls -la ${dir}`;", caught: false },
  // A test that merely ASSERTS about a git command line is not a spawn. This row is why the
  // `sh -c` evasion below is left alone: catching it means reading argument strings, and this
  // shape is real — packages/cf-backend/tests/unit-tool-call-grouping.test.ts is full of it.
  { file: "g08.test.ts", code: "expect(describeCommand('git commit -m x')).toBe('Git commit');", caught: false },

  // Known missed, deliberately. Each needs resolution this rule does not do.
  { file: "m01.test.ts", code: "const bin = 'git';\nspawnSync(bin, ['status'], { cwd: repo });", caught: false },
  { file: "m02.test.ts", code: "import { execFileSync as run } from 'node:child_process';\nrun('git', ['status'], { cwd: repo });", caught: false },
  { file: "m03.test.ts", code: "const execp = promisify(exec);\nawait execp('git status', { cwd: repo });", caught: false },
  { file: "m04.test.ts", code: "spawnSync('sh', ['-c', 'git commit -m seed'], { cwd: repo });", caught: false },
];

const boundaryDirectory = mkdtempSync(join(repoRoot, ".no-ambient-git-boundary-"));
try {
  for (const { file, code } of BOUNDARY) {
    const absolute = join(boundaryDirectory, file);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, `${code}\n`);
  }
  const run = spawnSync(
    "./node_modules/.bin/oxlint",
    ["-c", ".oxlintrc.json", "-f", "json", relative(repoRoot, boundaryDirectory)],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ok(run.stdout.length > 0, `oxlint produced no JSON for the boundary table:\n${run.stderr}`);
  const report: LintReport = JSON.parse(run.stdout);
  assert.equal(
    report.number_of_files,
    BOUNDARY.length,
    `oxlint linted ${report.number_of_files} of ${BOUNDARY.length} boundary rows; a skipped row proves nothing about its shape`,
  );
  const fired = new Set(
    report.diagnostics
      .filter((d) => d.code === "anti-slop(no-ambient-git-in-tests)")
      .map((d) => (d.filename ?? "").split("/").at(-1)),
  );
  const wrong = BOUNDARY.filter(
    (row) => fired.has(row.file.split("/").at(-1)) !== row.caught,
  ).map((row) => `${row.caught ? "expected CAUGHT, was silent" : "expected silent, fired"}: ${row.code}`);
  assert.deepEqual(wrong, [], `the rule's boundary moved:\n  ${wrong.join("\n  ")}`);
  process.stdout.write(
    `no-ambient-git: boundary pinned — ${BOUNDARY.filter((r) => r.caught).length} shapes caught, ` +
      `${BOUNDARY.filter((r) => !r.caught).length} silent (green states and documented limits)\n`,
  );
} finally {
  rmSync(boundaryDirectory, { recursive: true, force: true });
}

const fixtures = mkdtempSync(join(repoRoot, ".no-ambient-git-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { rule, bad, good } of cases) {
    // The rule is scoped by FILENAME, so the fixtures must be named like tests. A fixture written as
    // `<rule>.ts` would be green in both directories and the gate would prove nothing.
    writeFileSync(join(badDirectory, `${rule}.test.ts`), bad);
    writeFileSync(join(goodDirectory, `${rule}.test.ts`), good);
  }

  const lint = (directory: string): LintReport => {
    const run = spawnSync(
      "./node_modules/.bin/oxlint",
      ["-c", ".oxlintrc.json", "-f", "json", relative(repoRoot, directory)],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${directory}:\n${run.stderr}`);
    const report: LintReport = JSON.parse(run.stdout);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    assert.ok(
      report.number_of_rules > 0,
      `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
    );
    return report;
  };

  const firedIn = (diagnostics: ReadonlyArray<Diagnostic>, rule: string): number =>
    diagnostics.filter(
      (d) => d.code === `anti-slop(${rule})` && (d.filename ?? "").endsWith(`${rule}.test.ts`),
    ).length;

  const red = lint(badDirectory).diagnostics;
  const green = lint(goodDirectory).diagnostics;

  for (const { rule, expected } of cases) {
    assert.equal(
      firedIn(red, rule),
      expected,
      `anti-slop/${rule} fired ${firedIn(red, rule)} times on ${expected} seeded defects through \`oxlint -c .oxlintrc.json\``,
    );
    assert.equal(
      firedIn(green, rule),
      0,
      `anti-slop/${rule} fires on the corrected form, so the cutover has no green state to reach`,
    );
  }

  process.stdout.write(
    `no-ambient-git: ${cases.length} rule proven red->green through oxlint over ${governed} governed test files ` +
      `(${counted} match TEST_FILE: ${unparsable} unparsable by oxlint, ${ignoredByConfig} inside ignorePatterns), ` +
      `0 raw git spawns remaining\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

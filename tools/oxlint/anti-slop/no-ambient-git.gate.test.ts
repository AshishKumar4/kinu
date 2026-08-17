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

import { TEST_FILE } from "./rules/no-ambient-git-in-tests.ts";

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

/**
 * The live denominator. The rule keys on the `.test.ts` suffix and on a spawn helper's name, so
 * three things can each take it to zero on its own: the test files existing at all, the spawn
 * helpers being the ones it knows, and `@proteus/test-utils` still exporting the remedy the message
 * points at. A rule whose message names a helper nobody exports is advice, not a gate.
 */
function corpus(): { readonly testFiles: number; readonly remedyExports: readonly string[] } {
  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(tracked.status, 0, "git ls-files failed; the corpus cannot be counted");
  // The rule's OWN pattern, imported rather than restated. A copy here would be
  // free to drift narrower than the rule, and then this count would certify a
  // population the rule does not govern — the same defect, one level up, and the
  // one that already hid three sites in scripts/.
  const testFiles = tracked.stdout.split("\n").filter((file) => TEST_FILE.test(file)).length;

  const helper = join(repoRoot, "packages/test-utils/src/git.ts");
  const source = readFileSync(helper, "utf8");
  const remedyExports = ["git", "gitEnv", "initRepo"].filter((name) =>
    new RegExp(`export (function|const) ${name}\\b`).test(source),
  );
  return { testFiles, remedyExports };
}

const { testFiles, remedyExports } = corpus();
assert.ok(
  testFiles > 0,
  "found 0 files matching the `.test.ts` suffix this rule is scoped to; it would match nothing by construction",
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
    `no-ambient-git: ${cases.length} rule proven red->green through oxlint over ${testFiles} test files, 0 raw git spawns remaining\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

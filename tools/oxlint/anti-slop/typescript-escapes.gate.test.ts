// Proteus-only gate. NOT a plugin-rule gate: `typescript/no-explicit-any` and
// `typescript/ban-ts-comment` are oxlint BUILT-INS, so they carry no rule file, no RuleTester suite
// and no entry in `upstream.json`'s `proteusRules`/`proteusRuleGates` — those two lists partition
// the rules authored in this plugin, and naming a built-in there would claim authorship of upstream
// code. What is local here is the POLICY in `.oxlintrc.json`, and policy is exactly what can be
// weakened without deleting anything, so it needs a gate of its own.
//
// Both rules were off until KINU-069. A live `(...args: any[])` wrapper sat in
// `packages/cli/src/program.ts` and a described `@ts-expect-error` sat in
// `scripts/fixtures/payload-transport/worker.ts`, neither reported by any check the repo ran.
//
// This gate exists because for these two rules, "enabled" is not one bit. Each has an option whose
// default is LOOSER than the policy, and each of those defaults would have re-admitted one of the
// two historical defects while the rule stayed listed at "error" and the config still looked strict:
//
//   no-explicit-any   `ignoreRestArgs: true` re-admits `(...args: any[])` — the program.ts shape.
//   ban-ts-comment    `"ts-expect-error": "allow-with-description"` (the rule's OWN default)
//                     re-admits a described suppression — the worker.ts shape, which carried the
//                     description "-- bundled as raw text by wrangler rules, not as a module".
//
// So asserting the two names appear at "error" proves nothing on its own. Every fixture below is
// therefore chosen to be a shape the loose option would let through: each red case fails under the
// policy and would PASS under the corresponding default, which is what makes the gate unable to
// stop failing quietly. The config options are also asserted structurally, so weakening fails twice
// — once on the declaration and once on the behaviour.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isParseable, trackedFiles } from "../../../scripts/sources.ts";

const repoRoot = process.cwd();

/** `oxlint -f json`. `code` is spelled `typescript(no-explicit-any)`, and is ABSENT on a parse
 *  failure, because no rule produced it. */
type Diagnostic = {
  readonly code?: string;
  readonly filename?: string;
  readonly message?: string;
};
type LintReport = {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
  readonly number_of_rules: number;
};

/**
 * One fixture file per case. Keyed by file rather than by rule because a rule needs more than one
 * red shape here: `ban-ts-comment` is three independently configurable directives, and a policy
 * that banned `@ts-expect-error` while quietly re-allowing `@ts-ignore` would leave the codebase
 * exactly one rename away from an unchecked suppression.
 *
 * `good` is the corrected form of the same code, not merely different code — for the two shapes
 * taken from history it is the correction that actually landed in KINU-069.
 */
const cases: ReadonlyArray<{
  readonly file: string;
  readonly rule: string;
  readonly defeats: string;
  readonly bad: string;
  readonly good: string;
}> = [
  {
    file: "explicit-any-annotation",
    rule: "no-explicit-any",
    defeats: "the rule being absent altogether",
    bad: `export interface Reply { readonly ok: boolean; }
export function reply(ok: boolean): any {
  return { ok };
}
`,
    good: `export interface Reply { readonly ok: boolean; }
export function reply(ok: boolean): Reply {
  return { ok };
}
`,
  },
  {
    // The program.ts:482 shape, with the fix that replaced it. `ignoreRestArgs: true` reports
    // nothing here, so this case is what pins that option off.
    file: "explicit-any-rest-args",
    rule: "no-explicit-any",
    defeats: "ignoreRestArgs: true",
    bad: `export type ActionHandler = (...args: any[]) => Promise<void>;
`,
    good: `export type ActionHandler<Args extends readonly unknown[]> = (...args: Args) => Promise<void>;
`,
  },
  {
    // The worker.ts:44 shape: a suppression WITH a description. Under the rule's own default this
    // is allowed, so this case is what pins the policy stricter than the default.
    file: "ts-expect-error-described",
    rule: "ban-ts-comment",
    defeats: '"ts-expect-error": "allow-with-description" (the rule default)',
    bad: `declare const rawText: string;
// @ts-expect-error -- a described suppression, which allow-with-description permits
export const harness: number = rawText;
`,
    good: `declare const rawText: string;
export const harness: string = rawText;
`,
  },
  {
    file: "ts-ignore-described",
    rule: "ban-ts-comment",
    defeats: '"ts-ignore": "allow-with-description"',
    bad: `declare const rawText: string;
// @ts-ignore -- described, and banned all the same
export const harness: number = rawText;
`,
    good: `declare const rawText: string;
export const harness: string = rawText;
`,
  },
  {
    file: "ts-nocheck-file",
    rule: "ban-ts-comment",
    defeats: '"ts-nocheck": false',
    bad: `// @ts-nocheck
declare const rawText: string;
export const harness: number = rawText;
`,
    good: `declare const rawText: string;
export const harness: string = rawText;
`,
  },
];

const RULES = ["no-explicit-any", "ban-ts-comment"] as const;

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));

assert.ok(
  config.plugins.includes("typescript"),
  "the typescript plugin must stay registered; both rules gated here are built-ins it supplies",
);
assert.deepEqual(
  [...new Set(cases.map((entry) => entry.rule))].sort(),
  [...RULES].sort(),
  "this gate must prove exactly the rules it claims, and only those",
);

// Declaration half of the policy. `no-explicit-any` takes the bare severity: its only option,
// `ignoreRestArgs`, defaults to the strict reading, so spelling an options object would add a place
// for a loosening to hide. `ban-ts-comment` is the reverse — its defaults are looser than the
// policy, so all three directives are named explicitly and asserted here.
assert.equal(
  config.rules["typescript/no-explicit-any"],
  "error",
  "typescript/no-explicit-any must be enabled at error, with no options object to loosen",
);
assert.deepEqual(
  config.rules["typescript/ban-ts-comment"],
  ["error", { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }],
  "typescript/ban-ts-comment must ban all three directives outright; any allow-with-description or false re-admits suppressions",
);

// The gated command must not be able to skip a finding. `denyWarnings` makes a downgraded severity
// still fail, and `reportUnusedDisableDirectives` is what stops an `oxlint-disable` comment from
// becoming the escape hatch these two rules exist to close.
assert.equal(config.options?.denyWarnings, true);
assert.equal(config.options?.reportUnusedDisableDirectives, "error");

const lint = (args: readonly string[], expectedFiles: number | null): LintReport => {
  const run = spawnSync(
    "./node_modules/.bin/oxlint",
    ["-c", ".oxlintrc.json", "-f", "json", ...args],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ok(run.stdout.length > 0, `oxlint produced no JSON for ${args.join(" ")}:\n${run.stderr}`);
  const report: LintReport = JSON.parse(run.stdout);
  if (expectedFiles !== null) {
    assert.equal(
      report.number_of_files,
      expectedFiles,
      `oxlint linted ${report.number_of_files} of ${expectedFiles} fixtures in ${args.join(" ")}; a run that skipped a fixture proves nothing about it`,
    );
  }
  assert.ok(
    report.number_of_rules > 0,
    `oxlint ran ${report.number_of_rules} rules; a lint with no rules loaded reports no findings`,
  );
  return report;
};

/**
 * The live denominator. These two rules key on constructs that appear in ordinary TypeScript, so
 * unlike a rule scoped to Durable Objects they cannot run out of corpus by refactor — but they CAN
 * be starved by scope. An `ignorePatterns` entry, a moved source root, or a config the gated command
 * stops reaching all take the governed file count toward zero, and a rule that inspected nothing
 * reports no findings and passes.
 *
 * The governed set comes from the shared repository enumeration, narrowed only by the configured
 * literal ignore roots. The measured set comes from `oxlint --debug=files`, which is Oxlint's own
 * pre-lint file list. Exact set equality is stronger than a numerical floor: a corpus of one
 * thousand unrelated files can meet a floor while every file this policy is supposed to govern is
 * absent. It also makes an ignore expansion fail by naming the exact missing paths.
 *
 * Exact file equality alone does not prove a file parsed. Oxlint lists a file before attempting to
 * parse it, and an unparsable file otherwise contributes zero rule diagnostics because no rule ran
 * inside it. Likewise, an unused disable directive has no rule name because it is configuration
 * machinery, not a rule finding. Both conditions are codeless diagnostics, both invalidate a clean
 * claim, and both are hard failures below. This happened on 2026-08-27: a backtick inside a SQL
 * comment inside a `sql.exec(\`...\`)` template literal in
 * `packages/cf-backend/src/user/schema.ts` made the escape assertion pass over a file it did not
 * inspect.
 */
function sourceSet(): readonly string[] {
  const ignoredRoots = config.ignorePatterns.map((pattern: unknown) => {
    assert.ok(typeof pattern === "string", "every ignore pattern must be a string");
    assert.match(
      pattern,
      /^[^*?[\]{}]+$/u,
      `ignore pattern ${JSON.stringify(pattern)} is not a literal root, so this gate cannot derive its governed source set exactly`,
    );
    return pattern;
  });
  const isIgnored = (file: string): boolean =>
    ignoredRoots.some((root: string) => file === root || file.startsWith(`${root}/`));
  return trackedFiles().filter(isParseable).filter((file) => !isIgnored(file)).sort();
}

function measuredSourceSet(): readonly string[] {
  const run = spawnSync(
    "./node_modules/.bin/oxlint",
    ["-c", ".oxlintrc.json", "--debug=files"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, `oxlint could not enumerate its measured files:\n${run.stderr}`);
  const files = run.stdout.trimEnd().split("\n").filter((file) => file.length > 0).sort();
  assert.ok(files.length > 0, "oxlint measured no files, so a clean report would prove nothing");
  assert.deepEqual(
    [...new Set(files)],
    files,
    "oxlint listed a measured file more than once; exact set equality would otherwise hide duplicate work",
  );
  return files;
}

const governed = sourceSet();
const measured = measuredSourceSet();
assert.deepEqual(
  measured,
  governed,
  `Oxlint's measured file set differs from the governed source set. Missing: ${governed.filter((file) => !measured.includes(file)).join(", ") || "none"}. Unexpected: ${measured.filter((file) => !governed.includes(file)).join(", ") || "none"}`,
);


const repo = lint([], null);
assert.equal(
  repo.number_of_files,
  measured.length,
  `oxlint listed ${measured.length} files before linting but reported ${repo.number_of_files} afterward; the clean report may have skipped a measured file`,
);
const unnamed = repo.diagnostics.filter((d) => d.code === undefined);
assert.deepEqual(
  unnamed.map((d) => `${d.filename ?? "?"} — ${d.message ?? "no message"}`),
  [],
  `${unnamed.length} governed diagnostic(s) carry no rule name. Either a file failed to parse, in which case oxlint applied NO rule inside it and this gate's clean result does not cover it, or a disable directive is present, which this ticket forbids outright. Both are hard failures`,
);

const fixtures = mkdtempSync(join(tmpdir(), "typescript-escapes-gate-"));
try {
  // System temp dir, NOT the repo root: gates built on scripts/sources.ts enumerate untracked
  // worktree files on purpose, so repo-root scratch is visible mid-run to every one of them.
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { file, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${file}.ts`), bad);
    writeFileSync(join(goodDirectory, `${file}.ts`), good);
  }

  const firedIn = (
    diagnostics: ReadonlyArray<Diagnostic>,
    entry: (typeof cases)[number],
  ): ReadonlyArray<Diagnostic> =>
    diagnostics.filter((d) =>
      d.code === `typescript(${entry.rule})` && (d.filename ?? "").endsWith(`${entry.file}.ts`));

  const red = lint([badDirectory], cases.length).diagnostics;
  const greenReport = lint([goodDirectory], cases.length);

  for (const entry of cases) {
    assert.equal(
      firedIn(red, entry).length,
      1,
      `typescript/${entry.rule} fired ${firedIn(red, entry).length} times on ${entry.file}'s one seeded escape through \`oxlint -c .oxlintrc.json\`; expected exactly 1. This case is the one that defeats ${entry.defeats}, so a zero here means that loosening is now live. Diagnostics seen: ${JSON.stringify(red.map((d) => d.code))}`,
    );
    assert.equal(
      firedIn(greenReport.diagnostics, entry).length,
      0,
      `typescript/${entry.rule} fires on ${entry.file}'s corrected form, so the cutover has no green state to reach`,
    );
  }

  // Clean source must pass WHOLE, not merely pass these two rules. The corrected forms are written
  // to satisfy every rule the repo enables, so any diagnostic here is a real finding and the
  // stricter assertion is the one worth making.
  assert.deepEqual(
    greenReport.diagnostics.map((d) => `${d.filename ?? "?"}: ${d.code ?? "?"}`),
    [],
    "the corrected fixtures must lint clean under the full config",
  );

  const escapes = repo.diagnostics.filter((d) =>
    RULES.some((rule) => d.code === `typescript(${rule})`));
  assert.deepEqual(
    escapes.map((d) => `${d.filename ?? "?"}: ${d.code ?? "?"}`),
    [],
    `governed source must carry no explicit \`any\` and no TypeScript suppression comment; ${escapes.length} found`,
  );

  // The claim names what it rests on. A clean result over a corpus that silently skipped a file it
  // could not parse is worth nothing, so the parse/directive count is stated, not implied.
  process.stdout.write(
    `typescript-escapes: ${RULES.length} built-in rules proven red->green through oxlint over ${cases.length} fixtures; `
    + `${repo.number_of_files} governed files, all parsed, carry zero explicit any, zero suppression comments and zero disable directives\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

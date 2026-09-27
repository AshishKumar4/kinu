// Kinu-only gate; see upstream.json's `kinuRules` and `kinuRuleGates`.
//
// The three Effect rules own RuleTester suites; a suite proves the rule function behaves, not that
// the rule is reachable through the command the repo gates on. This file runs the real `oxlint`
// binary with the real `.oxlintrc.json` over a seeded instance of each defect and over its
// corrected form, asserts red then green, and asserts the live denominator: rules that gate no
// `effect` import in product source would pass while gating nothing.
//
// Fixtures sit under `packages/fixture/src/` inside a temp directory, because effect-run-in-adapter
// governs product source by path.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSources } from "../../../scripts/sources.ts";
import { lintJson, type LintDiagnostic } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();

const HEAD = "import { Effect } from 'effect';\ndeclare const load: Effect.Effect<string, Error>;\n";

/** Red fixture, then the corrected form of the same code, per rule. */
const cases: ReadonlyArray<{ readonly rule: string; readonly bad: string; readonly good: string }> = [
  {
    rule: "effect-run-in-adapter",
    bad: `${HEAD}export async function answer(): Promise<string> {\n  return Effect.runPromise(load.pipe(Effect.orDie));\n}\n`,
    good: `${HEAD}declare function settle<A>(effect: Effect.Effect<A, Error>): Promise<A>;\nexport async function answer(): Promise<string> {\n  return settle(load);\n}\n`,
  },
  {
    rule: "no-effect-swallow",
    bad: `${HEAD}export const answer = load.pipe(Effect.catch(() => Effect.succeed('')));\n`,
    good: `${HEAD}declare const record: (error: Error) => void;\nexport const answer = load.pipe(Effect.catch((error) => Effect.sync(() => record(error)).pipe(Effect.as(''))));\n`,
  },
  {
    rule: "effect-restricted-api",
    bad: `${HEAD}export const answer = load.pipe(Effect.timeout('30 seconds'));\n`,
    good: `${HEAD}export const answer = load;\n`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"));
assert.deepEqual(
  cases.map((entry) => entry.rule).sort(),
  [...manifest.kinuRuleGates["effect.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/** The live denominator: product source that imports `effect`, from the ONE enumeration. */
const importers = [...readSources()].filter(([, text]) => /\bfrom ['"]effect(?:\/[^'"]*)?['"]/u.test(text)).length;
assert.ok(
  importers > 0,
  "no product source imports `effect`; the Effect rules would then be gating nothing",
);

// System temp dir, NOT the repo root: gates built on scripts/sources.ts enumerate untracked
// worktree files on purpose, so repo-root scratch is visible mid-run to every one of them.
const fixtures = mkdtempSync(join(tmpdir(), "kinu-scratch-effect-gate-"));
try {
  const red = join(fixtures, "red", "packages", "fixture", "src");
  const green = join(fixtures, "green", "packages", "fixture", "src");
  mkdirSync(red, { recursive: true });
  mkdirSync(green, { recursive: true });
  for (const { rule, bad, good } of cases) {
    writeFileSync(join(red, `${rule}.ts`), bad);
    writeFileSync(join(green, `${rule}.ts`), good);
  }

  const ruleOf = (diagnostic: LintDiagnostic): string | null => {
    const rule = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "")?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };
  const lint = (directory: string): readonly LintDiagnostic[] => {
    const report = lintJson(["-c", ".oxlintrc.json", directory]);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    return report.diagnostics;
  };

  const redRun = lint(join(fixtures, "red"));
  const greenRun = lint(join(fixtures, "green"));

  for (const { rule } of cases) {
    assert.ok(
      redRun.some((d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`)),
      `anti-slop/${rule} did not fire on its seeded defect through \`oxlint -c .oxlintrc.json\`. Seen: ${JSON.stringify(redRun.map(ruleOf))}`,
    );
  }
  assert.deepEqual(
    greenRun.filter((d) => ruleOf(d) !== null).map((d) => `${d.filename}: ${d.code}`),
    [],
    "a corrected fixture still draws an Effect finding",
  );
  assert.deepEqual(
    [...new Set(redRun.map(ruleOf).filter((rule) => rule !== null))].sort(),
    cases.map((entry) => entry.rule).sort(),
    "the red run must exercise every Effect rule and no rule the fixtures did not seed",
  );

  process.stdout.write(
    `effect: ${cases.length} rules proven red->green through oxlint over ${importers} product source file(s) importing \`effect\`\n`
    + "  blind: an `Effect` binding under another name (no-effect-swallow reads the name `Effect`); a catch-all handler passed by name; a floating effect (gate:effect-diagnostics)\n",
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

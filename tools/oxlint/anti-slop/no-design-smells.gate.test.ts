// Kinu-only gate; see upstream.json's `kinuRules`.
//
// The two design-smell rules own RuleTester suites, but a suite proves only that the rule function
// behaves, not that the rule is reachable through the command the repo gates on. This file runs the
// real `oxlint` binary with the real `.oxlintrc.json` over a seeded instance of each defect and over
// its corrected form, and asserts red on the first and green on the second. It also asserts the live
// denominator for each rule: a corpus with no SQL and no pair of same-shaped functions would let
// either rule pass by inspecting nothing.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSources } from "../../../scripts/sources.ts";
import { lintJson, type LintDiagnostic } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();

/** Red fixture, then the corrected form of the same code, per rule. */
const cases: ReadonlyArray<{
  readonly rule: string;
  readonly bad: string;
  readonly good: string;
}> = [
  {
    rule: "no-near-duplicate-functions",
    // `partOpened` and `partEnded` as messages.ts held them on 2026-09-21: one body, one literal.
    bad: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; payload_json: string }
export function partOpened(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = 'open' ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
export function partEnded(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = 'content-end' ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
`,
    good: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; payload_json: string }
type Operation = 'open' | 'content-end';
export function part(actorId: string, messageId: string, operation: Operation): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = \${operation} ORDER BY sequence LIMIT 1\`;
  const [row] = rows;
  if (row === undefined) return null;
  return { sequence: row.sequence, payload_json: row.payload_json };
}
`,
  },
  {
    rule: "no-manufactured-sql-column",
    // The projection read that faked message_updates' shape for its reader (messages.ts, 2026-09-21).
    bad: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface UpdateRow { sequence: number; part_no: number | null; operation: string; payload_json: string }
export function storedProjection(actorId: string, messageId: string): UpdateRow | null {
  const rows = sql<UpdateRow>\`SELECT sequence, NULL AS part_no, 'open' AS operation, payload_json
    FROM message_projections WHERE actor_id = \${actorId} AND message_id = \${messageId}\`;
  return rows[0] ?? null;
}
`,
    good: `declare const sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
interface ProjectionRow { sequence: number; payload_json: string }
export function storedProjection(actorId: string, messageId: string): ProjectionRow | null {
  const rows = sql<ProjectionRow>\`SELECT sequence, payload_json
    FROM message_projections WHERE actor_id = \${actorId} AND message_id = \${messageId}\`;
  return rows[0] ?? null;
}
`,
  },
];

const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8"),
);
assert.deepEqual(
  cases.map((entry) => entry.rule).sort(),
  [...manifest.kinuRuleGates["no-design-smells.gate.test.ts"]].sort(),
  "this gate must prove exactly the rules upstream.json assigns to it, and only those",
);
for (const { rule } of cases) {
  assert.equal(
    config.rules[`anti-slop/${rule}`],
    "error",
    `anti-slop/${rule} must be enabled at error; a rule proven here but off in the config is silently dead`,
  );
}

/**
 * The live denominators, from the ONE enumeration: SELECT statements in product source for the
 * SQL rule, and function declarations for the duplicate rule. A corpus that has silently gone to
 * zero on either must fail loudly rather than report a clean lint.
 */
const corpus = { files: 0, selects: 0, functions: 0 };
for (const [, text] of readSources()) {
  corpus.files += 1;
  corpus.selects += text.match(/\bSELECT\b/gu)?.length ?? 0;
  corpus.functions += text.match(/\bfunction\b|=>/gu)?.length ?? 0;
}
assert.ok(corpus.files > 0, "found no TypeScript sources under packages/*/src; the rules would gate nothing");
assert.ok(corpus.selects > 0, `found ${corpus.files} sources but no SELECT; the SQL rule would inspect nothing`);
assert.ok(corpus.functions > 1, `found ${corpus.files} sources but no pair of functions; the duplicate rule would inspect nothing`);

// System temp dir, NOT the repo root: gates built on scripts/sources.ts enumerate untracked
// worktree files on purpose, so repo-root scratch is visible mid-run to every one of them.
const fixtures = mkdtempSync(join(tmpdir(), "no-design-smells-gate-"));
try {
  const badDirectory = join(fixtures, "red");
  const goodDirectory = join(fixtures, "green");
  mkdirSync(badDirectory);
  mkdirSync(goodDirectory);
  for (const { rule, bad, good } of cases) {
    writeFileSync(join(badDirectory, `${rule}.ts`), bad);
    writeFileSync(join(goodDirectory, `${rule}.ts`), good);
  }

  const lint = (directory: string): readonly LintDiagnostic[] => {
    const report = lintJson(["-c", ".oxlintrc.json", directory]);
    assert.equal(
      report.number_of_files,
      cases.length,
      `oxlint linted ${report.number_of_files} of ${cases.length} fixtures in ${directory}; a run that skipped a fixture proves nothing about it`,
    );
    return report.diagnostics;
  };
  const ruleOf = (diagnostic: LintDiagnostic): string | null => {
    const match = /^anti-slop\(([a-z-]+)\)$/u.exec(diagnostic.code ?? "");
    const rule = match?.[1];
    return rule !== undefined && cases.some((entry) => entry.rule === rule) ? rule : null;
  };
  const firedIn = (diagnostics: readonly LintDiagnostic[], rule: string): readonly LintDiagnostic[] =>
    diagnostics.filter((d) => ruleOf(d) === rule && (d.filename ?? "").endsWith(`${rule}.ts`));

  const red = lint(badDirectory);
  const green = lint(goodDirectory);

  for (const { rule } of cases) {
    assert.ok(
      firedIn(red, rule).length > 0,
      `anti-slop/${rule} did not fire on its seeded defect through \`oxlint -c .oxlintrc.json\`. Diagnostics seen: ${JSON.stringify(red.map(ruleOf))}`,
    );
    assert.equal(
      firedIn(green, rule).length,
      0,
      `anti-slop/${rule} fires on the corrected form, so there is no green state to reach`,
    );
  }
  // Each fixture must be flagged by its own rule and by no other of the two: one rule that
  // flagged everything would pass the per-rule checks above.
  assert.deepEqual(
    [...new Set(red.map(ruleOf).filter((rule) => rule !== null))].sort(),
    cases.map((entry) => entry.rule).sort(),
    "the red run must exercise both design-smell rules and no rule the fixtures did not seed",
  );
  assert.deepEqual(
    green.filter((d) => ruleOf(d) !== null).map((d) => `${d.filename}: ${d.code}`),
    [],
    "a corrected fixture still draws a design-smell finding",
  );

  process.stdout.write(
    `no-design-smells: ${cases.length} rules proven red->green through oxlint over ${corpus.selects} SELECTs and ${corpus.functions} functions in ${corpus.files} sources\n`,
  );
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

/**
 * One spawn of the real `oxlint` binary with `-f json`, parsed at the boundary.
 *
 * Every `*.gate.test.ts` that proves a rule through the binary needs the same
 * three things: the process, a report that is not empty, and a rule count that
 * is not zero. Each gate held its own copy of the spawn and its own `LintReport`
 * type, and one copy skipped the rule-count check. This is the one spelling.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as v from "valibot";

const DiagnosticSchema = v.object({
  code: v.optional(v.string()),
  filename: v.optional(v.string()),
  message: v.optional(v.string()),
});
const LintReportSchema = v.object({
  diagnostics: v.array(DiagnosticSchema),
  number_of_files: v.number(),
  number_of_rules: v.number(),
});

/** One diagnostic as `oxlint -f json` prints it. `code` is spelled
 *  `anti-slop(rule-name)` or `typescript(rule-name)`, and is ABSENT when no
 *  rule produced it: a parse failure or an unused disable directive. */
export type LintDiagnostic = v.InferOutput<typeof DiagnosticSchema>;
export type LintReport = v.InferOutput<typeof LintReportSchema>;

/**
 * Run `oxlint -f json <args>` from the repository root and parse the report.
 * Fails when oxlint printed nothing (the message carries stderr) or loaded no
 * rules, because a lint that ran no rule finds nothing and proves nothing.
 */
export function lintJson(args: readonly string[]): LintReport {
  const run = spawnSync("./node_modules/.bin/oxlint", ["-f", "json", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.ok(run.stdout.length > 0, `oxlint produced no JSON for \`${args.join(" ")}\`:\n${run.stderr}`);
  const report = v.parse(LintReportSchema, JSON.parse(run.stdout));
  assert.ok(
    report.number_of_rules > 0,
    `oxlint ran ${report.number_of_rules} rules for \`${args.join(" ")}\`; a lint with no rules loaded reports no findings`,
  );
  return report;
}

/** One diagnostic as a reader opens it: `file — code: message`. */
export function describeDiagnostic(diagnostic: LintDiagnostic): string {
  return `${diagnostic.filename ?? "?"} — ${diagnostic.code ?? "no rule"}: ${diagnostic.message ?? "no message"}`;
}

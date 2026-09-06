import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import { isLintSource, trackedFiles } from "../../../scripts/sources.ts";
import { lintJson, describeDiagnostic } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();
const rule = "no-vacuous-type-predicate";
const diagnosticCode = `predicate-stage(${rule})`;
const staged = process.argv.includes("--staged");
const ActiveConfig = v.object({ rules: v.object({
  "anti-slop/no-vacuous-type-predicate": v.optional(v.literal("error")),
}) });
const active = v.parse(ActiveConfig, JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")));
if (!staged) assert.equal(active.rules["anti-slop/no-vacuous-type-predicate"], "error", "the proven rule must remain active");

const governed = trackedFiles().filter(isLintSource).sort();
const listed = spawnSync("./node_modules/.bin/oxlint", ["-c", ".oxlintrc.json", "--debug=files"], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
assert.equal(listed.status, 0, listed.stderr);
const measured = listed.stdout.trim().split("\n").filter(Boolean).sort();
assert.ok(governed.length > 0, "the lint source set is empty");
assert.deepEqual(measured, governed, "the rule must measure the set the lint configuration governs");

const prelude = 'type Value = { kind: "yes" } | { kind: "no" };\n';
const bad = [
  'export const isYes = (value: Value): value is { kind: "yes" } => true;',
  'export function isYes(value: Value): value is { kind: "yes" } { return true; }',
  'export const isYes = function(value: Value): value is { kind: "yes" } { return (true); };',
  'export class Guard { isYes(value: Value): value is { kind: "yes" } { return true; } }',
];
const good = [
  'export const isYes = (value: Value): value is { kind: "yes" } => value.kind === "yes";',
  'export function isYes(value: Value): value is { kind: "yes" } { return false; }',
  'declare function assertYes(value: Value): asserts value is { kind: "yes" }; export function isYes(value: Value): value is { kind: "yes" } { assertYes(value); return true; }',
  'export const accepts = (): boolean => true;',
];

const workspace = mkdtempSync(join(tmpdir(), "kinu-predicate-gate-"));
try {
  const pluginPath = join(workspace, "stage.mjs");
  const configPath = join(workspace, "stage.json");
  writeFileSync(pluginPath, `import { eslintCompatPlugin } from ${JSON.stringify(pathToFileURL(join(repoRoot, "node_modules/@oxlint/plugins/index.js")).href)};
import { noVacuousTypePredicateRule } from ${JSON.stringify(pathToFileURL(join(repoRoot, "tools/oxlint/anti-slop/rules/no-vacuous-type-predicate.ts")).href)};
export default eslintCompatPlugin({ meta: { name: "predicate-stage" }, rules: { "no-vacuous-type-predicate": noVacuousTypePredicateRule } });
`);
  writeFileSync(configPath, JSON.stringify({
    jsPlugins: [{ name: "predicate-stage", specifier: pluginPath }],
    rules: { [`predicate-stage/${rule}`]: "error" },
  }));
  for (const [index, code] of bad.entries()) {
    const path = join(workspace, `bad-${index}.ts`);
    writeFileSync(path, prelude + code);
    const report = lintJson(["-c", configPath, path]);
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter(item => item.code === undefined).map(describeDiagnostic), []);
    assert.equal(report.diagnostics.filter(item => item.code === diagnosticCode).length, 1, `bad case ${index} must be red`);
  }
  for (const [index, code] of good.entries()) {
    const path = join(workspace, `good-${index}.ts`);
    writeFileSync(path, prelude + code);
    const report = lintJson(["-c", configPath, path]);
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter(item => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  }
  const live = lintJson(["-c", configPath, ...governed]);
  assert.equal(live.number_of_files, governed.length);
  assert.deepEqual(live.diagnostics.filter(item => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  process.stdout.write(`no-vacuous-type-predicate: ${staged ? "staged" : "active"}; ${bad.length} red and ${good.length} green cases; ${measured.length} measured = ${governed.length} governed files; zero live findings. Blind spots: aliased predicate types, type-wrapped constants, and multi-statement guards. This checks literal unconditional truth, not the correctness of other predicate implementations.\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

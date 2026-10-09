// Kinu-only gate; see upstream.json's `kinuRules` and `kinuRuleGates`.
//
// `rules/no-module-scope-flight.test.ts` proves the rule function behaves. This file proves the rule fires through the
// real `oxlint` binary on the defect replayed from models-dev.ts as it stood at d930f2537, and that the forms that are
// fine pass: a call's own flight, a Durable Object instance's, settled data at module scope. It also proves the rule is
// on at error in `.oxlintrc.json` and that the live tree has no finding across the set `isShippedSource` names.
//
// Why: a flight at module scope in a Worker joins every request on the isolate to I/O one request started; workerd
// drops a cancelled request's subrequests, so one cancelled request leaves the isolate's every later read hung
// (workerd 2026-09-30; staging d930f2537, creates and model menus held up to 270 s).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

import { isLintSource, isShippedSource, trackedFiles } from "../../../scripts/sources.ts";
import { describeDiagnostic, lintJson } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();
const rule = "no-module-scope-flight";
const diagnosticCode = `flight-stage(${rule})`;

const ActiveConfig = v.object({ rules: v.object({ "anti-slop/no-module-scope-flight": v.optional(v.literal("error")) }) });
const active = v.parse(ActiveConfig, JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")));
assert.equal(active.rules["anti-slop/no-module-scope-flight"], "error", "the proven rule must stay on at error");

const manifest = v.parse(
  v.object({ kinuRuleGates: v.record(v.string(), v.array(v.string())) }),
  JSON.parse(readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8")),
);
assert.deepEqual(manifest.kinuRuleGates["no-module-scope-flight.gate.test.ts"], [rule], "this gate proves exactly this rule");

/** The defect as d930f2537 shipped it, checked against that commit when it is reachable. */
const HISTORICAL = { path: "packages/core/src/providers/models-dev.ts", line: "const reads = new WeakMap<typeof fetch, Flight<void, Record<string, ModelsDevProvider>, KinuError>>();" };
const shown = spawnSync("git", ["show", `d930f2537:${HISTORICAL.path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

if (shown.status === 0) assert.ok(shown.stdout.split("\n").includes(HISTORICAL.line), `${HISTORICAL.path} at d930f2537 does not hold the replayed line`);
else process.stdout.write(`no-module-scope-flight: d930f2537 unreachable from this checkout; ${HISTORICAL.path} replayed unverified\n`);

const bad: readonly { readonly file: string; readonly code: string }[] = [
  { file: "packages/planted/src/models-dev.ts", code: `declare function flight<T>(run: () => T): T;\ntype Flight<I, A, E> = (input: I) => A | E;\ninterface ModelsDevProvider { readonly id: string }\ntype KinuError = Error;\n${HISTORICAL.line}\nexport { reads };\n` },
  { file: "packages/planted/src/catalog.ts", code: "declare function flight<T>(run: () => T): T;\nexport const catalog = flight(() => fetch('https://models.dev/api.json'));\n" },
];

const good: readonly { readonly file: string; readonly code: string }[] = [
  { file: "packages/planted/src/host.ts", code: "declare function flight<T>(run: () => T): T;\nexport class Host { private readonly homes = flight(() => 1); read() { return this.homes; } }\n" },
  { file: "packages/planted/src/transport.ts", code: "declare function flight<T>(run: () => T): T;\nexport function transport() { return flight(() => 1); }\n" },
  { file: "packages/planted/src/settled.ts", code: "export let cache: { readonly data: string } | null = null;\nexport const setCache = (data: string) => { cache = { data }; };\n" },
  // Outside shipped source.
  { file: "scripts/planted.ts", code: "declare function flight<T>(run: () => T): T;\nexport const catalog = flight(() => 1);\n" },
];

const governed = trackedFiles().filter((file) => isLintSource(file) && isShippedSource(file)).sort();
assert.ok(governed.includes(HISTORICAL.path), "the module the defect shipped in must be in the governed set");

const workspace = mkdtempSync(join(tmpdir(), "kinu-module-flight-gate-"));

try {
  const pluginPath = join(workspace, "stage.mjs");
  const configPath = join(workspace, "stage.json");
  writeFileSync(pluginPath, `import { eslintCompatPlugin } from ${JSON.stringify(pathToFileURL(join(repoRoot, "node_modules/@oxlint/plugins/index.js")).href)};
import { noModuleScopeFlightRule } from ${JSON.stringify(pathToFileURL(join(repoRoot, "tools/oxlint/anti-slop/rules/no-module-scope-flight.ts")).href)};
export default eslintCompatPlugin({ meta: { name: "flight-stage" }, rules: { "no-module-scope-flight": noModuleScopeFlightRule } });
`);
  writeFileSync(configPath, JSON.stringify({ jsPlugins: [{ name: "flight-stage", specifier: pluginPath }], rules: { [`flight-stage/${rule}`]: "error" } }));

  // The rule judges a file by its path from where oxlint runs, so each is planted under the workspace and linted from it.
  const plant = (directory: string, file: string, code: string): string => {
    const path = join(workspace, directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);

    return path;
  };

  for (const { file, code } of bad) {
    const report = lintJson(["-c", configPath, plant("bad", file, code)], join(workspace, "bad"));
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter((item) => item.code === undefined).map(describeDiagnostic), []);
    assert.equal(report.diagnostics.filter((item) => item.code === diagnosticCode).length, 1, `planted ${file} must be red`);
  }

  for (const { file, code } of good) {
    const report = lintJson(["-c", configPath, plant("good", file, code)], join(workspace, "good"));
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter((item) => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  }

  const live = lintJson(["-c", configPath, ...governed]);
  assert.equal(live.number_of_files, governed.length);
  assert.deepEqual(live.diagnostics.filter((item) => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  process.stdout.write(`no-module-scope-flight: ${bad.length} planted red and ${good.length} green cases; ${governed.length} shipped files, zero live findings. Blind spots: a flight under another name, a module-scope bare promise, a flight a module-scope factory returns.\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

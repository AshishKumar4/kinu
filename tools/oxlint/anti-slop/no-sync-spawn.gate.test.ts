// Kinu-only gate; see upstream.json's `kinuRules` and `kinuRuleGates`.
//
// `rules/no-sync-spawn.test.ts` proves the rule function behaves. This file proves the rule fires through the real
// `oxlint` binary on planted synchronous spawns in shipped source, replayed from the sites 8dcca981a shipped and in each
// other spelling Bun offers, and that their asynchronous forms pass. It also proves the rule is on at error in `.oxlintrc.json` and that the live shipped
// tree has no finding, across the set `isShippedSource` in scripts/sources.ts names, which is the rule's own scope.
//
// Why: under Bun 1.4 a collection that finalizes a stderr FileSink while `spawnSync` waits wedges the process. A later
// synchronous spawn then spins at 100% CPU over a zombie child, for good (oven-sh/bun#34069), and the device daemon
// and the CLI are processes on users' machines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

import { isLintSource, isShippedSource, trackedFiles } from "../../../scripts/sources.ts";
import { describeDiagnostic, lintJson } from "./shared/oxlint-json.ts";

const repoRoot = process.cwd();
const rule = "no-sync-spawn";
const diagnosticCode = `spawn-stage(${rule})`;

const ActiveConfig = v.object({ rules: v.object({ "anti-slop/no-sync-spawn": v.optional(v.literal("error")) }) });
const active = v.parse(ActiveConfig, JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")));
assert.equal(active.rules["anti-slop/no-sync-spawn"], "error", "the proven rule must stay on at error");

const manifest = v.parse(
  v.object({ kinuRuleGates: v.record(v.string(), v.array(v.string())) }),
  JSON.parse(readFileSync(join(repoRoot, "tools/oxlint/anti-slop/upstream.json"), "utf8")),
);
assert.deepEqual(manifest.kinuRuleGates["no-sync-spawn.gate.test.ts"], [rule], "this gate proves exactly this rule");

/** The synchronous spawns 8dcca981a shipped, each checked against that commit when it is reachable. */
const HISTORICAL = [
  { path: "packages/cli-backend/src/config-lock.ts", line: "    const result = Bun.spawnSync({" },
  { path: "packages/cli/src/commands/deploy-local.ts", line: "import { spawn, spawnSync } from 'node:child_process';" },
  { path: "packages/pc-agent/src/index.js", line: "const { spawn, spawnSync, execFileSync } = require('node:child_process');" },
] as const;

for (const { path, line } of HISTORICAL) {
  const shown = spawnSync("git", ["show", `8dcca981a:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (shown.status === 0) assert.ok(shown.stdout.split("\n").includes(line), `${path} at 8dcca981a does not hold the replayed line: ${line}`);
  else process.stdout.write(`no-sync-spawn: 8dcca981a unreachable from this checkout; ${path} replayed unverified\n`);
}

const bad: readonly { readonly file: string; readonly code: string; readonly findings: number }[] = [
  { file: "lock.ts", code: `declare const pid: number;\nexport function read(): unknown {\n${HISTORICAL[0].line}\n      cmd: ['/bin/ps', '-p', String(pid), '-o', 'lstart='],\n    });\n\n    return result;\n}\n`, findings: 1 },
  { file: "deploy-local.ts", code: `${HISTORICAL[1].line}\nexport const listed = spawnSync('ps', ['-o', 'args=']);\nexport const started = spawn('workerd');\n`, findings: 1 },
  { file: "daemon.js", code: `${HISTORICAL[2].line}\nmodule.exports = { spawn, spawnSync, execFileSync };\n`, findings: 2 },
  { file: "bun-named.ts", code: "import { spawnSync } from 'bun';\nexport const listed = spawnSync(['ls']);\n", findings: 1 },
  { file: "bun-namespace.ts", code: "import * as B from 'bun';\nexport const listed = B.spawnSync(['ls']);\n", findings: 1 },
  { file: "bun-destructured.ts", code: "const { spawnSync } = Bun;\nexport const listed = spawnSync(['ls']);\n", findings: 1 },
  { file: "bun-global.ts", code: "export const listed = globalThis.Bun.spawnSync(['ls']);\n", findings: 1 },
];

const good: readonly { readonly file: string; readonly code: string }[] = [
  { file: "lock.ts", code: "export async function read(): Promise<number> {\n  const ps = Bun.spawn({ cmd: ['/bin/ps'], stdout: 'pipe' });\n\n  return await ps.exited;\n}\n" },
  { file: "deploy-local.ts", code: "import { execFile } from 'node:child_process';\nexport function list(done: (out: string) => void): void {\n  execFile('ps', ['-o', 'args='], (_error, stdout) => { done(stdout); });\n}\n" },
  { file: "daemon.js", code: "const { spawn, execFile } = require('node:child_process');\nmodule.exports = { spawn, execFile };\n" },
  { file: "bun.ts", code: "import { spawn } from 'bun';\nexport const exited = [spawn(['ls']).exited, globalThis.Bun.spawn(['ps']).exited];\n" },
];

const governed = trackedFiles().filter((file) => isLintSource(file) && isShippedSource(file)).sort();
assert.ok(governed.length > 0, "no shipped source file is linted; a rule over an empty tree finds nothing");
assert.ok(governed.includes("packages/pc-agent/src/index.js"), "the daemon's plain JavaScript must be in the governed set");

const workspace = mkdtempSync(join(tmpdir(), "kinu-sync-spawn-gate-"));

try {
  const pluginPath = join(workspace, "stage.mjs");
  const configPath = join(workspace, "stage.json");
  writeFileSync(pluginPath, `import { eslintCompatPlugin } from ${JSON.stringify(pathToFileURL(join(repoRoot, "node_modules/@oxlint/plugins/index.js")).href)};
import { noSyncSpawnRule } from ${JSON.stringify(pathToFileURL(join(repoRoot, "tools/oxlint/anti-slop/rules/no-sync-spawn.ts")).href)};
export default eslintCompatPlugin({ meta: { name: "spawn-stage" }, rules: { "no-sync-spawn": noSyncSpawnRule } });
`);
  writeFileSync(configPath, JSON.stringify({
    jsPlugins: [{ name: "spawn-stage", specifier: pluginPath }],
    rules: { [`spawn-stage/${rule}`]: "error" },
  }));

  // Planted where the rule governs: a `packages/<pkg>/src` path.
  const source = join(workspace, "packages", "planted", "src");
  mkdirSync(source, { recursive: true });

  for (const { file, code, findings } of bad) {
    const path = join(source, `bad-${file}`);
    writeFileSync(path, code);
    const report = lintJson(["-c", configPath, path]);
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter((item) => item.code === undefined).map(describeDiagnostic), []);
    assert.equal(report.diagnostics.filter((item) => item.code === diagnosticCode).length, findings, `planted ${file} must be red`);
  }

  for (const { file, code } of good) {
    const path = join(source, `good-${file}`);
    writeFileSync(path, code);
    const report = lintJson(["-c", configPath, path]);
    assert.equal(report.number_of_files, 1);
    assert.deepEqual(report.diagnostics.filter((item) => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  }

  const live = lintJson(["-c", configPath, ...governed]);
  assert.equal(live.number_of_files, governed.length);
  assert.deepEqual(live.diagnostics.filter((item) => item.code === diagnosticCode || item.code === undefined).map(describeDiagnostic), []);
  process.stdout.write(`no-sync-spawn: ${bad.length} planted red and ${good.length} green cases; ${governed.length} shipped files, zero live findings. Blind spots: a spawner reached through a binding the rule does not follow, a dynamic import of bun or child_process, process.binding.\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

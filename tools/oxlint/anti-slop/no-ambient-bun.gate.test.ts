import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { isLintSource, trackedFiles } from '../../../scripts/sources.ts';
import { TEST_FILE } from './rules/no-ambient-git-in-tests.ts';
import { lintJson, describeDiagnostic } from './shared/oxlint-json.ts';

const root = process.cwd();
const rule = 'no-ambient-bun-in-tests';
const code = `spawn-env(${rule})`;
const active = v.parse(v.object({ rules: v.object({ 'anti-slop/no-ambient-bun-in-tests': v.literal('error') }) }), JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8')));
assert.equal(active.rules[`anti-slop/${rule}`], 'error');
const denominator = trackedFiles().filter(file => isLintSource(file) && TEST_FILE.test(file));
assert.ok(denominator.includes('packages/cli-backend/tests/runtime-shell.test.ts'));
const scratch = mkdtempSync(join(tmpdir(), 'kinu-bun-env-gate-'));

try {
  const plugin = join(scratch, 'rule.mjs');
  const config = join(scratch, 'config.json');
  writeFileSync(plugin, `import {eslintCompatPlugin} from ${JSON.stringify(pathToFileURL(join(root, 'node_modules/@oxlint/plugins/index.js')).href)};\nimport {noAmbientBunInTestsRule} from ${JSON.stringify(pathToFileURL(join(root, 'tools/oxlint/anti-slop/rules/no-ambient-bun-in-tests.ts')).href)};\nexport default eslintCompatPlugin({meta:{name:'spawn-env'},rules:{'no-ambient-bun-in-tests':noAmbientBunInTestsRule}});\n`);
  writeFileSync(config, JSON.stringify({ plugins: [], jsPlugins: [plugin], rules: { [`spawn-env/${rule}`]: 'error' } }));
  const red = [
    'Bun.spawn([process.execPath, script], {stdout:"pipe"});',
    'Bun.spawn({cmd:["bun",script],cwd:scratch});',
    'import {spawn as child} from "bun"; child(["bun",script]);',
    'import {spawnSync} from "node:child_process"; spawnSync("bun",[script]);',
  ];
  const green = [
    'Bun.spawn([process.execPath,script],{env:process.env});',
    'const env=process.env; Bun.spawn({cmd:["bun",script],env});',
    'import {spawnTest} from "@kinu.run/test-utils"; spawnTest([process.execPath,script]);',
    'import {spawnSync} from "node:child_process"; spawnSync("bun",[script],{env:process.env});',
  ];

  for (let index = 0; index < red.length; index++) {
    const file = join(scratch, 'tests', `probe-${String(index)}.test.ts`);
    mkdirSync(join(scratch, 'tests'), { recursive: true });
    writeFileSync(file, red[index]);
    const before = lintJson(['--config', config, file]);
    assert.equal(before.diagnostics.filter(diagnostic => diagnostic.code === code).length, 1, JSON.stringify(before.diagnostics.map(describeDiagnostic)));
    writeFileSync(file, green[index]);
    const after = lintJson(['--config', config, file]);
    assert.deepEqual(after.diagnostics, [], JSON.stringify(after.diagnostics.map(describeDiagnostic)));
  }

  process.stdout.write(`no-ambient-bun: four native spawner boundaries proven red-to-green; ${String(denominator.length)} governed test files, no allowlist\n`);
  process.stdout.write('Blind: runtime-built module or executable paths, spawner method aliases, and calls inside generated program strings are not resolved.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

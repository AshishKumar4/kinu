import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

const workspace = mkdtempSync(join(tmpdir(), 'kinu-firstrun-rule-'));

const proposed = process.argv[2] === 'proposed';

const source = join(root, 'tools/oxlint/anti-slop/rules/no-sync-spawn.ts');

let code = readFileSync(source, 'utf8');

if (proposed) {
  assert(code.includes('import { isShippedSource }'));
  assert(code.includes('return root !== -1 && isShippedSource(normalized.slice(root + 1));'));
  code = code.replace('import { isShippedSource }', 'import { isShippedSource, isTestFile, isTestScaffold }')
    .replace('return root !== -1 && isShippedSource(normalized.slice(root + 1));',
      'return isTestFile(normalized) || (root !== -1 && (isShippedSource(normalized.slice(root + 1)) || isTestScaffold(normalized.slice(root + 1))));');
}

code = code.replaceAll('from "@oxlint/plugins"', `from ${JSON.stringify(pathToFileURL(join(root, 'node_modules/@oxlint/plugins/index.js')).href)}`)
  .replace('from "../../../../scripts/sources.ts"', `from ${JSON.stringify(pathToFileURL(join(root, 'scripts/sources.ts')).href)}`);

const rule = join(workspace, 'rule.ts');

writeFileSync(rule, code);

const plugin = join(workspace, 'stage.mjs');

writeFileSync(plugin, `import { eslintCompatPlugin } from ${JSON.stringify(pathToFileURL(join(root, 'node_modules/@oxlint/plugins/index.js')).href)};
import { noSyncSpawnRule } from ${JSON.stringify(pathToFileURL(rule).href)};
export default eslintCompatPlugin({ meta: { name: 'spawn-stage' }, rules: { 'no-sync-spawn': noSyncSpawnRule } });
`);

const config = join(workspace, 'stage.json');

writeFileSync(config, JSON.stringify({ jsPlugins: [{ name: 'spawn-stage', specifier: plugin }], rules: { 'spawn-stage/no-sync-spawn': 'error' } }));

const fixtures = [
  { file: 'tests/first-run/probe.test.ts', bad: "import { spawnSync } from 'node:child_process'; spawnSync('bun', ['--bun', 'vitest', 'list']);",
    good: "import { spawn } from 'node:child_process'; spawn('bun', ['--bun', 'vitest', 'list']);" },
  { file: 'packages/core/tests/probe.test.ts', bad: "Bun.spawnSync(['git', 'status']);", good: "await Bun.spawn(['git', 'status']).exited;" },
  { file: 'scripts/probe.test.ts', bad: "import * as cp from 'node:child_process'; cp.execFileSync('node', ['probe.js']);",
    good: "import * as cp from 'node:child_process'; cp.execFile('node', ['probe.js'], () => {});" },
  { file: 'tests/first-run/helper.ts', bad: "const { spawnSync } = require('node:child_process'); spawnSync('bun');",
    good: "const { spawn } = require('node:child_process'); spawn('bun');" },
  { file: 'packages/test-utils/src/probe.ts', bad: "import { execFileSync } from 'node:child_process'; execFileSync('git', ['status']);",
    good: "import { execFile } from 'node:child_process'; execFile('git', ['status'], () => {});" },
];

function findings(file, text) {
  const path = join(workspace, file);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
  const result = spawnSync(join(root, 'node_modules/.bin/oxlint'), ['-c', config, '-f', 'json', path], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  assert.equal(report.number_of_files, 1, result.stderr);
  assert.deepEqual(report.diagnostics.filter((item) => item.code === undefined), []);

  return report.diagnostics.filter((item) => item.code === 'spawn-stage(no-sync-spawn)').length;
}

const results = fixtures.map(({ file, bad, good }) => ({ file, bad: findings(file, bad), good: findings(file, good) }));

console.log(JSON.stringify({ proposed, workspace, results }));

for (const result of results) {
  assert.equal(result.bad, 1, `${result.file} must reject the sync call`);
  assert.equal(result.good, 0, `${result.file} must accept the async call`);
}

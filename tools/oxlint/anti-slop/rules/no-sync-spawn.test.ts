// Kinu-local rule; see upstream.json's `kinuRules`. The planted red->green through the real `oxlint` binary and
// the live tree's zero findings are in ../no-sync-spawn.gate.test.ts.
//
// Why a synchronous spawn is banned from shipped source: under Bun 1.4, a collection that finalizes a stderr
// FileSink while `spawnSync` waits wedges the process. A later synchronous spawn then spins at 100% CPU over a
// zombie child, for good (oven-sh/bun#34069, reproduced on 1.4.0 and 1.4.2 on 2026-09-24).
import { RuleTester } from "oxlint/plugins-dev";

import { noSyncSpawnRule } from "./no-sync-spawn.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "syncSpawn" };

// The rule is scoped by filename, so every case is given one: a case with none is out of scope and valid by
// construction.
const cli = "packages/cli/src/commands/deploy-local.ts";
const lock = "packages/cli-backend/src/config-lock.ts";
const daemon = "packages/pc-agent/src/index.js";

tester.run("anti-slop/no-sync-spawn", noSyncSpawnRule, {
  valid: [
    // The remedies: an async spawn awaited on the child's exit, in both runtimes' spellings.
    { code: "const ps = Bun.spawn({ cmd: ['/bin/ps'], stdout: 'pipe' }); await ps.exited;", filename: lock },
    { code: "import { execFile } from 'node:child_process'; execFile('ps', ['-p', '1'], (error, stdout) => done(stdout));", filename: cli },
    { code: "const { spawn, execFile } = require('node:child_process');", filename: daemon },
    // A name, not a spawn: the codemode shim offers the model an async-only stand-in under the node name.
    { code: "const shim = { execSync: asyncOnly('child_process.execSync', viaExec) };", filename: "packages/core/src/execution/codemode-node-shim.ts" },
    // A method of something that is not the module.
    { code: "db.execSync('SELECT 1');", filename: cli },
    // Outside shipped source: suites, their helpers and scripts are not on a user's machine.
    { code: "import { spawnSync } from 'node:child_process'; spawnSync('tar', ['-czf', 'x']);", filename: "packages/cf-backend/tests/unit-install-script.test.ts" },
    { code: "import { execFileSync } from 'node:child_process'; execFileSync('git', ['status']);", filename: "packages/test-utils/src/git.ts" },
    { code: "Bun.spawnSync(['bash', '-n']);", filename: "scripts/deploy-preflight.ts" },
  ],
  invalid: [
    {
      name: "the config lock's Darwin identity read as it stood at 8dcca981a",
      code: "const result = Bun.spawnSync({ cmd: ['/bin/ps', '-p', String(pid), '-o', 'lstart='], env: { LC_ALL: 'C' }, stdout: 'pipe', stderr: 'pipe' });",
      filename: lock,
      errors: [error],
    },
    {
      name: "deploy-local's named import, reported where it is imported",
      code: "import { spawn, spawnSync } from 'node:child_process'; const listed = spawnSync('ps', ['-o', 'args=', '-p', String(pid)]);",
      filename: cli,
      errors: [error],
    },
    {
      name: "the daemon's destructured require, one report per synchronous name",
      code: "const { spawn, spawnSync, execFileSync } = require('node:child_process');",
      filename: daemon,
      errors: [error, error],
    },
    {
      name: "an alias still imports the synchronous spawner",
      code: "import { execFileSync as run } from 'child_process'; run('ps');",
      filename: cli,
      errors: [error],
    },
    {
      name: "a namespace import read by name",
      code: "import * as cp from 'node:child_process'; cp.execSync('ls');",
      filename: cli,
      errors: [error],
    },
    {
      name: "a required module read by name, before or after the require",
      code: "function list() { return cp.execFileSync('ps'); }\nconst cp = require('child_process');",
      filename: daemon,
      errors: [error],
    },
    {
      name: "a require read in place",
      code: "require('node:child_process').spawnSync('tar', ['-xzf', archive]);",
      filename: daemon,
      errors: [error],
    },
    {
      name: "a computed read of Bun's",
      code: "Bun['spawnSync'](['ls']);",
      filename: lock,
      errors: [error],
    },
  ],
});

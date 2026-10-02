import { RuleTester } from 'oxlint/plugins-dev';
import { noAmbientBunInTestsRule } from './no-ambient-bun-in-tests.ts';

const tester = new RuleTester();
const filename = 'packages/core/tests/child.test.ts';
const errors = [{ messageId: 'ambient' }];

tester.run('no-ambient-bun-in-tests', noAmbientBunInTestsRule, {
  valid: [
    { filename, code: 'Bun.spawn([process.execPath, "-e", code], { env: process.env });' },
    { filename, code: 'const env = childEnv(); const options = {env}; Bun.spawn(["bun", script], options);' },
    { filename, code: 'const safe = {env: process.env}; Bun.spawn({cmd:["bun",script], ...safe});' },
    { filename, code: 'import {spawn as child} from "node:child_process"; child("bun", [script], {env: childEnv()});' },
    { filename, code: 'Bun.spawn(["sleep", "1"]);' },
    { filename, code: 'const Bun = {spawn() {}}; Bun.spawn(["bun", script]);' },
    { filename, code: 'const guest = "Bun.spawn([process.execPath, script])";' },
    { filename: 'packages/core/src/runner.ts', code: 'Bun.spawn(["bun", script]);' },
    { filename, code: 'import {spawnTest} from "@kinu.run/test-utils"; spawnTest([process.execPath,script]);' },
  ],
  invalid: [
    { filename, code: 'Bun.spawn(["bun", script]);', errors },
    { filename, code: 'Bun.spawn([process.execPath, script], {cwd: scratch});', errors },
    { filename, code: 'Bun.spawn({cmd:[process.execPath,script], cwd: scratch});', errors },
    { filename, code: 'Bun.spawnSync([process.execPath,script]);', errors },
    { filename, code: 'import {spawn as child} from "bun"; child(["bun", script]);', errors },
    { filename, code: 'import * as runtime from "bun"; runtime.spawn(["bun",script]);', errors },
    { filename, code: 'const executable=process.execPath; const argv=[executable,script]; Bun.spawn(argv);', errors },
    { filename, code: 'Bun.spawn(argv, {cwd:options.cwd});', errors },
    { filename, code: 'const options={cwd:scratch}; Bun.spawn(["bun",script], options);', errors },
    { filename, code: 'const safe={env:process.env}; Bun.spawn(["bun",script], {...safe,env:undefined});', errors },
    { filename, code: 'import {spawnSync} from "node:child_process"; spawnSync("bun", [script], {cwd:scratch});', errors },
    { filename, code: 'import cp from "child_process"; cp.execFile(process.execPath,[script]);', errors },
    { filename: 'packages/core/tests/child.test.js', code: 'const {spawn: child}=require("node:child_process"); child("bun",[script]);', errors },
    { filename: 'packages/core/tests/child.test.js', code: 'const cp=require("child_process"); cp.spawn(process.execPath,[script]);', errors },
  ],
});

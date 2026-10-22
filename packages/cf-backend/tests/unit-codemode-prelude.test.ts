/**
 * The prelude every eval program runs under (`renderToolsPrelude`), with the shipped shim: what it binds is what a
 * program reaches. Owner decision, 2026-10-20 ("Run where the files live"): a `child_process` command whose cwd is the
 * computer's runs there, through the computer's own exec. Staging rc29 showed a seam the runtime assembled apart from
 * its tests; here the binding is the product's.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { WORKSPACE_ROOT } from '@kinu.run/core';
import { runProgram } from './helpers/codemode-program';

describe("an eval program's child_process", () => {
  test("runs a command whose cwd is the computer's on the computer, in its own terms; any other in the workspace", async () => {
    const ran: (readonly [string, string, string | undefined])[] = [];

    const machine = (name: string) => ({
      exec: async (command: string, options?: { readonly cwd?: string }) => {
        ran.push([name, command, options?.cwd]);

        return { exitCode: 0, stdout: `${name}\n`, stderr: '' };
      },
    });

    // The workspace's file plane says which machine a path is on (`fs.machine`), as the gated plane answers it.
    const workspace = {
      ...machine('workspace'),
      fs: {
        machine: async (path: string) => (path.startsWith('/computer/')
          ? { machine: 'computer', path: path.slice('/computer'.length) }
          : { machine: 'workspace', path }),
      },
    };

    const answers = await runProgram([
      'const cp = require("child_process");',
      'return [await cp.execFile("npx", ["tsc", "--noEmit"], { cwd: "/computer/workspace/app" }), await cp.execFile("ls", [], { cwd: "notes" })];',
    ].join('\n'), { workspace, computer: machine('computer') }, WORKSPACE_ROOT, v.array(v.object({ stdout: v.string(), stderr: v.string() })));

    expect(answers).toEqual([{ stdout: 'computer\n', stderr: '' }, { stdout: 'workspace\n', stderr: '' }]);
    expect(ran).toEqual([['computer', "'npx' 'tsc' '--noEmit'", '/workspace/app'], ['workspace', "'ls'", `${WORKSPACE_ROOT}/notes`]]);
  });
});

// Nimbus ask 67: `fs` and `child_process` are Nimbus's node-compat, the one Node surface the workspace's own programs
// get, over the program's file namespace and each machine's exec. Before, Kinu's own copy refused `spawn`, answered a
// made directory, a removal or a rename with a TypeError, and drifted from Node's errors.
describe("an eval program's fs and child_process are Nimbus's node-compat over the workspace", () => {
  test('directories, renames and removals are the workspace commands, spawn and the callback forms are Node\'s, and a sync form refuses', async () => {
    const ran: (readonly [string, string | undefined])[] = [];
    const files = new Map<string, string>([[`${WORKSPACE_ROOT}/a.txt`, 'alpha']]);
    // What the made directory is once its command ran, as the plane then states it.
    const directories = new Set([`${WORKSPACE_ROOT}/out/deep`]);

    const workspace = {
      exec: async (command: string, options?: { readonly cwd?: string }) => {
        ran.push([command, options?.cwd]);

        return { exitCode: 0, stdout: command.startsWith("'ls'") ? 'a.txt\n' : '', stderr: '' };
      },
      fs: {
        machine: async (path: string) => ({ machine: 'workspace', path }),
        stat: async (path: string) => {
          const text = files.get(path);

          if (directories.has(path)) return { path, size: 0, mtimeMs: 1_000, isDir: true };

          return text === undefined
            ? { success: false, reason: 'missing', error: `no such file: ${path}` }
            : { path, size: text.length, mtimeMs: 1_000, isDir: false };
        },
        text: async (path: string, options?: { readonly encoding?: string }) => {
          const text = files.get(path);

          if (text === undefined) return { success: false, reason: 'missing', error: `no such file: ${path}` };

          return options?.encoding === 'base64' ? Buffer.from(text).toString('base64') : text;
        },
      },
    };

    const answer = await runProgram([
      'const fs = require("fs");',
      'const cp = require("child_process");',
      'await fs.promises.mkdir("out/deep", { recursive: true });',
      'await fs.promises.rename("a.txt", "out/a.txt");',
      'await fs.promises.rm("out/deep", { recursive: true });',
      'const read = await fs.promises.readFile("a.txt", "utf8");',
      'const missing = await fs.promises.readFile("b.txt").then(() => null, (error) => [error.code, error.path]);',
      'const spawned = await new Promise((resolve) => {',
      '  const child = cp.spawn("ls", ["-1"]);',
      '  let out = "";',
      '  child.stdout.on("data", (chunk) => { out += chunk; });',
      '  child.on("close", (code) => resolve([code, out]));',
      '});',
      'const called = await new Promise((resolve) => { cp.exec("echo hi", (error, stdout) => resolve(error === null)); });',
      'let sync = null;',
      'try { fs.readFileSync("a.txt"); } catch (error) { sync = error.code; }',
      'return { read, missing, spawned, called, sync };',
    ].join('\n'), { workspace }, WORKSPACE_ROOT, v.object({
      read: v.string(), missing: v.tuple([v.string(), v.string()]), spawned: v.tuple([v.number(), v.string()]), called: v.boolean(), sync: v.string(),
    }));

    expect(answer).toEqual({ read: 'alpha', missing: ['ENOENT', 'b.txt'], spawned: [0, 'a.txt\n'], called: true, sync: 'EAGAIN' });
    expect(ran).toEqual([
      [`mkdir -p -- '${WORKSPACE_ROOT}/out/deep'`, undefined],
      [`mv -- '${WORKSPACE_ROOT}/a.txt' '${WORKSPACE_ROOT}/out/a.txt'`, undefined],
      [`rm -r -- '${WORKSPACE_ROOT}/out/deep'`, undefined],
      ["'ls' '-1'", WORKSPACE_ROOT],
      ['echo hi', WORKSPACE_ROOT],
    ]);
  });
});

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

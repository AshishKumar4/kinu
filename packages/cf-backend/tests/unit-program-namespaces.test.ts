/**
 * A program's namespaces are never thenables. Production crafted-harbor-37f29697, 2026-10-16: the vendor's namespace
 * proxy answers any name as a member, so `await agents` called `agents.then(resolve, reject)` as one; it rejected
 * unheard, the await waited on callbacks nothing called, and the program held its job running for 12.5 h.
 */
import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@kinu.run/core';
import { CodemodeLauncher, createRuntimeExecutor, KinuSandboxExecutor } from '../src/codemode-sandbox';
import { workerContext } from './helpers/bindings';
import { inProcessWorkerLoader } from './helpers/worker-loader';

/** `agents`, with the one member a program here calls. */
const AGENTS = [{ name: 'agents', fns: { list: async () => ['helper'] } }];

/** Each program awaits a namespace itself, or hands one back from its async body, which adopts it the same way. */
const PROGRAMS: ReadonlyArray<readonly [string, JsonValue]> = [
  ['return await agents ? "awaited" : "never";', 'awaited'],
  ['const ns = await agents;\nreturn await ns.list();', ['helper']],
  ['return typeof (await Promise.resolve(agents)).list;', 'function'],
];

function launcher(kinuNode: boolean): CodemodeLauncher {
  // `WorkerLoader` is a workerd binding with no constructible form; codemode reaches only `load`.
  const loader: WorkerLoader = Object.create(inProcessWorkerLoader());

  return new CodemodeLauncher({ ...workerContext(), props: { kinuNode, egress: null } }, { LOADER: loader });
}

describe('a program that awaits a namespace gets the namespace', () => {
  test.each(PROGRAMS)('in the eval sandbox: %s', async (code, answer) => {
    expect(await new KinuSandboxExecutor(launcher(true)).execute(code, AGENTS)).toEqual({ result: answer, logs: [] });
  });

  test.each(PROGRAMS)("in the runtime's executor: %s", async (code, answer) => {
    expect(await createRuntimeExecutor(launcher(false)).execute(code, AGENTS)).toEqual({ result: answer, logs: [] });
  });
});

/**
 * The CLI's shells under the stateless contract: every call starts fresh at its `cwd` or the home, and says where; a
 * `cd` or `export` ends with its call. The workspace's own shell keeps no names; a directory's host shell keeps them.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolExecutionOptions } from 'ai';
import { codemodeSurface, createBashShell, DEVICE_REQUEST_OPTION, DeviceRequestOwnership, executorNamespace } from '@kinu.run/core';
import { narrowToolSurface } from '@kinu.run/core';
import { scratchDir, workspaceDatabase } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { createCLIRuntime, createHostShell } from '../src/runtime';

/** A directory's host shell, wrapped as the runtime wraps it; no runtime is built for a shell's own state. */
function shellOf(directory = scratchDir('cli-shell-calls-folder')) {
  return createBashShell(createHostShell(directory), {
    home: directory, scope: 'calls', stateDirectory: scratchDir('cli-shell-calls-state'),
  });
}

/** One runtime over the eval directory, built once: both eval cases read only its codemode surface. */
const evalDirectory = scratchDir('cli-shell-eval');

writeFileSync(join(evalDirectory, 'package.json'), '{"name":"probe"}');

const evalRuntime = createCLIRuntime(workspaceDatabase(join(scratchDir('cli-shell-calls'), 'agent.db')), { llm: null, agentName: 'calls', cwd: evalDirectory });

// Its executors alone: these cases call `workspace.exec` and nothing else.
const { execute } = createNodeCodemodeToolFactory({
  reach: narrowToolSurface(undefined), namespaces: (evalRuntime.executionRouter?.getProviders() ?? []).map(executorNamespace),
})({ ...codemodeSurface(evalRuntime, {}), craftedTools: () => [] });

/** `eval` over the directory's runtime, called with the tool options a turn hands it. */
function run(code: string, options: Partial<ToolExecutionOptions<unknown>> & { [DEVICE_REQUEST_OPTION]?: DeviceRequestOwnership } = {}) {
  if (!execute) throw new Error('eval has no execute');

  return execute({ code }, { toolCallId: 'call_eval', messages: [], context: undefined, ...options });
}

test("a directory's host shell starts each call fresh there, and a name keeps its directory and exports", async () => {
  const directory = scratchDir('cli-host-shell');
  mkdirSync(join(directory, 'sub'));
  const shell = shellOf(directory);

  expect(await shell.exec('cd sub && export LEFT=1 && pwd')).toMatchObject({ stdout: `${directory}/sub\n`, cwd: directory });
  expect(await shell.exec('pwd; echo "left=$LEFT"')).toMatchObject({ stdout: `${directory}\nleft=\n` });
  expect(await shell.exec('cd sub && export TOKEN=s3 && exit 3', { name: 'work' })).toMatchObject({ exitCode: 3, finalCwd: `${directory}/sub` });
  expect(await shell.exec('pwd; echo "token=$TOKEN"', { name: 'work' })).toMatchObject({ stdout: `${directory}/sub\ntoken=s3\n`, cwd: `${directory}/sub` });
});

test("the workspace's shell answers a call while another still runs, and a cancel stops that one", async () => {
  const shell = shellOf();
  const stop = new AbortController();
  const held = shell.exec('sleep 600', { signal: stop.signal });

  expect(await shell.exec('echo beside')).toMatchObject({ stdout: 'beside\n', exitCode: 0 });
  stop.abort();
  expect((await held).exitCode).not.toBe(0);
});

test("an eval's child process starts where the shell does, in the directory's own project", async () => {
  expect(await run("const { stdout } = await require('child_process').exec('cat package.json'); return stdout;"))
    .toMatchObject({ result: '{"name":"probe"}' });
});

test("an eval's exec carries the call's job and cancel: the job's name answers busy, and the stop ends its command", async () => {
  const job = new DeviceRequestOwnership('job-1');
  job.drain('job-1');
  const stop = new AbortController();

  // Started first, so it holds the name when the later call reaches it.
  const held = run("return await workspace.exec('sleep 600', { name: 'server' });", { abortSignal: stop.signal, [DEVICE_REQUEST_OPTION]: job });
  await expect(run("return await workspace.exec('echo hi', { name: 'server' });")).rejects.toMatchObject({
    outcome: { success: false, reason: 'unavailable' },
  });
  stop.abort();
  await expect(held).rejects.toMatchObject({ outcome: { success: false, reason: 'io' } });
});

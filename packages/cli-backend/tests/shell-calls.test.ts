/**
 * The CLI's shells under the stateless contract: every call starts fresh at its `cwd` or the home, and says where; a
 * `cd` or `export` ends with its call. The workspace's own shell keeps no names; a directory's host shell keeps them.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolExecutionOptions } from 'ai';
import { codemodeSurface, DEVICE_REQUEST_OPTION, DeviceRequestOwnership } from '@kinu.run/core';
import { narrowToolSurface } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { createCLIRuntime } from '../src/runtime';

function runtimeOf(cwd = scratchDir('cli-shell-calls-folder')) {
  const db = new Database(join(scratchDir('cli-shell-calls'), 'agent.db'));

  return createCLIRuntime(db, { llm: null, agentName: 'calls', cwd });
}

function shellOf(cwd?: string) {
  const { shell } = runtimeOf(cwd);

  if (!shell) throw new Error('The runtime has no shell.');

  return shell;
}

/** `eval` over a directory's runtime, called with the tool options a turn hands it. */
function evalIn(directory: string) {
  const { execute } = createNodeCodemodeToolFactory({ reach: narrowToolSurface(undefined) })({ ...codemodeSurface(runtimeOf(directory), {}), craftedTools: () => [] });

  if (!execute) throw new Error('eval has no execute');

  return (code: string, options: Partial<ToolExecutionOptions> & { [DEVICE_REQUEST_OPTION]?: DeviceRequestOwnership } = {}) =>
    execute({ code }, { toolCallId: 'call_eval', messages: [], ...options });
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
  const directory = scratchDir('cli-shell-eval');
  writeFileSync(join(directory, 'package.json'), '{"name":"probe"}');

  expect(await evalIn(directory)("const { stdout } = await require('child_process').exec('cat package.json'); return stdout;"))
    .toMatchObject({ result: '{"name":"probe"}' });
});

test("an eval's exec carries the call's job and cancel: the job's name answers busy, and the stop ends its command", async () => {
  const run = evalIn(scratchDir('cli-shell-eval'));
  const job = new DeviceRequestOwnership('job-1');
  job.drain('job-1');
  const stop = new AbortController();

  // Started first, so it holds the name when the later call reaches it.
  const held = run("return await workspace.exec('sleep 600', { name: 'server' });", { abortSignal: stop.signal, [DEVICE_REQUEST_OPTION]: job });
  await expect(run("return await workspace.exec('echo hi', { name: 'server' });")).rejects.toThrow('shell server is busy with job job-1');
  stop.abort();
  await expect(held).rejects.toThrow('Command aborted');
});

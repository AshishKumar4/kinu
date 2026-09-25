// The hosted workspace is the agent's own, but its shell serves the actor's mount table: the user's machine at
// /pc and their Drive at /shared. A local-harm command there waits for the owner; one in the agent's home does not.
import { expect, test } from 'bun:test';
import type { ExecutorProvider } from '@kinu.run/core';
import { createMemoryVfs, present } from '@kinu.run/test-utils';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

test('on the hosted workspace shell, deleting under /pc or /shared waits for the owner; the agent\u2019s own home does not', async () => {
  const workspace = orchestratorHarness();
  const main = await hostedMainActor(workspace);
  const shell = present(main.actor.runtime.shell, 'the main actor\u2019s shell');

  expect((await shell.exec('rm -rf /pc/x')).refusal).toBeDefined();
  expect((await shell.exec('rm -rf /shared/notes')).refusal).toBeDefined();

  await shell.exec('cd /pc/proj');
  expect((await shell.exec('rm -rf .')).refusal).toBeDefined();

  expect((await shell.exec('cd ~')).exitCode).toBe(0);
  const own = await shell.exec('mkdir -p scratch/x && rm -rf scratch');
  expect({ refusal: own.refusal, exitCode: own.exitCode }).toEqual({ refusal: undefined, exitCode: 0 });
});

/** The main actor with a connected machine whose project is at /pc/proj, so a `cd` there succeeds. */
async function withDevice() {
  const workspace = orchestratorHarness();
  const main = await hostedMainActor(workspace);
  const project = createMemoryVfs();
  await project.vfs.mkdir('/proj');
  await project.vfs.writeFile('/proj/kept.txt', 'the user\u2019s work');

  const device: ExecutorProvider = {
    name: 'device', kind: 'device', capabilities: new Set(['shell']), filesOwner: 'user', files: project.vfs,
    homeDir: async () => '/', isAvailable: () => true, connect: async () => {}, disconnect: async () => {}, tools: {},
  };

  const runtime = main.actor.runtime;
  present(runtime.executionRouter, 'the main actor\u2019s executors').register(device);
  const tools = present(runtime.executionRouter?.getProvider('workspace'), 'the workspace executor').tools;

  return { shell: present(runtime.shell, 'the main actor\u2019s shell'), tools, files: project.files };
}

const ASKED = { error: expect.stringContaining('rm-recursive') };

test('a `cd` into /pc through the shell tool carries to the process or shell program codemode starts next', async () => {
  const { shell, tools, files } = await withDevice();

  expect((await shell.exec('cd /pc/proj')).exitCode).toBe(0);
  expect(await tools.startProcess?.execute('rm -rf build')).toMatchObject(ASKED);
  expect(await tools.runCode?.execute('rm -rf build', { language: 'shell' })).toMatchObject(ASKED);

  expect((await shell.exec('cd ~')).exitCode).toBe(0);
  expect(await tools.runCode?.execute('mkdir -p scratch && rm -rf scratch', { language: 'shell' })).toBe('(no output)');
  expect([...files.keys()]).toEqual(['/proj/kept.txt']);
});

test('a `cd` into /pc through a shell program carries to the shell tool\u2019s next command', async () => {
  const { shell, tools, files } = await withDevice();

  expect(await tools.runCode?.execute('cd /pc/proj', { language: 'shell' })).toBe('(no output)');
  expect((await shell.exec('rm -rf build')).refusal).toMatchObject({ error: expect.stringContaining('rm-recursive') });

  expect(await tools.runCode?.execute('cd ~', { language: 'shell' })).toBe('(no output)');
  const own = await shell.exec('mkdir -p scratch && rm -rf scratch');
  expect({ refusal: own.refusal, exitCode: own.exitCode }).toEqual({ refusal: undefined, exitCode: 0 });
  expect([...files.keys()]).toEqual(['/proj/kept.txt']);
});

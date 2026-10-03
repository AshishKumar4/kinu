import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
// The hosted workspace is the agent's own, but its shell serves the actor's mount table: the user's machine at
// /pc and their Drive at /shared. A local-harm command there waits for the owner; one in the agent's home does not.
import { expect, test } from 'bun:test';
import { WORKSPACE_ROOT, type ExecutorProvider } from '@kinu.run/core';
import { createMemoryVfs, present } from '@kinu.run/test-utils';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

test('on the hosted workspace shell, deleting under /pc or /shared waits for the owner; the agent\u2019s own home does not', async () => {
  const workspace = orchestratorHarness();
  const main = await hostedMainActor(workspace);
  const shell = present(main.actor.runtime.shell, 'the main actor\u2019s shell');

  expect((await shell.exec('rm -rf /pc/x')).refusal).toBeDefined();
  expect((await shell.exec('rm -rf /shared/notes')).refusal).toBeDefined();
  expect((await shell.exec('rm -rf build', { cwd: '/pc/proj' })).refusal).toBeDefined();

  // A `cd` lasts only its own call: the next starts at home.
  await shell.exec('cd /shared');
  const own = await shell.exec('mkdir -p scratch/x && rm -rf scratch');
  expect({ refusal: own.refusal, exitCode: own.exitCode, cwd: own.cwd }).toEqual({ refusal: undefined, exitCode: 0, cwd: WORKSPACE_ROOT });
});

/** The main actor with a connected machine whose project is at /pc/proj, so a `cd` there succeeds. */
async function withDevice() {
  const workspace = orchestratorHarness();
  const main = await hostedMainActor(workspace);
  const project = createMemoryVfs();
  await project.vfs.mkdir('/proj');
  await writeText(project.vfs, '/proj/kept.txt', 'the user\u2019s work');

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

// The stateless shell: a name keeps its directory, read back from the shell itself, and is judged from there.
test('a name that went into /pc is judged there until it comes back; nothing else follows it there', async () => {
  const { shell, tools, files } = await withDevice();
  const work = { name: 'work' };

  expect(await shell.exec('cd /pc/proj', work)).toMatchObject({ exitCode: 0, finalCwd: '/pc/proj' });
  expect((await shell.exec('rm -rf build', work)).refusal).toMatchObject(ASKED);

  // An unnamed call, a process and a shell program start at home, not where the name is.
  const own = await shell.exec('mkdir -p scratch && rm -rf scratch');
  expect({ refusal: own.refusal, exitCode: own.exitCode }).toEqual({ refusal: undefined, exitCode: 0 });
  expect(await tools.runCode?.execute('mkdir -p scratch && rm -rf scratch', { language: 'shell' })).toBe('(no output)');

  expect((await shell.exec('cd ~', work)).exitCode).toBe(0);
  const back = await shell.exec('mkdir -p scratch && rm -rf scratch', work);
  expect({ refusal: back.refusal, exitCode: back.exitCode }).toEqual({ refusal: undefined, exitCode: 0 });
  expect([...files.keys()]).toEqual(['/proj/kept.txt']);
});

test('a shell program\u2019s `cd` into /pc lasts only that program', async () => {
  const { shell, tools, files } = await withDevice();

  expect(await tools.runCode?.execute('cd /pc/proj', { language: 'shell' })).toBe('(no output)');
  const own = await shell.exec('mkdir -p scratch && rm -rf scratch');
  expect({ refusal: own.refusal, exitCode: own.exitCode, cwd: own.cwd }).toEqual({ refusal: undefined, exitCode: 0, cwd: WORKSPACE_ROOT });
  expect([...files.keys()]).toEqual(['/proj/kept.txt']);
});

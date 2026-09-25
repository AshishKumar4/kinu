// The hosted workspace is the agent's own, but its shell serves the actor's mount table: the user's machine at
// /pc and their Drive at /shared. A local-harm command there waits for the owner; one in the agent's home does not.
import { expect, test } from 'bun:test';
import { present } from '@kinu.run/test-utils';
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

test('a `cd` into /pc through the shell tool carries to the process or shell program codemode starts next', async () => {
  const workspace = orchestratorHarness();
  const main = await hostedMainActor(workspace);
  const shell = present(main.actor.runtime.shell, 'the main actor\u2019s shell');
  const tools = present(main.actor.runtime.executionRouter?.getProvider('workspace'), 'the workspace executor').tools;
  const asked = { error: expect.stringContaining('rm-recursive') };

  await shell.exec('cd /pc/proj');
  expect(await tools.startProcess?.execute('rm -rf build')).toMatchObject(asked);
  expect(await tools.runCode?.execute('rm -rf build', { language: 'shell' })).toMatchObject(asked);

  expect((await shell.exec('cd ~')).exitCode).toBe(0);
  expect(await tools.runCode?.execute('mkdir -p scratch && rm -rf scratch', { language: 'shell' })).toBe('(no output)');
});

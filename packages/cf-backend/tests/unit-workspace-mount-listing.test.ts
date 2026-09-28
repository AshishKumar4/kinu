/** DF-MOUNTS-0924: the cloud workspace's `df`, `mount` and `/proc/mounts` list its mounts, not only the root. */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness } from './helpers/actor-harness';

const ShellOutput = v.object({ stdout: v.string(), exitCode: v.number() });

test('the workspace shell lists every live mount in df, mount and /proc/mounts', async () => {
  const workspace = orchestratorHarness();

  for (const command of ['df -h', 'mount', 'cat /proc/mounts']) {
    const { stdout, exitCode } = v.parse(ShellOutput, await workspace.agent.executeInExecutor('workspace', command));
    const points = stdout.split('\n').flatMap((line) => line.split(/\s+/).filter((field) => field.startsWith('/')));

    expect({ command, exitCode, points }).toEqual({ command, exitCode: 0, points: expect.arrayContaining(['/', '/context', '/skills']) });
  }
});

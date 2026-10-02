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

// `cat` and `head` read in ranges, so a view must answer one as a file does.
test("the workspace shell reads a skill's instructions, built in or the workspace's own, through /skills", async () => {
  const workspace = orchestratorHarness();
  const run = async (command: string) => v.parse(ShellOutput, await workspace.agent.executeInExecutor('workspace', command));

  await run("mkdir -p /home/main/skills/notes && printf '%s\\n' --- 'name: notes' 'description: keep notes' --- 'Write them down.' > /home/main/skills/notes/SKILL.md");

  for (const command of ['cat /skills/slates/SKILL.md', 'head -n 3 /skills/slates/SKILL.md']) {
    expect({ command, ...(await run(command)) }).toMatchObject({ command, exitCode: 0, stdout: expect.stringMatching(/\S/u) });
  }

  expect(await run('tail -n 1 /skills/notes/SKILL.md')).toEqual({ exitCode: 0, stdout: 'Write them down.\n' });
});

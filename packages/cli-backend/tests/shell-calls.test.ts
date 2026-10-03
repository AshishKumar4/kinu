/**
 * The CLI's shells under the stateless contract: every call starts fresh at its `cwd` or the home, and says where; a
 * `cd` or `export` ends with its call. The workspace's own shell keeps no names; a directory's host shell keeps them.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { createCLIRuntime } from '../src/runtime';

function shellOf(cwd?: string) {
  const db = new Database(join(scratchDir('cli-shell-calls'), 'agent.db'));
  const rt = createCLIRuntime(db, { llm: null, agentName: 'calls', ...(cwd !== undefined && { cwd }) });

  if (!rt.shell) throw new Error('The runtime has no shell.');

  return rt.shell;
}

test("the workspace's shell keeps neither a call's `cd` nor its `export`, and refuses a name it cannot keep", async () => {
  const shell = shellOf();

  expect(await shell.exec('mkdir -p sub && cd sub && export LEFT=1 && pwd')).toMatchObject({ stdout: `${WORKSPACE_ROOT}/sub\n`, cwd: WORKSPACE_ROOT });
  expect(await shell.exec('pwd; echo "left=$LEFT"')).toMatchObject({ stdout: `${WORKSPACE_ROOT}\nleft=\n`, cwd: WORKSPACE_ROOT });
  expect(await shell.exec('pwd', { cwd: 'sub' })).toMatchObject({ stdout: `${WORKSPACE_ROOT}/sub\n`, cwd: `${WORKSPACE_ROOT}/sub` });
  expect((await shell.exec('pwd', { name: 'work' })).refusal).toMatchObject({ reason: 'unsupported' });
});

test("a directory's host shell starts each call fresh there, and a name keeps its directory and exports", async () => {
  const directory = scratchDir('cli-host-shell');
  mkdirSync(join(directory, 'sub'));
  const shell = shellOf(directory);

  expect(await shell.exec('cd sub && export LEFT=1 && pwd')).toMatchObject({ stdout: `${directory}/sub\n`, cwd: directory });
  expect(await shell.exec('pwd; echo "left=$LEFT"')).toMatchObject({ stdout: `${directory}\nleft=\n` });
  expect(await shell.exec('cd sub && export TOKEN=s3 && exit 3', { name: 'work' })).toMatchObject({ exitCode: 3, finalCwd: `${directory}/sub` });
  expect(await shell.exec('pwd; echo "token=$TOKEN"', { name: 'work' })).toMatchObject({ stdout: `${directory}/sub\ntoken=s3\n`, cwd: `${directory}/sub` });
});

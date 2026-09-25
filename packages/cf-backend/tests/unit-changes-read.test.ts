/**
 * The Changes surface polls `getExecutorDiff('workspace')`, which walks the workspace only after a file event or a
 * review moved what it shows. Driven through the orchestrator's own RPCs and file plane, as the page drives them.
 */
import { expect, test } from 'bun:test';
import { orchestratorHarness, workspaceFiles } from './helpers/actor-harness';

test('the Changes read shows a file write and a shell write once they land, and a review clears them', async () => {
  const workspace = orchestratorHarness();

  // A write's file events are delivered on a microtask queued before its promise settles, so a read after it sees them.
  const listed = async (): Promise<string[]> => (await workspace.agent.getExecutorDiff('workspace')).files.map((file) => `${file.status} ${file.path}`);

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed()).toEqual([]);

  await workspaceFiles(workspace.agent).writeFile('notes.md', 'one\n');
  expect(await listed()).toEqual(['added notes.md']);

  await workspace.agent.executeInExecutor('workspace', 'echo from the shell > shell.txt');
  expect(await listed()).toEqual(['added notes.md', 'added shell.txt']);

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed()).toEqual([]);
});

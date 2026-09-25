/**
 * The Changes surface polls `getExecutorDiff('workspace')`, which walks the workspace only after a file event or a
 * review moved what it shows. Driven through the orchestrator's own RPCs and file plane, as the page drives them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentHome, subordinateAgentName } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness, workspaceFiles, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** The workspace's change-set as the page lists it. A write's file events are delivered on a microtask queued before
 *  its promise settles, so a read after it sees them. */
async function listed(workspace: ActorHarness<HarnessOrchestratorAgent>): Promise<string[]> {
  return (await workspace.agent.getExecutorDiff('workspace')).files.map((file) => `${file.status} ${file.path}`);
}

test('the Changes read shows a file write and a shell write once they land, and a review clears them', async () => {
  const workspace = orchestratorHarness();

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed(workspace)).toEqual([]);

  await workspaceFiles(workspace.agent).writeFile('notes.md', 'one\n');
  expect(await listed(workspace)).toEqual(['added notes.md']);

  await workspace.agent.executeInExecutor('workspace', 'echo from the shell > shell.txt');
  expect(await listed(workspace)).toEqual(['added notes.md', 'added shell.txt']);

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed(workspace)).toEqual([]);
});

test("a hire's write tells the workspace's pages that Changes moved, so a tab no one is looking at reads it", async () => {
  // Before, an unseen Changes tab read only when the page's own turn closed or the window took focus.
  const workspace = orchestratorHarness();
  const frames: string[] = [];

  Reflect.set(workspace.agent, 'broadcast', (payload: string) => { frames.push(payload); });

  const hire = await hostedSubordinateHarness(workspace, {
    name: 'builder-1', displayName: 'Builder', nameOrigin: 'user', roleId: 'task', mission: 'build the thing',
  });

  const home = agentHome(subordinateAgentName(hire.actor.handle.storageKey));

  const moved = (): unknown[] => frames.map((frame) => v.parse(v.looseObject({ type: v.string() }), JSON.parse(frame)))
    .filter((frame) => frame.type === 'changes_moved');

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed(workspace)).toEqual([]);
  frames.length = 0;

  await hire.actor.runtime.storage.vfs.writeFile(`${home}/notes.md`, 'mine\n');

  expect(moved()).toEqual([{ type: 'changes_moved' }]);
  expect(await listed(workspace)).toEqual([`added ${home}/notes.md`]);
});

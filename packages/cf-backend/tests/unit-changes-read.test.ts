import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The Changes surface polls `getExecutorDiff('workspace')`, which walks the workspace only after a file event or a
 * review moved what it shows. Driven through the orchestrator's own RPCs and file plane, as the page drives them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentHome, actorHomeName } from '@kinu.run/core';
import { gatewayWorkspace, hostedSubagentHarness, orchestratorHarness, sentTurn, workspaceFiles, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

/** The workspace's change-set as the page lists it. A write's file events are delivered on a microtask queued before
 *  its promise settles, so a read after it sees them. */
async function listed(workspace: ActorHarness<HarnessOrchestratorAgent>): Promise<string[]> {
  return (await workspace.agent.getExecutorDiff('workspace')).files.map((file) => `${file.status} ${file.path}`);
}

test('the Changes read shows a file write and a shell write once they land, and a review clears them', async () => {
  const workspace = orchestratorHarness();

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed(workspace)).toEqual([]);

  await writeText(workspaceFiles(workspace.agent), 'notes.md', 'one\n');
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

  const hire = await hostedSubagentHarness(workspace, {
    name: 'builder-1', displayName: 'Builder', nameOrigin: 'user', roleId: 'task', mission: 'build the thing',
  });

  const home = agentHome(actorHomeName({ origin: 'agent', name: hire.actor.handle.name, storageKey: hire.actor.handle.storageKey }));

  const moved = (): unknown[] => frames.map((frame) => v.parse(v.looseObject({ type: v.string() }), JSON.parse(frame)))
    .filter((frame) => frame.type === 'changes_moved');

  await workspace.agent.resetWorkspaceBaseline();
  expect(await listed(workspace)).toEqual([]);
  frames.length = 0;

  await writeText(hire.actor.runtime.storage.vfs, `${home}/notes.md`, 'mine\n');

  expect(moved()).toEqual([{ type: 'changes_moved' }]);
  expect(await listed(workspace)).toEqual([`added ${home}/notes.md`]);
});

// The owner, 2026-10-25: "user uploaded files shouldn't appear in the 'changes' tab really." Changes reviews the agents'
// work; what the person uploaded is their own.
test("a person's upload stays out of Changes, and the file the agent wrote beside it is listed", async () => {
  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length === 0) return chatCompletion(run, 'Report');

    if (!JSON.stringify(messages).includes('Summarize') || messages.some((message) => message.role === 'tool')) return chatCompletion(run, 'Done.');

    return toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: 'summary.md', content: 'The report says hello.\n' } }, 'call_write');
  });

  const workspace = gatewayWorkspace(gateway);

  // The first turn sets the agent up (its scaffold); the review after it is where the person's work begins.
  await sentTurn(workspace.agent, 'Hello.', crypto.randomUUID());
  await workspace.agent.resetWorkspaceBaseline();
  await sentTurn(workspace.agent, 'Summarize this report.', crypto.randomUUID(), {
    files: [{ filename: 'report.txt', mediaType: 'text/plain', url: `data:text/plain;base64,${Buffer.from('hello\n').toString('base64')}` }],
  });

  expect(await readText(workspaceFiles(workspace.agent), '/uploads/report.txt')).toBe('hello\n');
  expect(await listed(workspace)).toEqual(['added summary.md']);
});

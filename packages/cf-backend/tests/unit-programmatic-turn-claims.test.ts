/**
 * A programmatic turn of main's runs under `programmatic:<key>` in its own isolate, and its producer knows it by the key
 * alone. The workspace keeps the claims of the tools it ran for the turn under the id the turn settles under, so its
 * settlement releases them.
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace, storedChat } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test("a programmatic turn's workspace tool claims are released when it settles", async () => {
  const gateway = stubAiBinding((run) => (requestOf(run).messages.some((message) => message.role === 'tool')
    ? chatCompletion(run, 'Nothing is open.')
    : toolCallCompletion(run, { tool: 'tasks', args: { op: 'list' } }, 'list_0')));

  const workspace = gatewayWorkspace(gateway);

  expect(await workspace.agent.runTaskFromMcp('List the open tasks.')).toEqual({ status: 'queued' });
  await workspace.agent.harnessAgentsIdle();
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  expect((await storedChat(workspace)).at(-1)?.parts).toContainEqual(expect.objectContaining({ text: 'Nothing is open.' }));
  // The settled response's own record stays, as every turn's does; no tool call's claim does.
  expect(workspace.db.query("SELECT turn_id, normalized_call_id FROM tool_effect_claims WHERE normalized_call_id NOT LIKE 'terminal:response:%'").all()).toEqual([]);
});

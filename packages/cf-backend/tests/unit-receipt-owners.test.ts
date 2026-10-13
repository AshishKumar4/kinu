/**
 * A tool call's receipt lives in the store its effect commits to (design v2 §4), and goes when its run settles. The
 * owner's lane (a plan, a reply, a question) commits in the agent's own isolate, so its receipt is kept there and the
 * workspace keeps none around it; a workspace tool keeps its receipt in the workspace, which drops it at the run's settle
 * for every agent, not main's alone, and as it takes a delivered run's end.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane, joinHarnessFibers } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace, mainDatabase, ownDatabase } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const Receipts = v.array(v.object({ actor_id: v.string(), settled: v.number() }));

const RECEIPTS = "SELECT actor_id, result_json IS NOT NULL AS settled FROM tool_effect_claims WHERE normalized_call_id = ? AND normalized_call_id NOT LIKE 'terminal:%'";

/** The owner's Plan message, as the pane sends one. */
function planRequest(id: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id, role: 'user', parts: [{ type: 'text', text: 'Plan the parser fix.' }], metadata: { kinuMode: 'plan' } }],
      trigger: 'submit-message',
    }) },
  });
}

test("a plan the agent submits commits under its own store's receipt, and the workspace keeps none around it", async () => {
  const held: { readonly workspace: v.InferOutput<typeof Receipts>; readonly agent: v.InferOutput<typeof Receipts> }[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (!tools.includes('submit_plan')) return chatCompletion(run, 'Noted.');

    // Read as the call answered, before the run's settle drops either store's receipts.
    if (messages.some((message) => message.role === 'tool')) {
      held.push({
        workspace: v.parse(Receipts, workspace.db.query(RECEIPTS).all('call_plan')),
        agent: v.parse(Receipts, mainDatabase(workspace).query(RECEIPTS).all('call_plan')),
      });

      return chatCompletion(run, 'Submitted the plan.');
    }

    return toolCallCompletion(run, { tool: 'submit_plan', args: { edits: [{ start: 1, content: '# Plan\n\nFix the parser.' }] } }, 'call_plan');
  }));

  const owner = socketConnection({ id: 'owner', send: () => {} });

  await workspace.agent.onMessage(owner, planRequest(crypto.randomUUID()));
  await driveUntil(workspace, 'the plan was never submitted', () => held.length > 0);
  await workspace.agent.harnessAgentsIdle();

  expect(await workspace.agent.getActivePlanReview()).toMatchObject({ revision: 1, status: 'pending' });
  expect(held[0]?.workspace).toEqual([]);
  expect(held[0]?.agent.map((row) => row.settled)).toEqual([1]);
});

test("an agent's settled run leaves the workspace no receipt of the tools it ran there", async () => {
  const TASK = 'List what is open.';
  const during: v.InferOutput<typeof Receipts>[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages } = requestOf(run);

    if (!openingOf(run).includes(TASK)) return chatCompletion(run, 'Noted.');

    if (messages.some((message) => message.role === 'tool')) {
      during.push(v.parse(Receipts, workspace.db.query(RECEIPTS).all('call_list')));

      return chatCompletion(run, 'Nothing is open.');
    }

    return toolCallCompletion(run, { tool: 'tasks', args: { op: 'list' } }, 'call_list');
  }));

  // An agent the owner adds inherits the workspace's mission, which the owner's soul states.
  await workspace.agent.setSoul('# Kinu\n\n## Mission\n\nKeep the ledger.\n');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = subordinate.actorId ?? '';

  await asPane([actorConnectionTag(actorId)], () => workspace.agent.send(TASK, crypto.randomUUID()));
  await driveUntil(workspace, 'the agent never answered', () => during.length > 0);
  await workspace.agent.harnessAgentsIdle();
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  // Kept in the workspace while the run could re-ask it; its isolate keeps none.
  expect(during[0]?.map((row) => [row.actor_id, row.settled])).toEqual([[actorId, 1]]);
  expect(v.parse(Receipts, ownDatabase(workspace, actorId).query(RECEIPTS).all('call_list'))).toEqual([]);
  expect(v.parse(Receipts, workspace.db.query(RECEIPTS).all('call_list'))).toEqual([]);
});

test("a swarm node's delivered run leaves the workspace no receipt of the tools it ran there once its end is taken", async () => {
  const ASK = 'Find a way to speed up the parser.';
  const during: v.InferOutput<typeof Receipts>[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const answered = requestOf(run).messages.some((message) => message.role === 'tool');

    if (!openingOf(run).includes(ASK)) {
      if (answered) during.push(v.parse(Receipts, workspace.db.query(RECEIPTS).all('node_write')));

      return answered ? chatCompletion(run, 'Wrote the note.')
        : toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: 'notes/idea.md', content: 'cache the token table' } }, 'node_write');
    }

    return answered ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  }));

  await asPane([], () => workspace.agent.send(ASK, crypto.randomUUID()));
  await driveUntil(workspace, 'the search never completed', () => workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status === 'completed');
  await workspace.agent.harnessAgentsIdle();
  await joinHarnessFibers();

  // Kept while the run could re-ask it, and gone with its end.
  expect(during[0]?.map((row) => row.settled)).toEqual([1]);
  expect(v.parse(Receipts, workspace.db.query(RECEIPTS).all('node_write'))).toEqual([]);
});

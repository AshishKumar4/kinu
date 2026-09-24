/**
 * The lifetime search bills each of its branches' model calls once, by the engine, from the usage the branch
 * returns; the lane's model route is core's (unit-profile-routing). Driven as production drives it: the turn
 * that closes the actor's fifth window starts the search, and every model call is the platform gateway's. The
 * four windows already closed are the actor's stored state from an earlier life.
 */
import { expect, test } from 'bun:test';
import { agentHome, headAgentName, parseActorKey } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import {
  chatCompletion, requestOf, stubAiBinding, type RecordedGatewayRun, type StubbedAiBinding,
} from './helpers/platform-gateway';

/** The branch lane's two calls: exploring one approach, and reflecting on the traces. */
function isBranchCall(run: RecordedGatewayRun): boolean {
  const opening = JSON.stringify(requestOf(run).messages[0]?.content ?? '');

  return opening.includes('You are an expert agent exploring one approach') || opening.startsWith('"Task: Given my purpose');
}

async function lifetimeSearch(gateway: StubbedAiBinding) {
  const workspace = gatewayWorkspace(gateway);
  workspace.db.run(
    "INSERT INTO actor_config (actor_id, key, value) VALUES (?, 'closed_turn_windows', '4')",
    [workspaceMainActor(workspace.db).actorId],
  );

  for (let turn = 1; turn <= 5; turn++) await catalogTurn(workspace.agent, `turn ${turn}`);
  await workspace.agent.harnessJoinDetachedFibers();

  return workspace;
}

test("a lifetime search's branch calls are billed once each", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Cache the token table between passes.'));
  const { agent } = await lifetimeSearch(gateway);

  const branchCalls = gateway.runs.filter(isBranchCall);
  const billed = (await agent.getActivitySnapshot()).spend.producers.find((producer) => producer.source === 'mcts');

  expect(branchCalls.length).toBeGreaterThan(0);
  // The gateway reports one input and one output token per answer.
  expect(billed).toMatchObject({ calls: branchCalls.length, usage: { input: branchCalls.length, output: branchCalls.length } });
});

test('a branch call the provider fails is not billed', async () => {
  const gateway = stubAiBinding((run) => (isBranchCall(run)
    ? new Response(JSON.stringify({ error: { message: 'the request was refused' } }), { status: 400 })
    : chatCompletion(run, 'Cache the token table between passes.')));

  const { agent } = await lifetimeSearch(gateway);

  expect(gateway.runs.filter(isBranchCall).length).toBeGreaterThan(0);
  expect((await agent.getActivitySnapshot()).spend.producers.filter((producer) => producer.source === 'mcts')).toEqual([]);
});

test('a rollout branch is given no home to act in', async () => {
  const { agent, db } = await lifetimeSearch(stubAiBinding((run) => chatCompletion(run, 'Cache the token table between passes.')));
  const branches = db.query<{ storage_key: string }, []>("SELECT storage_key FROM workspace_actors WHERE kind = 'branch'").all();

  expect(branches.length).toBeGreaterThan(0);
  // The plane answers for a directory that exists, so an absent home is not a blind read.
  expect(await agent.statWorkspaceFile('/home')).toMatchObject({ ok: true, value: expect.objectContaining({ isDir: true }) });

  for (const branch of branches) {
    expect(await agent.statWorkspaceFile(agentHome(headAgentName(parseActorKey(branch.storage_key).id))))
      .toEqual({ ok: true, value: null });
  }
});

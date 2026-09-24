/**
 * The lifetime search runs each branch on the model the turn tier names, and bills each of its branches' model
 * calls once, by the engine, from the usage the branch returns. Driven as production drives it: the turn that
 * closes the actor's fifth window starts the search, and every model call is the platform gateway's. The four
 * windows already closed are the actor's stored state from an earlier life.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentHome, headAgentName, parseActorKey } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import {
  catalogTurn, gatewayWorkspace, orchestratorHarness, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import {
  chatCompletion, requestOf, stubAiBinding, type RecordedGatewayRun, type StubbedAiBinding,
} from './helpers/platform-gateway';

/** The branch lane's two calls: exploring one approach, and reflecting on the traces. */
function isBranchCall(run: RecordedGatewayRun): boolean {
  const opening = JSON.stringify(requestOf(run).messages[0]?.content ?? '');

  return opening.includes('You are an expert agent exploring one approach') || opening.startsWith('"Task: Given my purpose');
}

async function lifetimeSearch(gateway: StubbedAiBinding, workspace: ActorHarness<HarnessOrchestratorAgent> = gatewayWorkspace(gateway)) {
  workspace.db.run(
    "INSERT INTO actor_config (actor_id, key, value) VALUES (?, 'closed_turn_windows', '4')",
    [workspaceMainActor(workspace.db).actorId],
  );

  for (let turn = 1; turn <= 5; turn++) await catalogTurn(workspace.agent, `turn ${turn}`);
  await workspace.agent.harnessJoinDetachedFibers();

  return workspace;
}

/** The model a gateway request named, as the provider's chat request carries it. */
function modelOf(run: RecordedGatewayRun): string {
  return v.parse(v.looseObject({ model: v.string() }), run.query).model;
}

test('every branch call runs on the turn tier\'s model, not another tier\'s or the account default', async () => {
  // Three tiers on three models: a branch handed a fixed tier, or no spec at all, names another model than the turn's.
  const tier = (name: string) => `ai-gateway/workers-ai/@cf/harness/${name}`;
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Cache the token table between passes.'));
  const workspace = orchestratorHarness(undefined, { aiGateway: gateway });

  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: tier('turn') }, deep: { model: tier('deep') }, fast: { model: tier('fast') } },
    availableModels: [tier('turn'), tier('deep'), tier('fast')],
  });
  await lifetimeSearch(gateway, workspace);

  const branchModels = gateway.runs.filter(isBranchCall).map(modelOf);
  const turnModel = modelOf(present(gateway.runs.find((run) => !isBranchCall(run)), 'a turn\'s own model call'));

  expect(branchModels.length).toBeGreaterThan(0);
  expect(turnModel).toContain('harness/turn');
  expect([...new Set(branchModels)]).toEqual([turnModel]);
});

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

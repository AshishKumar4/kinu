/**
 * Every tab of a workspace hears each change to its main actor's turn claim. The claim is what the header, the
 * composer and the thread's tail fold "is a turn live" from; a tab read it only when it loaded, so a page opened
 * during a turn (every new workspace opens on its first turn) kept Stop and Thinking after that turn ended (#29),
 * and a tab that loaded a turn stranded by an eviction kept offering Recover after the wake re-opened it. Turns run
 * as production runs them, and the frames are read as the workspace's sockets are sent them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { ActorClaimStore, RunEventRecorder, TurnClaimFrameSchema, type TurnClaimState } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import {
  admittedTurnClaim, catalogTurn, chatSessionTurns, GATEWAY_CATALOG, gatewayWorkspace, historyOver, orchestratorHarness,
  reactivateOrchestratorHarness, until, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway, stubAiBinding, type StubbedAiBinding } from './helpers/platform-gateway';

/** Every claim the workspace's sockets are sent from here on, in order. */
function claimsHeard(agent: HarnessOrchestratorAgent): TurnClaimState[] {
  const heard: TurnClaimState[] = [];

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(TurnClaimFrameSchema, JSON.parse(payload));

      if (frame.success) heard.push(frame.output.claim);
    },
  });

  return heard;
}

/** A workspace whose process died inside a turn: its claim admitted, its run open, its model call never answered. */
async function evictedMidTurn(): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const evicted = orchestratorHarness();
  await chatSessionTurns(evicted.agent).prepare({ messages: [{ role: 'user', content: 'Say done.' }] });

  return evicted;
}

/** The next activation over the same rows, its models on the platform gateway. */
async function nextActivation(db: ActorHarness<HarnessOrchestratorAgent>['db']): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  return await reactivateOrchestratorHarness(db, undefined, {
    world: { aiGateway: answeringGateway('Done.') },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

/** The claims one turn on `gateway` sends every tab: its admission, then its settling, which names the turn. */
async function oneTurnHeard(gateway: StubbedAiBinding): Promise<{ readonly turnId: string; readonly settled: TurnClaimState | undefined; readonly loaded: TurnClaimState }> {
  const { agent } = gatewayWorkspace(gateway);
  const heard = claimsHeard(agent);

  await catalogTurn(agent, 'Say done.');

  const [admitted, settled, ...after] = heard;

  if (admitted?.kind !== 'admitted' || after.length > 0) throw new Error(`the turn sent ${JSON.stringify(heard)}, not its admission then its settling`);

  return { turnId: admitted.turnId, settled, loaded: (await agent.getWorkspaceSnapshot()).turnClaim };
}

test("a turn's claim reaches every tab as it is admitted and as it settles, what a tab loading now reads", async () => {
  const { turnId, settled, loaded } = await oneTurnHeard(answeringGateway('Done.'));

  expect(settled).toEqual({ kind: 'settled', turnId, outcome: 'completed' });
  expect(settled).toEqual(loaded);
});

test('a turn that fails settles naming itself and its outcome, so no tab reads it as having answered', async () => {
  const refusing = stubAiBinding(() => Response.json({ name: 'AiGatewayError', message: 'Invalid provider' }, { status: 400 }));
  const { turnId, settled, loaded } = await oneTurnHeard(refusing);

  expect(settled).toEqual({ kind: 'settled', turnId, outcome: 'error' });
  expect(settled).toEqual(loaded);
});

test('a turn an eviction stranded is heard running again when the wake re-opens it, then settled', async () => {
  const workspace = await nextActivation((await evictedMidTurn()).db);
  const loaded = (await workspace.agent.getWorkspaceSnapshot()).turnClaim;

  if (loaded.kind !== 'stranded') throw new Error(`a tab loading now reads ${loaded.kind}, not the stranded turn`);
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.terminalRetryPass();
  await until(() => heard.at(-1)?.kind === 'settled', 'the re-opened turn to settle');

  expect(heard).toEqual([
    { kind: 'admitted', turnId: loaded.turnId, claimedAt: expect.any(Number) },
    { kind: 'settled', turnId: loaded.turnId, outcome: 'completed' },
  ]);
});

test("a stranded claim the wake's recovery settles reaches every tab", async () => {
  const evicted = await evictedMidTurn();

  const claim = new ActorClaimStore(makeSql(evicted.db), workspaceMainActor(evicted.db), (write) => write(), historyOver(evicted))
    .unsettled(1)[0];

  if (claim === undefined) throw new Error('the evicted turn left no open claim');

  // Its run closed and its send spent, as the loop leaves them: only the claim is left for recovery to settle.
  evicted.db.query('DELETE FROM pending_steers').run();
  new RunEventRecorder(makeSql(evicted.db), workspaceMainActor(evicted.db))
    .emit(claim.runId, { type: 'run_end', reason: 'error', error: 'the process died before the claim settled' });
  const workspace = await nextActivation(evicted.db);
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.terminalRetryPass();

  // Recovery cannot know how a turn its process lost ended, whatever its run recorded.
  expect(heard).toEqual([{ kind: 'settled', turnId: claim.turnId, outcome: 'indeterminate' }]);
});

test('recovering a stranded turn reaches every tab, so its Recover control retires', async () => {
  const workspace = gatewayWorkspace(answeringGateway('Done.'));
  await admittedTurnClaim(workspace, 'turn-evicted');
  expect((await workspace.agent.getWorkspaceSnapshot()).turnClaim.kind).toBe('stranded');
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.recoverStrandedTurn();

  expect(heard).toEqual([{ kind: 'settled', turnId: 'turn-evicted', outcome: 'indeterminate' }]);
});

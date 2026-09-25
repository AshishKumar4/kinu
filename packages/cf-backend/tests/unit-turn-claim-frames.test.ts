/**
 * Every tab of a workspace hears each change to its main actor's turn claim, and the claim as it stands when it
 * connects. The claim is what the header, the composer and the thread's tail fold "is a turn live" from; a tab read it
 * only when it loaded, so a page opened during a turn (every new workspace opens on its first turn) kept Stop and
 * Thinking after that turn ended (#29), and a tab that loaded a turn stranded by an eviction kept offering Recover
 * after the wake re-opened it. Turns run as production runs them, and the frames are read as the workspace's sockets
 * are sent them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { ActorClaimStore, RunEventRecorder, TURN_CLAIM_FRAME, TurnClaimFrameSchema, type TurnClaimState } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import {
  admittedTurnClaim, catalogTurn, chatSessionTurns, GATEWAY_CATALOG, gatewayWorkspace, historyOver, orchestratorHarness,
  reactivateOrchestratorHarness, until, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';

const ConnectFrameSchema = v.looseObject({ type: v.string() });

/** The frames a tab connecting now is sent while it connects, in order. */
async function framesOnConnect(agent: HarnessOrchestratorAgent): Promise<v.InferOutput<typeof ConnectFrameSchema>[]> {
  const sent: string[] = [];
  const tab = socketConnection({ id: 'connecting-tab', send: (data: string) => { sent.push(data); } });

  await agent.onConnect(tab, { request: new Request('https://agent/connect') });

  return sent.map((raw) => v.parse(ConnectFrameSchema, JSON.parse(raw)));
}

/** The one claim a tab connecting now hears. It must come before the transcript the tab paints the answer from. */
async function claimOnConnect(agent: HarnessOrchestratorAgent): Promise<TurnClaimState> {
  const frames = await framesOnConnect(agent);
  const claims = frames.filter((frame) => frame.type === TURN_CLAIM_FRAME);
  const claimAt = frames.findIndex((frame) => frame.type === TURN_CLAIM_FRAME);
  const transcriptAt = frames.findIndex((frame) => frame.type === 'cf_agent_chat_messages');

  expect({ claims: claims.length, beforeTranscript: claimAt !== -1 && claimAt < transcriptAt }).toEqual({ claims: 1, beforeTranscript: true });

  return v.parse(TurnClaimFrameSchema, claims[0]).claim;
}

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

test("a turn's claim reaches every tab as it is admitted and as it settles, what a tab loading now reads", async () => {
  const { agent } = gatewayWorkspace(answeringGateway('Done.'));
  const heard = claimsHeard(agent);

  await catalogTurn(agent, 'Say done.');

  expect(heard.map((claim) => claim.kind)).toEqual(['admitted', 'settled']);
  expect(heard.at(-1)).toEqual((await agent.getWorkspaceSnapshot()).turnClaim);
});

test('a tab that connects hears the claim as it stands before the transcript, so one away when the turn settled wakes idle', async () => {
  const mid = await evictedMidTurn();
  const running = await claimOnConnect(mid.agent);

  expect(running).toEqual((await mid.agent.getWorkspaceSnapshot()).turnClaim);
  expect(running.kind).toBe('admitted');

  // A tab asleep through the turn's end missed the settled frame; the socket it wakes on carries the claim instead.
  const { agent } = gatewayWorkspace(answeringGateway('Done.'));
  await catalogTurn(agent, 'Say done.');

  expect(await claimOnConnect(agent)).toEqual({ kind: 'settled' });
});

test('a turn an eviction stranded is heard running again when the wake re-opens it, then settled', async () => {
  const workspace = await nextActivation((await evictedMidTurn()).db);
  const loaded = (await workspace.agent.getWorkspaceSnapshot()).turnClaim;

  if (loaded.kind !== 'stranded') throw new Error(`a tab loading now reads ${loaded.kind}, not the stranded turn`);
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.terminalRetryPass();
  await until(() => heard.at(-1)?.kind === 'settled', 'the re-opened turn to settle');

  expect(heard).toEqual([{ kind: 'admitted', turnId: loaded.turnId, claimedAt: expect.any(Number) }, { kind: 'settled' }]);
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

  expect(heard).toEqual([{ kind: 'settled' }]);
});

test('recovering a stranded turn reaches every tab, so its Recover control retires', async () => {
  const workspace = gatewayWorkspace(answeringGateway('Done.'));
  await admittedTurnClaim(workspace, 'turn-evicted');
  expect((await workspace.agent.getWorkspaceSnapshot()).turnClaim.kind).toBe('stranded');
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.recoverStrandedTurn();

  expect(heard).toEqual([{ kind: 'settled' }]);
});

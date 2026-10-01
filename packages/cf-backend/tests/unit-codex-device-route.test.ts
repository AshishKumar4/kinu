// Codex routing (docs/DEPLOYMENT.md § Codex egress) through the real registry, UserDO and device hub; the machine
// answers relay frames with a recorded chatgpt.com stream, and the container is a recording namespace.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { LanguageModel } from 'ai';
import {
  CODEX_CRED_KEY, DEVICE_CANCEL_METHOD, DEVICE_RELAY, EgressCalls, NO_DEVICE_CONNECTED,
  asFetchFunction, captureOperationProfile, operationProfileStream, requestUrl, runChat,
  type ChatEvent, type JsonValue, type OperationProfile,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { mergePolicyProfile } from '@kinu.run/test-utils';
import { createTestUserDO, testOwner, type DeviceFrame, type TestUserDO } from './helpers/user-do';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import type { CodexEgressNamespace } from '../src/egress/codex-egress-route';

/** A relay call's one parameter, as the daemon reads it. */
const RelayRequestSchema = v.object({
  method: v.string(), url: v.string(), headers: v.array(v.tuple([v.string(), v.string()])), body: v.nullable(v.string()),
});

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** An access token as the issuer mints one: a JWT whose `exp` is an hour out, so nothing renews it early. */
const accessToken = (name: string): string => [JSON.stringify({ alg: 'none' }), JSON.stringify({ sub: name, exp: Math.floor(Date.now() / 1000) + 3600 }), 'sig']
  .map((part) => Buffer.from(part).toString('base64url')).join('.');

const ACCESS_1 = accessToken('one');

const ACCESS_2 = accessToken('two');

const sse = (text: string): string => ([
  ['response.created', { type: 'response.created', response: { id: 'r', created_at: 1_700_000_000, model: 'gpt-5.5' } }],
  ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg', delta: text }],
  ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg' } }],
  ['response.completed', { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
] satisfies ReadonlyArray<readonly [string, object]>).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

/** What chatgpt.com answers a token: the recorded stream for the live one, 401 for any other. */
type Upstream = (authorization: string | null) => { status: number; body: string };

const recordedUpstream = (live: string, text: string): Upstream => (authorization) => (
  authorization === `Bearer ${live}` ? { status: 200, body: sse(text) } : { status: 401, body: '{"error":{"message":"token expired"}}' }
);

interface Rig {
  readonly harness: TestUserDO;
  readonly forwarded: Request[];
  readonly relayed: v.InferOutput<typeof RelayRequestSchema>[];
  readonly model: LanguageModel;
  /** Settles when a revocation sweep asks the machine to cancel a command; the answer waits for `answerCancel`. */
  readonly cancelAsked: Promise<void>;
  readonly answerCancel: () => void;
  /** Attach the owner's machine; `answers` says what its daemon does with a relay call. */
  readonly attachMachine: (answers: 'relay' | 'too-old', label?: string) => Promise<{ readonly deviceId: string; readonly close: () => Promise<void> }>;
}

/** `beforeRelay` runs on the machine before it answers a relayed call. */
async function rig(upstream: Upstream, beforeRelay?: (request: v.InferOutput<typeof RelayRequestSchema>) => Promise<void>): Promise<Rig> {
  const forwarded: Request[] = [];
  const relayed: Rig['relayed'] = [];
  const machines = new Map<string, 'relay' | 'too-old'>();
  const owner = await testOwner();
  const cancelAsked = Promise.withResolvers<void>();
  const cancelAnswered = Promise.withResolvers<void>();

  const harness: TestUserDO = createTestUserDO({
    deviceResponder: async (frame: DeviceFrame): Promise<JsonValue> => {
      if (frame.method === DEVICE_CANCEL_METHOD) {
        cancelAsked.resolve();
        await cancelAnswered.promise;

        return { requestId: v.parse(v.string(), frame.params[0]), cancelled: 'terminated' };
      }

      if (frame.method !== DEVICE_RELAY.method || frame.device === undefined) return { present: [] };

      if (machines.get(frame.device) === 'too-old') throw new Error(`unknown method: ${DEVICE_RELAY.method}`);
      const request = v.parse(RelayRequestSchema, frame.params[0]);
      relayed.push(request);
      await beforeRelay?.(request);
      const answer = upstream(new Headers(request.headers).get('authorization'));
      await harness.sendDeviceHello({ type: DEVICE_RELAY.head, relay: frame.id, status: answer.status, headers: [['content-type', 'text/event-stream']] }, frame.device);
      await harness.sendDeviceHello({ type: DEVICE_RELAY.body, relay: frame.id, data: Buffer.from(answer.body).toString('base64') }, frame.device);

      return { bytes: answer.body.length };
    },
  });

  await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: ACCESS_1, refreshToken: 'refresh-1' });
  const calls = new EgressCalls();

  const container: CodexEgressNamespace = {
    idFromName: (name) => ({ name, toString: () => name, equals: (other: DurableObjectId) => other.toString() === name }),
    get: () => ({
      forward: async (_owner, callId, request) => {
        forwarded.push(request);
        const answer = upstream(request.headers.get('authorization'));

        return calls.run(callId, {
          start: async () => {},
          fetch: async () => new Response(answer.body, { status: answer.status, headers: { 'content-type': 'text/event-stream' } }),
        });
      },
      cancel: async (callId) => { calls.cancel(callId); },
    }),
  };

  const registry = createAgentProviderRegistry({
    env: { CodexEgress: container }, ownerUserId: 'user-1', userDO: { stub: harness.userDO, caller: owner },
    currentTurn: (actor) => (actor.actorId === 'main' ? liveTurn : null),
  });

  return {
    harness, forwarded, relayed, model: registry.resolveModel('codex/gpt-5.5', 'kinu-test'),
    cancelAsked: cancelAsked.promise, answerCancel: () => { cancelAnswered.resolve(); },
    attachMachine: async (answers, label = 'studio') => {
      const { deviceId } = await harness.userDO.registerDevice(owner, label);
      machines.set(deviceId, answers);
      const daemon = harness.attachDaemon(deviceId);

      return { deviceId, close: () => daemon.close() };
    },
  };
}

let turnSeq = 0;

/** The actor's in-flight turn, as its session reports it: the newest turn started. */
let liveTurn: string | null = null;

function newTurn(): OperationProfile {
  turnSeq += 1;
  liveTurn = `turn-${turnSeq}`;

  return captureOperationProfile({
    actor: { actorId: 'main', workspaceId: 'workspace-a', parentActorId: null },
    profile: mergePolicyProfile(), inputs: null, runId: `run-${turnSeq}`, turnId: `turn-${turnSeq}`,
  });
}

/** One model request of `turn`, as the turn loop issues it: inside the turn's operation scope. */
async function step(model: Rig['model'], turn: OperationProfile): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const chat = runChat({ model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {} });

  for await (const event of operationProfileStream(chat, turn)) events.push(event);

  return events;
}

function finished(events: readonly ChatEvent[]) {
  const done = events.find((event) => event.type === 'step-finish');

  if (done?.type !== 'step-finish') throw new Error(`the step did not finish: ${JSON.stringify(events.filter((event) => event.type === 'error'))}`);

  return done;
}

describe('Codex egress: the owner\'s machine first, the container when none is online', () => {
  const originalFetch = globalThis.fetch;
  let refreshes: string[] = [];

  beforeEach(() => {
    refreshes = [];
    globalThis.fetch = asFetchFunction(async (input, init) => {
      if (requestUrl(input) !== CODEX_TOKEN_URL) throw new Error(`unexpected network call to ${requestUrl(input)}`);
      refreshes.push(new URLSearchParams(await new Request(input, init).text()).get('refresh_token') ?? '');

      return Response.json({ access_token: ACCESS_2, refresh_token: 'refresh-2', expires_in: 3600 });
    });
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  test('a turn goes out from the online machine with the login\'s access token, and the container is not asked', async () => {
    const { harness, forwarded, relayed, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'from the machine'));
    const machine = await attachMachine('relay');

    const done = finished(await step(model, newTurn()));

    expect(done.text).toBe('from the machine');
    expect(done.egress).toBe(`device ${machine.deviceId}`);
    expect(relayed.map((request) => [request.method, request.url])).toEqual([['POST', 'https://chatgpt.com/backend-api/codex/responses']]);
    expect(new Headers(relayed[0]?.headers).get('authorization')).toBe(`Bearer ${ACCESS_1}`);
    expect(forwarded).toHaveLength(0);
    // The machine is handed the access token for the one call, never the refresh token.
    expect(JSON.stringify(harness.deviceFrames)).not.toContain('refresh-1');
    await harness.joinFibers();
    harness.close();
  });

  test('with no machine online the turn goes through the container, and says so', async () => {
    const { harness, forwarded, relayed, model } = await rig(recordedUpstream(ACCESS_1, 'from the relay'));

    const done = finished(await step(model, newTurn()));

    expect(done.text).toBe('from the relay');
    expect(done.egress).toBe('relay');
    expect(forwarded).toHaveLength(1);
    expect(relayed).toHaveLength(0);
    harness.close();
  });

  test('a machine whose daemon is too old to relay sends the turn to the container, and is not asked again', async () => {
    const { harness, forwarded, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    await attachMachine('too-old');

    expect(finished(await step(model, newTurn())).egress).toBe('relay');
    expect(finished(await step(model, newTurn())).egress).toBe('relay');
    expect(forwarded).toHaveLength(2);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_RELAY.method)).toHaveLength(1);
    await harness.joinFibers();
    harness.close();
  });

  test('a machine lost mid-turn fails that step by name and never switches the turn to the container', async () => {
    const { harness, forwarded, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const machine = await attachMachine('relay');
    const turn = newTurn();

    expect(finished(await step(model, turn)).egress).toBe(`device ${machine.deviceId}`);
    await harness.joinFibers();
    await machine.close();

    let told = 'the step finished';

    try {
      await step(model, turn);
    } catch (cause) {
      told = renderThrownChain({ cause });
    }

    expect(told).toContain('studio went offline during this turn, and Codex keeps one route per turn');
    expect(forwarded).toHaveLength(0);
    // The next turn picks again.
    expect(finished(await step(model, newTurn())).egress).toBe('relay');
    harness.close();
  });

  test('a turn that started on the container stays there when a machine comes online', async () => {
    const { harness, relayed, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const turn = newTurn();

    expect(finished(await step(model, turn)).egress).toBe('relay');
    const machine = await attachMachine('relay');
    expect(finished(await step(model, turn)).egress).toBe('relay');
    expect(relayed).toHaveLength(0);
    expect(finished(await step(model, newTurn())).egress).toBe(`device ${machine.deviceId}`);
    await harness.joinFibers();
    harness.close();
  });

  test('two turns meeting an expired token through the machine refresh the login once', async () => {
    const { harness, relayed, model, attachMachine } = await rig(recordedUpstream(ACCESS_2, 'fresh'));
    await attachMachine('relay');

    const [first, second] = await Promise.all([step(model, newTurn()), step(model, newTurn())]);

    expect(finished(first).text).toBe('fresh');
    expect(finished(second).text).toBe('fresh');
    expect(refreshes).toEqual(['refresh-1']);
    const sent = relayed.map((request) => new Headers(request.headers).get('authorization'));
    // Each turn tried the old token once and was resent once with the rotated one.
    expect({ old: sent.filter((token) => token === `Bearer ${ACCESS_1}`).length, rotated: sent.filter((token) => token === `Bearer ${ACCESS_2}`).length })
      .toEqual({ old: 2, rotated: 2 });
    expect(JSON.stringify(harness.deviceFrames)).not.toMatch(/refresh-[12]/);
    await harness.joinFibers();
    harness.close();
  });

  test('a turn refused on a token another turn already rotated takes the rotated one, and nothing refreshes twice', async () => {
    const otherDone = Promise.withResolvers<void>();
    let oldTokenCalls = 0;

    // The second call to carry the old token is the other turn's first; it is answered only once the turn not held
    // has rotated the token and finished, as a loaded machine can: its 401 then names a token the login no longer holds.
    // A retry carries the rotated token, so it is never the call held, whatever order the machine sees them in.
    const { harness, model, attachMachine } = await rig(recordedUpstream(ACCESS_2, 'fresh'), async (request) => {
      if (new Headers(request.headers).get('authorization') !== `Bearer ${ACCESS_1}`) return;
      oldTokenCalls += 1;

      if (oldTokenCalls === 2) await otherDone.promise;
    });

    await attachMachine('relay');

    // Only the turn not held can finish first, and its end releases the other.
    const released = (turn: Promise<ChatEvent[]>) => turn.finally(() => { otherDone.resolve(); });
    const [first, second] = await Promise.all([released(step(model, newTurn())), released(step(model, newTurn()))]);

    expect([finished(first).text, finished(second).text]).toEqual(['fresh', 'fresh']);
    expect(refreshes).toEqual(['refresh-1']);
    await harness.joinFibers();
    harness.close();
  });

  test('every model call of one turn keeps its route, whichever scope (tool, profile lane) issues it', async () => {
    const { harness, relayed, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const turn = newTurn();

    expect(finished(await step(model, turn)).egress).toBe('relay');
    await attachMachine('relay');
    const sameTurn = captureOperationProfile({ actor: turn.actor, profile: turn.profile, inputs: null, runId: turn.runId, turnId: turn.turnId });

    expect(finished(await step(model, sameTurn)).egress).toBe('relay');
    expect(relayed).toHaveLength(0);
    await harness.joinFibers();
    harness.close();
  });

  test('a machine named with any characters still serves the turn, and the step names which machine', async () => {
    const label = 'Ashish’s 💻\nstudio';
    const { harness, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'from the machine'));
    const machine = await attachMachine('relay', label);

    const done = finished(await step(model, newTurn()));

    expect(done.text).toBe('from the machine');
    // The record names the machine by id; its label is read where it is shown, so a rename never rewrites history.
    expect(done.egress).toBe(`device ${machine.deviceId}`);
    await harness.joinFibers();
    harness.close();
  });

  test('a machine revoked while the request body is still being read is not handed the token', async () => {
    const { harness, relayed, cancelAsked, answerCancel, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const owner = await testOwner();
    const machine = await attachMachine('relay');
    // A command still running on the machine, so the revocation sweep waits on its cancellation with the socket open.
    harness.db.prepare('INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id) VALUES (?, ?, ?, ?)')
      .run('rpc-held-1', machine.deviceId, 'workspace-a', 'turn-1');
    const body = Promise.withResolvers<void>();

    const held = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await body.promise;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    });

    const relaying = harness.userDO.relayModelCall(owner, machine.deviceId, 'call-revoked', new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', body: held, headers: { authorization: `Bearer ${ACCESS_1}` },
    }));

    const revocation = harness.userDO.revokeDevice(owner, machine.deviceId);
    await cancelAsked;
    body.resolve();

    await expect(relaying).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(relayed).toHaveLength(0);
    answerCancel();
    await revocation;
    await harness.joinFibers();
    harness.close();
  });

  test('a background call from an earlier turn never moves the live turn off its route', async () => {
    const { harness, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const earlier = newTurn();
    const live = newTurn();

    expect(finished(await step(model, earlier)).egress).toBe('relay');
    expect(finished(await step(model, live)).egress).toBe('relay');
    const machine = await attachMachine('relay');

    // The earlier turn's job is no longer inside a turn, so it may pick afresh.
    expect(finished(await step(model, earlier)).egress).toBe(`device ${machine.deviceId}`);
    expect(finished(await step(model, live)).egress).toBe('relay');
    await harness.joinFibers();
    harness.close();
  });

  test('jobs from two earlier turns, interleaved with the live one, never move it', async () => {
    const { harness, model, attachMachine } = await rig(recordedUpstream(ACCESS_1, 'ok'));
    const first = newTurn();
    const second = newTurn();
    const live = newTurn();

    expect(finished(await step(model, first)).egress).toBe('relay');
    expect(finished(await step(model, live)).egress).toBe('relay');
    expect(finished(await step(model, second)).egress).toBe('relay');
    const machine = await attachMachine('relay');

    expect(finished(await step(model, second)).egress).toBe(`device ${machine.deviceId}`);
    expect(finished(await step(model, live)).egress).toBe('relay');
    expect(finished(await step(model, first)).egress).toBe(`device ${machine.deviceId}`);
    expect(finished(await step(model, live)).egress).toBe('relay');
    // The next turn picks afresh.
    expect(finished(await step(model, newTurn())).egress).toBe(`device ${machine.deviceId}`);
    await harness.joinFibers();
    harness.close();
  });
});

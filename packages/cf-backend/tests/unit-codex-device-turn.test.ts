// A Codex turn on the real hosted root: the route pin reads the actor's live turn through the production seam
// (the root's ActorSession), and a profile-lane call made inside that turn (judge, fast, advisor) follows it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { CODEX_CRED_KEY, DEVICE_RELAY, EgressCalls, asFetchFunction, requestUrl, type JsonValue } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner, type DeviceFrame, type TestUserDO } from './helpers/user-do';
import { catalogTurn, makeEnv, orchestratorHarness, sideLane } from './helpers/actor-harness';
import type { CodexEgressNamespace } from '../src/egress/codex-egress-route';

const OWNER_USER_ID = 'fedcba9876543210fedcba9876543210';

const WORKSPACE = 'codex-turn';

const CODEX_MODEL = 'codex/gpt-5.5';

const ACCESS = [JSON.stringify({ alg: 'none' }), JSON.stringify({ sub: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 }), 'sig']
  .map((part) => Buffer.from(part).toString('base64url')).join('.');

const BodySchema = v.object({ stream: v.optional(v.boolean()) });

/** chatgpt.com's answer: the recorded stream to a streamed request, the JSON response to any other. */
function answer(body: string, text: string): Response {
  if (v.parse(BodySchema, JSON.parse(body)).stream === true) {
    const events = ([
      ['response.created', { type: 'response.created', response: { id: 'r', created_at: 1_700_000_000, model: 'gpt-5.5' } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg', delta: text }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg' } }],
      ['response.completed', { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
    ] satisfies ReadonlyArray<readonly [string, object]>).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

    return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
  }

  return Response.json({
    id: 'r', created_at: 1_700_000_000, model: 'gpt-5.5', incomplete_details: null, usage: { input_tokens: 5, output_tokens: 1 },
    output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = asFetchFunction(async (input) => { throw new Error(`unexpected network call to ${requestUrl(input)}`); });
});

afterEach(() => { globalThis.fetch = originalFetch; });

interface CodexWorkspace {
  readonly user: TestUserDO;
  readonly actor: ReturnType<typeof orchestratorHarness>;
  readonly relayed: string[];
  readonly forwarded: string[];
  readonly connectMachine: (label: string) => Promise<string>;
}

/** A hosted root routing every tier to Codex; `duringFirstCall` runs inside the first turn's first chatgpt.com call. */
async function codexWorkspace(duringFirstCall: (workspace: CodexWorkspace) => Promise<void> = async () => {}): Promise<CodexWorkspace> {
  const relayed: string[] = [];
  const forwarded: string[] = [];
  let user: TestUserDO | null = null;

  user = createTestUserDO({
    durableObjectId: OWNER_USER_ID,
    deviceResponder: async (frame: DeviceFrame): Promise<JsonValue> => {
      if (frame.method !== DEVICE_RELAY.method || frame.device === undefined || user === null) return { present: [] };
      const request = v.parse(v.object({ url: v.string(), body: v.nullable(v.string()) }), frame.params[0]);
      relayed.push(request.url);
      const reply = answer(request.body ?? '{}', 'from the machine');
      await user.sendDeviceHello({ type: DEVICE_RELAY.head, relay: frame.id, status: reply.status, headers: [...reply.headers] }, frame.device);
      await user.sendDeviceHello({ type: DEVICE_RELAY.body, relay: frame.id, data: Buffer.from(await reply.text()).toString('base64') }, frame.device);

      return { bytes: 0 };
    },
  });

  const opened = user;
  const owner = await testOwner();
  await opened.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: ACCESS, refreshToken: 'refresh-never-used' });
  const token = await provisionTestWorkspace(opened, WORKSPACE, 'Codex turn');
  const world = { userDO: opened.userDO, workspace: WORKSPACE, ownerUserId: OWNER_USER_ID };
  const calls = new EgressCalls();

  const connectMachine = async (label: string): Promise<string> => {
    const { deviceId } = await opened.userDO.registerDevice(owner, label);
    opened.attachDaemon(deviceId);

    return deviceId;
  };

  let workspace: CodexWorkspace | null = null;

  const container: CodexEgressNamespace = {
    idFromName: (name) => ({ name, toString: () => name, equals: (other: DurableObjectId) => other.toString() === name }),
    get: () => ({
      forward: async (_owner, callId, request) => {
        if (request.method === 'GET') return Response.json({ models: [] });
        forwarded.push(request.url);
        const body = await request.text();

        if (forwarded.length === 1 && workspace !== null) await duringFirstCall(workspace);

        return calls.run(callId, { start: async () => {}, fetch: async () => answer(body, 'from the relay') });
      },
      cancel: async (callId) => { calls.cancel(callId); },
    }),
  };

  const actor = orchestratorHarness(undefined, world, Object.assign(makeEnv(undefined, undefined, world), { CodexEgress: container }));
  actor.agent.harnessHoldsCapability(token);
  actor.agent.harnessInstallCatalog({ tiers: { default: { model: CODEX_MODEL }, deep: { model: CODEX_MODEL }, fast: { model: CODEX_MODEL } }, availableModels: [CODEX_MODEL] });
  workspace = { user: opened, actor, relayed, forwarded, connectMachine };

  return workspace;
}

test('a machine that connects during a Codex turn waits for the next turn, and the turn\'s own side calls stay with it', async () => {
  let sideAnswer = '';

  const { user, actor, relayed, forwarded } = await codexWorkspace(async ({ actor: during, connectMachine }) => {
    await connectMachine('studio');
    sideAnswer = await sideLane(during.agent).complete('judge this');
  });

  await catalogTurn(actor.agent, 'say hello');

  expect(sideAnswer).toBe('from the relay');
  expect(forwarded).toHaveLength(2);
  expect(relayed).toEqual([]);

  await catalogTurn(actor.agent, 'again');
  // The next turn goes out from the machine.
  expect(relayed.filter((url) => url.endsWith('/codex/responses'))).toHaveLength(1);
  await user.joinFibers();
  user.close();
});

test('the Activity tab names the route of the newest Codex step: the machine by its current name, or the container', async () => {
  const { user, actor, connectMachine } = await codexWorkspace();

  await catalogTurn(actor.agent, 'say hello');
  expect((await actor.agent.getActivitySnapshot()).latest).toMatchObject({ modelId: 'gpt-5.5', route: { kind: 'container' } });

  const deviceId = await connectMachine('studio');
  await catalogTurn(actor.agent, 'again');
  expect((await actor.agent.getActivitySnapshot()).latest).toMatchObject({ modelId: 'gpt-5.5', route: { kind: 'device', id: deviceId, name: 'studio' } });

  // Read at snapshot time, and asking no machine: a slow one cannot hold the tab up.
  await user.userDO.renameDevice(await testOwner(), deviceId, 'desk');
  await connectMachine('laptop');
  const asked = user.deviceFrames.length;
  expect((await actor.agent.getActivitySnapshot()).latest?.route).toEqual({ kind: 'device', id: deviceId, name: 'desk' });
  expect(user.deviceFrames.slice(asked).map((frame) => frame.method)).toEqual([]);
  await user.joinFibers();
  user.close();
});

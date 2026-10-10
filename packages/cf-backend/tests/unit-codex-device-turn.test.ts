// A Codex turn on the real hosted root: the owner's connected machine carries it, the route pin reads the actor's live
// turn through the production seam (the root's ActorSession), and with no machine the turn is refused in so many words.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import { CODEX_CRED_KEY, DEVICE_RELAY, asFetchFunction, requestUrl, type JsonValue } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner, type DeviceFrame, type TestUserDO } from './helpers/user-do';
import {
  agentSql, catalogTurn, driveUntil, hostedSubordinateHarness, makeEnv, orchestratorHarness, wakeForDelegatedTask, mainDatabase } from './helpers/actor-harness';

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
  readonly connectMachine: (label: string) => Promise<string>;
}

/** A hosted root routing every tier to Codex. */
async function codexWorkspace(): Promise<CodexWorkspace> {
  const relayed: string[] = [];
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

  const connectMachine = async (label: string): Promise<string> => {
    const { deviceId } = await opened.userDO.registerDevice(owner, label);
    opened.attachDaemon(deviceId);

    return deviceId;
  };

  const actor = orchestratorHarness(undefined, world, makeEnv(undefined, undefined, world));
  actor.agent.harnessHoldsCapability(token);
  actor.agent.harnessInstallCatalog({ tiers: { default: { model: CODEX_MODEL }, deep: { model: CODEX_MODEL }, fast: { model: CODEX_MODEL } }, availableModels: [CODEX_MODEL] });

  return { user: opened, actor, relayed, connectMachine };
}

/** Why each of the root's turns ended, oldest first. */
function turnErrors(actor: CodexWorkspace['actor']): string[] {
  return mainDatabase(actor).query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'run_end' ORDER BY rowid").all()
    .map((row) => v.parse(v.object({ error: v.optional(v.string()) }), JSON.parse(row.payload)).error ?? '');
}

test('a Codex turn with no machine connected is refused in so many words, and the next turn goes out from one', async () => {
  const { user, actor, relayed, connectMachine } = await codexWorkspace();

  await catalogTurn(actor.agent, 'say hello');

  expect(turnErrors(actor).at(-1)).toContain('Codex calls from kinu.run go through your connected machine; connect one, or pick ChatGPT (Sign in with ChatGPT)');
  expect(relayed).toEqual([]);

  await connectMachine('studio');
  await catalogTurn(actor.agent, 'again');
  expect(relayed.filter((url) => url.endsWith('/codex/responses')).length).toBeGreaterThan(0);
  expect(turnErrors(actor).at(-1)).toBe('');
  await user.joinFibers();
  user.close();
});

test('the Activity tab names the machine of the newest Codex step by its current name', async () => {
  const { user, actor, connectMachine } = await codexWorkspace();

  const deviceId = await connectMachine('studio');
  await catalogTurn(actor.agent, 'say hello');
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

test("a hired agent's Codex call from its own isolate goes out through the owner's machine", async () => {
  const { user, actor, relayed, connectMachine } = await codexWorkspace();
  await connectMachine('studio');
  const hire = await hostedSubordinateHarness(actor, { name: 'coder', displayName: 'Coder', nameOrigin: 'user', mission: 'code' });
  const hireId = hire.actor.handle.actorId;

  const ended = (): string[] => agentSql(actor, hireId)<{ payload: string }>`
    SELECT payload FROM run_events WHERE actor_id = ${hireId} AND type = 'run_end'`.map((row) => row.payload);

  await wakeForDelegatedTask(actor, hireId, 'Write the thing.');
  await driveUntil(actor, "the hire's turn never ended", () => ended().length > 0);

  expect(relayed.filter((url) => url.endsWith('/codex/responses'))).toHaveLength(1);
  expect(ended().join('')).not.toContain('unexpected network call');
  await user.joinFibers();
  user.close();
});

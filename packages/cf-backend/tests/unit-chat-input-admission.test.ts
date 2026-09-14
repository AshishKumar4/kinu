import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { ModelMessage, UIMessage } from 'ai';
import { ActorClaimStore, JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { makeSql, SDK_SESSION_DDL } from '../../core/tests/helpers';
import { bindChatInput } from '../src/chat-intake';
import { orchestratorHarness, reactivateOrchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const GENESIS = { role: 'user', content: 'Read your standing brief and ask what to do first.' } satisfies ModelMessage;

const GENESIS_REPLY = { role: 'assistant', content: 'What should I do first?' } satisfies ModelMessage;

const Envelope = v.pipe(v.string(), v.parseJson(), v.object({ init: v.object({
  body: v.pipe(v.string(), v.parseJson(), v.looseObject({ kinuRequestId: v.optional(v.string()) })),
}) }));

type Harness = ActorHarness<HarnessOrchestratorAgent>;

function claims(harness: Harness): ActorClaimStore {
  return new ActorClaimStore(makeSql(harness.db), harness.agent.observeRuntime().actor, (write) => write());
}

function capturedInput(harness: Harness, id: string, text: string) {
  const message: UIMessage = { id, role: 'user', parts: [{ type: 'text', text }] };

  const wire = JSON.stringify({ type: 'cf_agent_use_chat_request', id: `wire-${id}`, init: {
    method: 'POST', body: JSON.stringify({ messages: [message], trigger: 'submit-message', kinuRequestId: 'forged' }),
  } });

  const bound = bindChatInput(wire, claims(harness),
    (key) => harness.db.prepare('SELECT id FROM assistant_messages WHERE id = ?').get(key) !== null);

  const body = v.parse(JsonObjectSchema, v.parse(Envelope, bound).init.body);

  return {
    body,
    persist() {
      harness.db.run('INSERT INTO assistant_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
        [id, '', 'user', JSON.stringify(message)]);
    },
  };
}

function config(messages: ModelMessage[], body: JsonObject = {}, continuation = false) {
  return { system: 'sys', messages, tools: {}, model: 'harness-model', continuation, body };
}

function texts(messages: readonly ModelMessage[] = []): string[] {
  return messages.map((message) => Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    : message.content);
}

async function settle(harness: Harness, id: string, text: string): Promise<void> {
  await harness.agent.onChatResponse({
    message: { id, role: 'assistant', parts: [{ type: 'text', text }] },
    requestId: `response-${id}`, continuation: false, status: 'completed',
  });
}

async function opening(): Promise<Harness> {
  const harness = orchestratorHarness();
  harness.db.run(SDK_SESSION_DDL);
  harness.agent.harnessAdmitChat();
  await harness.agent.beforeTurn(config([GENESIS]));

  return harness;
}

describe('request-owned chat inputs', () => {
  // Ordering of two socket-queued asks and a programmatic turn's exclusion of a
  // still-pending chat token are proven end to end through the real socket in
  // tests/workerd/two-turn.test.ts: 'admits two websocket asks after held
  // genesis through the installed Think queue' and 'a durable programmatic
  // submission excludes a later pending chat from its provider prefix'.
  test('alarm recovery leaves the live Think root claim with its foreground owner', async () => {
    const harness = await opening();
    const turn = claims(harness).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    expect(await harness.agent.hasSandboxBackgroundWork()).toBe(true);
    const host = harness.agent.observeActorHost();
    const acquire = host.acquire.bind(host);
    let acquired = 0;
    host.acquire = async (reference) => {
      acquired += 1;

      return acquire(reference);
    };

    await harness.agent._kinuTerminalRetryTick();
    expect(acquired).toBeGreaterThan(0);
    expect(claims(harness).read(turn.turnId)?.status).toBe('admitted');
    await settle(harness, 'answer', 'complete answer');
  });

  test('the foreground owner stays live while its response is being converted for settlement', async () => {
    const harness = await opening();
    const ending = settle(harness, 'answer', 'complete answer');
    const claimed = claims(harness).latestTurn()?.status;
    const busy = harness.agent.hasSandboxBackgroundWork();
    await ending;

    expect(claimed).toBe('admitted');
    expect(await busy).toBe(true);
    expect(claims(harness).latestTurn()?.status).toBe('settled');
  });

  test('alarm recovery still classifies a genuinely idle unverified root claim', async () => {
    const warm = await opening();
    const turn = claims(warm).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    const cold = await reactivateOrchestratorHarness(warm.db);
    await cold.agent._kinuTerminalRetryTick();
    expect(claims(cold).read(turn.turnId)).toMatchObject({ status: 'settled', outcome: 'indeterminate' });
  });

  test.each([
    ['every-tool', 'List every tool you can call right now, one per line, names only, nothing else.'],
    ['slate', 'Create the hello slate and start its preview.'],
    ['codemode-craft', 'Build a digit-sum tool, use it on 4827516390 and reply with the result.'],
  ])('%s opens after the genesis answer, not before it', async (name, ask) => {
    const harness = await opening();
    const input = capturedInput(harness, name, ask);
    input.persist();
    await settle(harness, 'genesis-answer', 'What should I do first?');
    const prepared = await harness.agent.beforeTurn(config([GENESIS, { role: 'user', content: ask }, GENESIS_REPLY], input.body));
    expect(texts(prepared?.messages)).toEqual([GENESIS.content, GENESIS_REPLY.content, ask]);
    expect(claims(harness).latestTurn()?.turnId).toBe(name);
  });


  test('interleaved persistence cannot attach an intake to another request', async () => {
    const harness = await opening();
    const a = capturedInput(harness, 'ask-a', 'ask A');
    const b = capturedInput(harness, 'ask-b', 'ask B');
    // A's asynchronous persistence is held while B finishes and takes a slot.
    b.persist();
    await settle(harness, 'genesis-answer', 'What should I do first?');
    const first = await harness.agent.beforeTurn(config([GENESIS, { role: 'user', content: 'ask B' }, GENESIS_REPLY], b.body));
    expect(texts(first?.messages).at(-1)).toBe('ask B');
    a.persist();
    await settle(harness, 'answer-b', 'answer B');
    const second = await harness.agent.beforeTurn(config([GENESIS, { role: 'user', content: 'ask A' }, GENESIS_REPLY], a.body));
    expect(texts(second?.messages)).toEqual([GENESIS.content, GENESIS_REPLY.content, 'ask B', 'answer B', 'ask A']);
  });

  test('input binding reserves each frame before asynchronous persistence interleaves', async () => {
    const harness = await opening();
    const delayed = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const seen: JsonObject[] = [];

    const receive = async (wire: string) => {
      const bound = bindChatInput(wire, claims(harness), () => false);
      const parsed = v.parse(Envelope, bound);
      const body = v.parse(JsonObjectSchema, parsed.init.body);
      seen.push(body);

      if (seen.length === 1) {
        entered.resolve();
        await delayed.promise;
      }
    };

    const wire = (id: string) => JSON.stringify({ type: 'cf_agent_use_chat_request', id, init: {
      method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text: id }] }] }),
    } });

    const a = receive(wire('a'));

    await entered.promise;
    await receive(wire('b'));
    expect(seen).toHaveLength(2);
    expect(claims(harness).input(String(seen[0]?.kinuRequestId))).toEqual(['a']);
    expect(claims(harness).input(String(seen[1]?.kinuRequestId))).toEqual(['b']);
    delayed.resolve();
    await a;
  });

  test('full browser history cannot reserve old or already pending inputs again', async () => {
    const harness = await opening();
    const old = capturedInput(harness, 'old', 'old');
    old.persist();
    const pending = capturedInput(harness, 'pending', 'same text');

    const wire = JSON.stringify({ type: 'cf_agent_use_chat_request', id: 'new', init: { method: 'POST', body: JSON.stringify({
      messages: [
        { id: 'old', role: 'user', parts: [] },
        { id: 'pending', role: 'user', parts: [{ type: 'text', text: 'same text' }] },
        { id: 'new', role: 'user', parts: [{ type: 'text', text: 'same text' }] },
      ],
    }) } });

    const bound = bindChatInput(wire, claims(harness), (id) => id === 'old');
    const body = v.parse(Envelope, bound).init.body;
    expect(claims(harness).input(String(body.kinuRequestId))).toEqual(['new']);
    expect(claims(harness).input(String(pending.body.kinuRequestId))).toEqual(['pending']);
  });

  test('continuation leaves pending inputs alone and stale customBody cannot replay a settled input', async () => {
    const harness = await opening();
    const a = capturedInput(harness, 'ask-a', 'ask A');
    a.persist();
    await settle(harness, 'genesis-answer', 'What should I do first?');
    const continuation = await harness.agent.beforeTurn(config([GENESIS, GENESIS_REPLY], a.body, true));
    expect(texts(continuation?.messages)).toEqual([GENESIS.content, GENESIS_REPLY.content]);
    expect(claims(harness).input(String(a.body.kinuRequestId))).toEqual(['ask-a']);
    await settle(harness, 'continuation-answer', 'continued');
    await harness.agent.beforeTurn(config([GENESIS, { role: 'user', content: 'ask A' }], a.body));
    await settle(harness, 'answer-a', 'answer A');
    expect(claims(harness).input(String(a.body.kinuRequestId))).toBeNull();
    expect(a.body.kinuRequestId).not.toBe('forged');
  });
});

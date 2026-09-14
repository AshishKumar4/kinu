import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { ModelMessage, UIMessage } from 'ai';
import { ActorClaimStore, JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { makeSql, SDK_SESSION_DDL } from '../../core/tests/helpers';
import { bindChatInput } from '../src/chat-intake';
import { orchestratorHarness, reactivateOrchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const GENESIS = { role: 'user', content: 'Read your standing brief and ask what to do first.' } satisfies ModelMessage;

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

async function settle(harness: Harness, id: string, text: string): Promise<void> {
  await harness.agent.onChatResponse({
    message: { id, role: 'assistant', parts: [{ type: 'text', text }] },
    requestId: `response-${id}`, continuation: false, status: 'completed',
  });
}

async function opening(): Promise<Harness> {
  const harness = orchestratorHarness();
  harness.db.run(SDK_SESSION_DDL);
  await harness.agent.beforeTurn(config([GENESIS]));

  return harness;
}

describe('request-owned chat inputs', () => {
  // The socket-admission properties the harness once simulated are now proven
  // end to end over a real socket and the installed Think queue in
  // tests/workerd/two-turn.test.ts: 'admits two websocket asks after held
  // genesis through the installed Think queue' (queued ordering + per-request
  // binding), 'a durable programmatic submission excludes a later pending chat
  // from its provider prefix' (a programmatic turn cannot consume pending B),
  // and 'keeps a queued chat on its durable token through a cold reset and
  // replay' (durable token identity, continuation never consumes pending, and a
  // settled token is not replayed). The cases kept here exercise the
  // synchronous bindChatInput read and the alarm/conversion lifecycle directly.
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
  test('input binding reserves each frame before asynchronous persistence interleaves', async () => {
    const harness = orchestratorHarness();
    harness.db.run(SDK_SESSION_DDL);
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
    const harness = orchestratorHarness();
    harness.db.run(SDK_SESSION_DDL);
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
});

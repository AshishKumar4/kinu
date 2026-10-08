/**
 * The dynamic-context block across an object restart, through the production chat gate: while the provider's
 * prompt cache is warm, the stored block keeps its position and the request's prefix stays byte-identical; once
 * the cache has expired, the stored blocks go and the state is stated exactly once, before the new input.
 * The owner's ask, 2026-09-25 (DYNCTX-RESTART-0925): nothing guarded this, and a cache miss is paid on every turn.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { DYNAMIC_CONTEXT_OPEN_TAG } from '@kinu.run/core';
import {
  orchestratorHarness, reactivateOrchestratorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';

type Prompt = LanguageModelV4CallOptions['prompt'];

const MINUTE_MS = 60_000;

/** A clock far from a day's end: the block states the date, so a turn either side of midnight states a new one. */
const NOON = Date.parse('2026-10-07T12:00:00.000Z');

function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }], trigger: 'submit-message',
    }) },
  });
}

/** One root turn through the chat gate; returns the request its model received. */
async function turn(agent: HarnessOrchestratorAgent, id: string, text: string): Promise<Prompt> {
  const received: Prompt[] = [];

  agent.harnessSupplyTurnModel(scriptedTurnModel({ doGenerate: (options) => {
    received.push(options.prompt);

    return {
      content: [{ type: 'text', text: `answer ${id}` }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
  } }));

  const settled = Promise.withResolvers<void>();
  const fanout = agent.broadcast.bind(agent);

  // The request closes at turn end; its done frame is the signal.
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (message.includes(`"id":"${id}"`) && message.includes('"done":true')) settled.resolve();
      fanout(message, exclude);
    },
  });

  await agent.harnessChatGate()(socketConnection({ id: `conn-${id}`, send: () => {} }), chatRequest(id, text));
  await settled.promise;
  const request = received.at(-1);

  if (request === undefined) throw new Error(`turn ${id} never called its model`);

  return request;
}

function messageText(message: Prompt[number]): string {
  return v.is(v.string(), message.content)
    ? message.content
    : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

/** Each message as its role, or `dynamic` for a state block. */
function messageOrder(prompt: Prompt): string[] {
  return prompt.map((message) => messageText(message).startsWith(DYNAMIC_CONTEXT_OPEN_TAG) ? 'dynamic' : `${message.role}:${messageText(message)}`);
}

/** Two turns, the object reactivated over the same storage in between, `gapMs` of clock apart from `start`. */
async function acrossRestart(gapMs: number, start = NOON): Promise<{ readonly before: Prompt; readonly after: Prompt }> {
  setSystemTime(new Date(start));
  const first = orchestratorHarness();
  await first.agent.activateActor();
  const before = await turn(first.agent, 'first', 'hello one');

  const next = await reactivateOrchestratorHarness(first.db);
  await next.agent.activateActor();
  setSystemTime(new Date(start + gapMs));

  return { before, after: await turn(next.agent, 'second', 'hello two') };
}

describe('the dynamic context across an object restart', () => {
  afterEach(() => { setSystemTime(); });

  test('with the prompt cache warm, the block keeps its position and the prefix stays byte-identical', async () => {
    const { before, after } = await acrossRestart(MINUTE_MS);

    expect(messageOrder(before)).toEqual([expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one']);
    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one', 'assistant:answer first', 'user:hello two',
    ]);
    // As bytes: `toEqual` ignores key order and undefined fields, which the wire does not.
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  });

  // 2026-10-08, armada runs straddling 00:00 UTC: the second turn stated the new date, which the case above read as a
  // change it could not explain.
  test('a turn after midnight states the new date in a block of its own, the prefix still byte-identical', async () => {
    const { before, after } = await acrossRestart(MINUTE_MS, Date.parse('2026-10-07T23:59:59.000Z'));

    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'dynamic', 'user:hello one', 'assistant:answer first', 'dynamic', 'user:hello two',
    ]);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after.flatMap((message) => messageText(message).match(/Current date: \S+/u) ?? []))
      .toEqual(['Current date: 2026-10-07', 'Current date: 2026-10-08']);
  });

  test('with the prompt cache expired, the stored blocks go and the state is stated once, before the new input', async () => {
    const { after } = await acrossRestart(3 * 60 * MINUTE_MS);

    expect(messageOrder(after)).toEqual([
      expect.stringMatching(/^system:/u), 'user:hello one', 'assistant:answer first', 'dynamic', 'user:hello two',
    ]);
  });
});

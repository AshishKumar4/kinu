/**
 * A fixed-tier call (fact compression, titling, reflection) walks the chain the profile configured, as a turn does,
 * and a tier refusing for a reason only the owner can fix is said once, naming the tier and the model.
 * Found on prod 2026-09-29 (ironwood-cairn-6dbcb8de): the fast tier answered 402 to every background call for
 * 11.5 hours; the owner saw nothing, and a configured chain would not have been tried.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { createTestActors } from '@kinu.run/test-utils';
import { completeOnRoute } from '../src/profiles/model-lane';
import { tierRefusals } from '../src/profiles/tier-refusals';
import type { ModelRouteResolution } from '../src/profiles/model-route';
import { initActorDdl } from '../src/identity/schema';
import { readActivityLog } from '../src/identity/activity-log';
import type { LLM } from '../src/types/primitives';
import { makeExecRaw, makeSql } from './helpers';

const NO_FUNDS = JSON.stringify({ error: { message: 'Upstream request failed: Insufficient account funds', type: 'server_error' } });

/** Each model answers from `answers`; a missing entry answers 200. */
function gateway(answers: ReadonlyMap<string, number>, calls: string[]) {
  return (resolution: ModelRouteResolution): LLM => ({
    async *stream() { yield ''; },
    async complete(prompt) {
      calls.push(resolution.model);

      const status = answers.get(resolution.model) ?? 200;

      const provider = createOpenAICompatible({
        name: 'gateway', baseURL: 'https://gateway.example.test/v1',
        fetch: Object.assign(async () => status === 200
          ? Response.json({ id: 'r', object: 'chat.completion', created: 0, model: resolution.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `answered by ${resolution.model}` } }] })
          : new Response(NO_FUNDS, { status, headers: { 'content-type': 'application/json' } }),
        { preconnect: async (): Promise<void> => {} }),
      });

      return (await generateText({ model: provider(resolution.model), prompt, maxRetries: 0 })).text;
    },
  });
}

function route(model: string, fallbacks: readonly string[] = []): ModelRouteResolution {
  return { source: 'fast', tier: 'fast', model, reasoningEffort: null, fallbacks: fallbacks.map((spec) => ({ model: spec, reasoningEffort: null })) };
}

function notices() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;

  initActorDdl(execRaw);

  return {
    refusals: tierRefusals({ sql, actor, config: actor.config, now: () => 1, settings: 'Settings → Models' }),
    said: () => readActivityLog(sql, actor, 10).filter((row) => row.event === 'model_tier_refused').map((row) => row.detail),
  };
}

test('a 402 on the tier model hands the call to its configured fallback, as a turn does', async () => {
  const calls: string[] = [];
  const { refusals, said } = notices();

  const text = await completeOnRoute(route('gateway/chain-one', ['gateway/chain-two']), {
    llm: gateway(new Map([['gateway/chain-one', 402]]), calls), refusals,
  }, 'compress the facts');

  expect(text).toBe('answered by gateway/chain-two');
  expect(calls).toEqual(['gateway/chain-one', 'gateway/chain-two']);
  expect(said()).toEqual([]);
});

test('with no chain configured, a refusal is not re-routed', async () => {
  const calls: string[] = [];

  await expect(completeOnRoute(route('gateway/alone'), { llm: gateway(new Map([['gateway/alone', 402]]), calls) }, 'title this')).rejects.toThrow();
  expect(calls).toEqual(['gateway/alone']);
});

test('a tier the owner must fix is said once, naming the tier and the model, until it answers again', async () => {
  const calls: string[] = [];
  const { refusals, said } = notices();
  const answers = new Map([['gateway/unfunded', 402]]);
  const lane = { llm: gateway(answers, calls), refusals };

  await expect(completeOnRoute(route('gateway/unfunded'), lane, 'one')).rejects.toThrow();
  await expect(completeOnRoute(route('gateway/unfunded'), lane, 'two')).rejects.toThrow();

  expect(said()).toEqual([
    'Your fast tier, gateway/unfunded, is refusing requests: Upstream request failed: Insufficient account funds (HTTP 402, server_error). Change it in Settings → Models.',
  ]);

  // The tier answers once, and a later refusal is news again.
  answers.delete('gateway/unfunded');
  await completeOnRoute(route('gateway/unfunded'), lane, 'three');
  answers.set('gateway/unfunded', 402);
  await expect(completeOnRoute(route('gateway/unfunded'), lane, 'four')).rejects.toThrow();

  expect(said()).toHaveLength(2);
});

test('a refusal the owner cannot fix (a 429) says nothing', async () => {
  const { refusals, said } = notices();

  await expect(completeOnRoute(route('gateway/busy'), { llm: gateway(new Map([['gateway/busy', 429]]), []), refusals }, 'busy')).rejects.toThrow();
  expect(said()).toEqual([]);
});

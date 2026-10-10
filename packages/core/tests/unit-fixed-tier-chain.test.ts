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
import { asFetchFunction, createChatGptProvider } from '../src/index';
import { tierRefusals } from '../src/profiles/tier-refusals';
import type { ModelRouteResolution } from '../src/profiles/model-route';
import { initActorDdl } from '../src/identity/schema';
import { readActivityLog } from '../src/identity/activity-log';
import type { LLM } from '../src/types/primitives';
import { makeExecRaw, makeSql } from './helpers';

const NO_FUNDS = JSON.stringify({ error: { message: 'Upstream request failed: Insufficient account funds', type: 'server_error' } });

/** Each model answers from `answers` once `answering` settles; a missing entry answers 200. */
function gateway(answers: ReadonlyMap<string, number>, calls: string[], answering: Promise<void> = Promise.resolve()) {
  return (resolution: ModelRouteResolution): LLM => ({
    async *stream() { yield ''; },
    async complete(prompt) {
      calls.push(resolution.model);

      const status = answers.get(resolution.model) ?? 200;

      const provider = createOpenAICompatible({
        name: 'gateway', baseURL: 'https://gateway.example.test/v1',
        fetch: Object.assign(async () => {
          await answering;

          return status === 200
            ? Response.json({ id: 'r', object: 'chat.completion', created: 0, model: resolution.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `answered by ${resolution.model}` } }] })
            : new Response(NO_FUNDS, { status, headers: { 'content-type': 'application/json' } });
        }, { preconnect: async (): Promise<void> => {} }),
      });

      return (await generateText({ model: provider(resolution.model), prompt, maxRetries: 0 })).text;
    },
  });
}

function route(model: string, fallbacks: readonly string[] = [], retries = 0): ModelRouteResolution {
  return {
    source: 'fast', tier: 'fast', model, reasoningEffort: null, retries,
    fallbacks: fallbacks.map((spec) => ({ model: spec, reasoningEffort: null })),
  };
}

function notices() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  const owner = { changes: 0 };

  initActorDdl(execRaw);

  return {
    owner,
    refusals: tierRefusals({ sql, actor, config: actor.config, now: () => 1, settings: 'Settings → Models', changes: () => owner.changes }),
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

test('each call spends the owner\'s retries, none while a fallback follows, as a turn does', async () => {
  const spent: [string, number][] = [];
  const answers = new Map([['gateway/first', 429], ['gateway/second', 429]]);
  const llm = gateway(answers, []);

  const lane = {
    llm: (resolution: ModelRouteResolution): LLM => {
      spent.push([resolution.model, resolution.retries]);

      return llm(resolution);
    },
  };

  await expect(completeOnRoute(route('gateway/first', ['gateway/second', 'gateway/last'], 3), lane, 'compress')).resolves.toBe('answered by gateway/last');
  await expect(completeOnRoute(route('gateway/alone', [], 3), lane, 'compress')).resolves.toBe('answered by gateway/alone');

  expect(spent).toEqual([['gateway/first', 0], ['gateway/second', 0], ['gateway/last', 3], ['gateway/alone', 3]]);
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
    'Your fast tier is refusing requests. gateway/unfunded: Upstream request failed: Insufficient account funds (HTTP 402, server_error). Change it in Settings → Models.',
  ]);

  // The tier answers once, and a later refusal is news again.
  answers.delete('gateway/unfunded');
  await completeOnRoute(route('gateway/unfunded'), lane, 'three');
  answers.set('gateway/unfunded', 402);
  await expect(completeOnRoute(route('gateway/unfunded'), lane, 'four')).rejects.toThrow();

  expect(said()).toHaveLength(2);
});

test('a spent plan on the tier is said once, where a busy one says nothing', async () => {
  const { refusals, said } = notices();

  const spent = createChatGptProvider().createModel('gpt-6.1-sol', {
    env: {},
    sessionAffinity: 'kinu-test',
    workspaceAffinity: 'kinu-test',
    fetch: asFetchFunction(async () => Response.json(
      { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'usage limit reached', param: null, type: 'rate_limit_error' } },
      { status: 429 },
    )),
    getAuth: async () => ({ headers: { Authorization: 'Bearer at-1' } }),
    hasCredential: async () => true,
  });

  const lane = {
    llm: (): LLM => ({ async *stream() { yield ''; }, complete: async (prompt) => (await generateText({ model: spent, prompt, maxRetries: 0 })).text }),
    refusals,
  };

  await expect(completeOnRoute(route('chatgpt/gpt-6.1-sol'), lane, 'one')).rejects.toThrow();
  await expect(completeOnRoute(route('chatgpt/gpt-6.1-sol'), lane, 'two')).rejects.toThrow();

  expect(said()).toHaveLength(1);
  expect(said()[0]).toContain('Your fast tier is refusing requests. chatgpt/gpt-6.1-sol: ');
  expect(said()[0]).toContain('https://chatgpt.com/settings/usage');
});

test('a refusal the owner cannot fix (a 429) says nothing', async () => {
  const { refusals, said } = notices();

  await expect(completeOnRoute(route('gateway/busy'), { llm: gateway(new Map([['gateway/busy', 429]]), []), refusals }, 'busy')).rejects.toThrow();
  expect(said()).toEqual([]);
});

// Review of T3, 2026-09-30: the primary handed over on a 503, its fallback answered 402, and the notice named the
// primary. The owner repairs what refused, as it was called.
test('the notice names the fallback that refused, not the primary that handed over', async () => {
  const calls: string[] = [];
  const { refusals, said } = notices();

  await expect(completeOnRoute(route('gateway/busy-primary', ['gateway/unfunded-fallback']), {
    llm: gateway(new Map([['gateway/busy-primary', 503], ['gateway/unfunded-fallback', 402]]), calls), refusals,
  }, 'compress the facts')).rejects.toThrow();

  expect(calls).toEqual(['gateway/busy-primary', 'gateway/unfunded-fallback']);
  expect(said()).toEqual([
    'Your fast tier is refusing requests. gateway/unfunded-fallback: Upstream request failed: Insufficient account funds (HTTP 402, server_error). Change it in Settings → Models.',
  ]);
});

test('a primary its cooldown skipped is not named', async () => {
  const calls: string[] = [];
  const { refusals, said } = notices();
  const answers = new Map([['gateway/cooling-primary', 503]]);

  const lane = { llm: gateway(answers, calls), refusals,
    attemptOf: async (spec: string) => ({ lane: 'fixture-primary-cooldown', modelId: spec, credential: null, ref: null }) };

  const cooling = route('gateway/cooling-primary', ['gateway/cooling-backup']);

  expect(await completeOnRoute(cooling, lane, 'one')).toBe('answered by gateway/cooling-backup');
  answers.set('gateway/cooling-backup', 402);
  await expect(completeOnRoute(cooling, lane, 'two')).rejects.toThrow();

  // The second call started at the backup.
  expect(calls).toEqual(['gateway/cooling-primary', 'gateway/cooling-backup', 'gateway/cooling-backup']);
  expect(said()).toEqual([expect.stringMatching(/^Your fast tier is refusing requests\. gateway\/cooling-backup: /)]);
});

test('each model that refused is named, in the order called, with the named account it was called on', async () => {
  const { refusals, said } = notices();
  const keys = new Map([['gateway/unfunded-work', 'GATEWAY_KEY@work'], ['gateway/unfunded-main', 'GATEWAY_KEY']]);

  await expect(completeOnRoute(route('gateway/unfunded-work', ['gateway/unfunded-main']), {
    llm: gateway(new Map([['gateway/unfunded-work', 402], ['gateway/unfunded-main', 402]]), []),
    attemptOf: async (spec) => {
      const ref = keys.get(spec);

      return ref === undefined ? null : { lane: ref, modelId: spec, credential: ref, ref };
    },
    refusals,
  }, 'compress the facts')).rejects.toThrow();

  expect(said()).toEqual([
    'Your fast tier is refusing requests. gateway@work/unfunded-work: Upstream request failed: Insufficient account funds (HTTP 402, server_error). '
      + 'gateway/unfunded-main: Upstream request failed: Insufficient account funds (HTTP 402, server_error). Change it in Settings → Models.',
  ]);
});

// Review of T3, 2026-09-30: the owner replaced a refused key while a call made with the old one still waited on its
// answer, and the late refusal was said as the tier's state after the fix.
test('a refusal from a call started before the owner\'s change is not said; one after it is, again after the next', async () => {
  const { owner, refusals, said } = notices();
  const answer = Promise.withResolvers<void>();
  const answers = new Map([['gateway/rekeyed', 401]]);
  const stale = completeOnRoute(route('gateway/rekeyed'), { llm: gateway(answers, [], answer.promise), refusals }, 'one');

  owner.changes += 1;
  answer.resolve();
  await expect(stale).rejects.toThrow();
  expect(said()).toEqual([]);

  // The new key is refused too: news, once.
  const lane = { llm: gateway(answers, []), refusals };

  await expect(completeOnRoute(route('gateway/rekeyed'), lane, 'two')).rejects.toThrow();
  await expect(completeOnRoute(route('gateway/rekeyed'), lane, 'three')).rejects.toThrow();
  expect(said()).toHaveLength(1);

  // Another change, still refused: said again.
  owner.changes += 1;
  await expect(completeOnRoute(route('gateway/rekeyed'), lane, 'four')).rejects.toThrow();
  expect(said()).toHaveLength(2);
});

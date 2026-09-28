import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import worker, { MAX_BODY_BYTES } from '../../scripts/scripted-model-worker';
import { startScriptedModel } from '../../scripts/scripted-model';
import { FALLBACK_ANSWER } from '../../scripts/scripted-protocol';
import { tierModel } from '../../scripts/tier-model';

/** An OpenAI-shaped refusal of a request, with the failure's class as its code. */
const RefusalSchema = v.object({
  error: v.object({ message: v.string(), type: v.literal('invalid_request_error'), code: v.literal('malformed-input') }),
});

const CompletionSchema = v.object({ choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]) });

/** Bodies no chat completion request is: text that is not JSON, and JSON whose messages are not a list. */
const UNREADABLE = ['{"messages": [', JSON.stringify({ messages: 'not a list' })];

const COMPLETIONS = 'https://scripted-model.kinu.run/chat/completions';

const KEY = 'fixture-scripted-key';

const ENV = { SCRIPTED_MODEL_KEY: KEY };

/** A request as the deployment's provider sends it: the account's API key as its bearer. */
function asked(url: string, body?: BodyInit): Request {
  const headers = { authorization: `Bearer ${KEY}` };

  return body === undefined ? new Request(url, { headers }) : new Request(url, { method: 'POST', headers, body });
}

describe('the scripted model refuses a body it cannot read, the way a provider does', () => {
  test('the deployed tiers\' Worker answers 400 with the refusal\'s class', async () => {
    for (const body of UNREADABLE) {
      const response = await worker.fetch(asked(COMPLETIONS, body), ENV);

      expect(response.status).toBe(400);
      expect(v.safeParse(RefusalSchema, await response.json()).success).toBe(true);
    }
  });

  test('the local runs\' server answers the same refusal', async () => {
    const server = await startScriptedModel(tierModel);

    try {
      for (const body of UNREADABLE) {
        const response = await fetch(`${server.baseURL}/chat/completions`, { method: 'POST', body });

        expect(response.status).toBe(400);
        expect(v.safeParse(RefusalSchema, await response.json()).success).toBe(true);
      }
    } finally {
      await server.stop();
    }
  });

  test('a request it can read is answered, not refused', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'an ask no script names' }] });
    const response = await worker.fetch(asked(COMPLETIONS, body), ENV);

    expect(response.status).toBe(200);
    expect(v.parse(CompletionSchema, await response.json()).choices[0].message.content).toBe(FALLBACK_ANSWER);
  });
});

// Its route is public (HARDEN #7): only the bearer the tiers store answers, and a body is read up to a bound.
describe('the deployed tiers\' Worker answers only its key, and reads a bounded body', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

  test('no key, a wrong key, or no configured key answers nothing', async () => {
    const statuses = await Promise.all([
      worker.fetch(new Request(COMPLETIONS, { method: 'POST', body }), ENV),
      worker.fetch(new Request('https://scripted-model.kinu.run/models', { headers: { authorization: `Bearer ${KEY}x` } }), ENV),
      worker.fetch(asked(COMPLETIONS, body), {}),
    ].map(async (answer) => (await answer).status));

    expect(statuses).toEqual([401, 401, 503]);
    expect((await worker.fetch(asked('https://scripted-model.kinu.run/models'), ENV)).status).toBe(200);
  });

  test('a body past the bound is refused unread, whatever length it declares', async () => {
    const oversize = new Uint8Array(MAX_BODY_BYTES + 1);
    const declared = await worker.fetch(asked(COMPLETIONS, oversize), ENV);
    const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversize); controller.close(); } });
    const undeclared = await worker.fetch(asked(COMPLETIONS, streamed), ENV);

    expect([declared.status, undeclared.status]).toEqual([413, 413]);
  });
});

// The first-run web-search case searches through the account's `tavily` credential, pointed here.
describe('the deployed tiers\' Worker answers a Tavily search', () => {
  test('with results whose URLs the provider keeps, and refuses a body with no query', async () => {
    const search = 'https://scripted-model.kinu.run/search';
    const answered = await worker.fetch(asked(search, JSON.stringify({ query: 'Cloudflare Durable Objects documentation', max_results: 2 })), ENV);
    const body = v.parse(v.object({ results: v.array(v.object({ url: v.pipe(v.string(), v.url()) })) }), await answered.json());

    expect([answered.status, body.results.length]).toEqual([200, 2]);
    expect(body.results.every((result) => result.url.startsWith('https://'))).toBe(true);
    expect((await worker.fetch(asked(search, '{}'), ENV)).status).toBe(400);
    expect((await worker.fetch(new Request(search, { method: 'POST', body: '{}' }), ENV)).status).toBe(401);
  });
});

// The ChatGPT plan provider (Sign in with ChatGPT) against api.openai.com faked at its fetch seam: the request
// shape the preview accepts, and each answer the plan route documents (developers.openai.com/siwc, 2026-09-30).
import { describe, expect, test } from 'bun:test';
import { APICallError, generateText, jsonSchema, streamText, tool, type LanguageModel } from 'ai';
import * as v from 'valibot';
import {
  asFetchFunction, CHATGPT_CRED_KEY, createChatGptProvider, JsonObjectSchema, type AuthRequest, type JsonObject, type ProviderDeps,
} from '../src/index';
import { KinuError } from '../src/obs/index';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: JsonObject | null;
}

type Answer = Response | (() => Response);

/** api.openai.com: each request recorded, answered in turn. */
function openai(...answers: Answer[]) {
  const sent: Sent[] = [];
  const queue = [...answers];

  const fetch = asFetchFunction(async (input, init) => {
    const text = v.safeParse(v.string(), init?.body);

    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: new Headers(init?.headers).get('authorization'),
      body: text.success ? v.parse(JsonObjectSchema, JSON.parse(text.output)) : null,
    });
    const next = queue.shift();

    if (next === undefined) throw new Error('api.openai.com was asked more often than the test answers');

    return next instanceof Function ? next() : next;
  });

  return { fetch, sent };
}

/** A Responses stream event: its type, and the rest of what the API sends with it. */
interface StreamEvent {
  readonly type: string;
  readonly [field: string]: JsonObject[string];
}

function sse(...events: readonly StreamEvent[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream' } });
}

const MESSAGE = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };

const RESPONSE = { id: 'resp_1', object: 'response', created_at: 1_790_000_000, model: 'gpt-6.1-sol', status: 'in_progress', output: [] };

const USAGE = { input_tokens: 7, output_tokens: 1, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

/** One answer, `ok`, streamed as the Responses API streams it; `output` stays empty on the terminal event
 *  so a collector must read the finished items. */
function answered(): Response {
  return sse(
    { type: 'response.created', response: RESPONSE },
    { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: MESSAGE },
    { type: 'response.completed', response: { ...RESPONSE, status: 'completed', usage: USAGE } },
  );
}

function refusal(status: number, code: string, param?: string): Response {
  return Response.json({ error: { code, message: `refused: ${code}`, param: param ?? null, type: 'invalid_request_error' } }, {
    status, headers: { 'x-request-id': `req_${code}`, 'retry-after': '0' },
  });
}

/** The CLI's resolver: one stored login, refreshed when the provider names the token it saw refused. */
function signedIn(fetch: typeof globalThis.fetch) {
  const asked: (AuthRequest | undefined)[] = [];

  const deps: ProviderDeps = {
    env: {},
    fetch,
    async getAuth(key, opts) {
      if (key !== CHATGPT_CRED_KEY) return null;
      asked.push(opts);

      return { headers: { Authorization: opts?.rejected === undefined ? 'Bearer at-1' : 'Bearer at-2' } };
    },
    async hasCredential(key) { return key === CHATGPT_CRED_KEY; },
  };

  return { deps, asked };
}

/** The KinuError a failure carries, itself or down its cause chain. */
function kinuCause(failure: { readonly error: unknown }): KinuError | null {
  for (let link = failure.error; link instanceof Error; link = link.cause) {
    if (link instanceof KinuError) return link;
  }

  return null;
}

/** What a call was rejected with, or null when it answered. */
function failureOf(pending: PromiseLike<unknown>): PromiseLike<{ readonly error: unknown } | null> {
  return pending.then(() => null, (...rejection: [unknown]) => ({ error: rejection[0] }));
}

/** How a stream ended: the error part it carried, or the error its reader threw. */
async function streamFailure(model: LanguageModel): Promise<{ readonly error: unknown }> {
  const reader = streamText({ model, prompt: 'hello', maxRetries: 0 }).fullStream.getReader();

  for (;;) {
    const next = await reader.read().then((read) => ({ read }), (...rejection: [unknown]) => ({ thrown: rejection[0] }));

    if ('thrown' in next) return { error: next.thrown };

    if (next.read.done) return { error: null };

    if (next.read.value.type === 'error') return { error: next.read.value.error };
  }
}

describe('the request the preview accepts', () => {
  test('streams statelessly with developer instructions, namespaced tools and no refused field', async () => {
    const api = openai(answered());
    const { deps } = signedIn(api.fetch);
    const model = createChatGptProvider().createModel('gpt-6.1-sol', deps);

    const result = streamText({
      model,
      maxRetries: 0,
      system: 'You are Kinu.',
      temperature: 0.2,
      topP: 0.9,
      tools: { read_file: tool({ description: 'Read a file.', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } } }) }) },
      providerOptions: {
        openai: {
          metadata: { run: 'r1' }, previousResponseId: 'resp_0', promptCacheRetention: '24h', safetyIdentifier: 'owner',
          user: 'owner', truncation: 'auto', maxToolCalls: 3, promptCacheKey: 'conversation-1',
        },
      },
      messages: [
        { role: 'user', content: 'Read notes.md.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'notes.md' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read_file', output: { type: 'text', value: 'hi' } }] },
      ],
    });

    expect(await result.text).toBe('ok');
    const [request] = api.sent;

    expect(request?.url).toBe('https://api.openai.com/v1/responses');
    expect(request?.authorization).toBe('Bearer at-1');
    const body = request?.body ?? {};

    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, prompt_cache_key: 'conversation-1' });

    for (const refused of ['temperature', 'top_p', 'max_output_tokens', 'metadata', 'previous_response_id', 'prompt_cache_retention', 'safety_identifier', 'user', 'truncation', 'max_tool_calls']) {
      expect(body).not.toHaveProperty(refused);
    }

    const input = v.parse(v.array(v.looseObject({ type: v.optional(v.string()), role: v.optional(v.string()) })), body.input);

    expect(input.filter((item) => item.role === 'system')).toEqual([]);
    expect(input[0]).toMatchObject({ role: 'developer', content: 'You are Kinu.' });
    expect(input.find((item) => item.type === 'function_call')).toMatchObject({ call_id: 'call_1', name: 'read_file', namespace: 'functions' });
    expect(body.tools).toEqual([{
      type: 'namespace', name: 'functions', description: '',
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    }]);
  });

  test('a call that wants one answer still streams, and the stream becomes that answer', async () => {
    const api = openai(answered());
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);

    const result = await generateText({ model, prompt: 'hello', maxRetries: 0 });

    expect(api.sent[0]?.body).toMatchObject({ stream: true, store: false });
    expect(result.text).toBe('ok');
    expect(result.usage.inputTokens).toBe(7);
  });
});

describe('what the plan route answers', () => {
  test.each([
    ['subscription_sharing_user_not_eligible', 403, 'denied'],
    ['subscription_sharing_usage_limit_exceeded', 429, 'budget'],
    ['subscription_sharing_unsupported_capability', 400, 'unsupported'],
    ['subscription_sharing_route_not_supported', 403, 'unsupported'],
    ['chatpass_v2_scope_not_authorized', 403, 'denied'],
    ['chatpass_v2_invalid_authorization_context', 403, 'denied'],
  ] as const)('%s (HTTP %i) is a %s refusal, sent once and never retried', async (code, status, kind) => {
    const api = openai(refusal(status, code, 'tools[0].type'));
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateText({ model, prompt: 'hello', maxRetries: 0 }));

    expect(api.sent).toHaveLength(1);
    expect(APICallError.isInstance(failed?.error)).toBe(true);
    expect(failed?.error).toMatchObject({ statusCode: status, isRetryable: false, message: expect.stringContaining(`req_${code}`) });
    expect(failed === null ? null : kinuCause(failed)?.code).toBe(kind);
  });

  test('the usage limit names where the owner manages it', async () => {
    const api = openai(refusal(429, 'subscription_sharing_usage_limit_exceeded'));
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);

    await expect(generateText({ model, prompt: 'hello', maxRetries: 0 })).rejects.toThrow('https://chatgpt.com/settings/usage');
  });

  test.each(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'])('%s backs off and asks again', async (code) => {
    const api = openai(refusal(503, code), answered());
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);

    expect((await generateText({ model, prompt: 'hello', maxRetries: 0 })).text).toBe('ok');
    expect(api.sent).toHaveLength(2);
  });

  test('a refused token gets one refresh, naming the token that was refused', async () => {
    const api = openai(refusal(401, 'subscription_sharing_invalid_user'), answered());
    const { deps, asked } = signedIn(api.fetch);
    const model = createChatGptProvider().createModel('gpt-6.1-sol', deps);

    expect((await generateText({ model, prompt: 'hello', maxRetries: 0 })).text).toBe('ok');
    expect(asked).toEqual([undefined, { rejected: { Authorization: 'Bearer at-1' } }]);
    expect(api.sent.map((request) => request.authorization)).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  test('a subscriber still refused after the refresh is a denied sign-in', async () => {
    const api = openai(refusal(401, 'subscription_sharing_invalid_user'), refusal(401, 'subscription_sharing_invalid_user'));
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateText({ model, prompt: 'hello', maxRetries: 0 }));

    expect(failed === null ? null : kinuCause(failed)?.code).toBe('denied');
    expect(failed?.error).toMatchObject({ statusCode: 401 });
  });

  test('a direct-admission refusal before the stream opens keeps its status', async () => {
    const api = openai(Response.json({ detail: 'serving region not permitted' }, { status: 403 }));
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateText({ model, prompt: 'hello', maxRetries: 0 }));

    expect(failed?.error).toMatchObject({ statusCode: 403 });
    expect(failed === null ? null : kinuCause(failed)?.code).toBe('denied');
  });

  test('a usage limit after the stream opens fails it as a budget refusal', async () => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'o' },
      { type: 'response.failed', response: { ...RESPONSE, status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
    ));

    const failure = await streamFailure(createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps));

    expect(kinuCause(failure)?.code).toBe('budget');
  });

  test('a stream that ends before response.completed is not an answer', async () => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'o' },
    ));

    const failure = await streamFailure(createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps));

    expect(kinuCause(failure)).toMatchObject({ code: 'unavailable', message: 'ChatGPT ended the stream before response.completed' });
  });
});

describe('the model list', () => {
  test('lists what the account may pick, in the order OpenAI gives', async () => {
    const api = openai(Response.json({
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', context_window: 400_000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'internal-probe', display_name: 'Probe', visibility: 'hide' },
        { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', priority: 99 },
      ],
    }));

    const models = await createChatGptProvider().listModels(signedIn(api.fetch).deps);

    expect(api.sent[0]).toMatchObject({ url: 'https://api.openai.com/v1/models', method: 'GET', authorization: 'Bearer at-1' });
    expect(models.map((model) => [model.id, model.label, model.contextWindow ?? null])).toEqual([
      ['gpt-6.1-sol', 'GPT-6.1 Sol', 400_000],
      ['gpt-6-luna', 'GPT-6 Luna', null],
    ]);
  });
});

describe('on the web, through the machine that signed in', () => {
  test('the machine attaches its own token, and its signed-out answer is a missing sign-in', async () => {
    const api = openai(Response.json({ error: { code: 'chatgpt_signed_out', message: 'studio holds no ChatGPT sign-in with plan usage' } }, { status: 401 }));
    const asked: string[] = [];

    const deps: ProviderDeps = {
      env: {},
      async getAuth(key) {
        asked.push(key);

        return null;
      },
      async hasCredential() { return false; },
    };

    const provider = createChatGptProvider({ device: { fetch: api.fetch, unavailableReason: async () => undefined } });

    expect(await provider.isAvailable(deps)).toBe(true);
    const failed = await failureOf(generateText({ model: provider.createModel('gpt-6.1-sol', deps), prompt: 'hello', maxRetries: 0 }));

    expect(asked).toEqual([]);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.authorization).not.toContain('at-');
    expect(failed === null ? null : kinuCause(failed)).toMatchObject({ code: 'missing' });
    expect(failed?.error).toMatchObject({ message: expect.stringContaining('studio holds no ChatGPT sign-in') });
  });
});

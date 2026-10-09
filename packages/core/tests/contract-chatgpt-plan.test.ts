// The ChatGPT plan provider (Sign in with ChatGPT) against api.openai.com faked at its fetch seam: the request
// shape the preview accepts, and each answer the plan route documents (developers.openai.com/siwc, 2026-09-30).
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { APICallError, generateText, jsonSchema, streamText, tool, type LanguageModel } from 'ai';
import * as v from 'valibot';
import {
  asFetchFunction, CHATGPT_CRED_KEY, createChatGptProvider, createProviderRegistry, generateReported, JsonObjectSchema, silenceBoundMs,
  type AuthRequest, type JsonObject, type ModelAffinity, type ModelCallDeps,
} from '../src/index';
import { KinuError, createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { withModelStack } from '../src/providers/wire-model';
import { callRetries } from '../src/providers/middleware/retry';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  /** `session_id`, `conversation_id` and `x-client-request-id`. */
  readonly session: readonly (string | null)[];
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
      session: ['session_id', 'conversation_id', 'x-client-request-id'].map((name) => new Headers(init?.headers).get(name)),
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

/** The fields developers.openai.com/siwc/token-sharing-open-source/preview-limitations says to omit (2026-09-30). */
const PREVIEW_REFUSED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'previous_response_id', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user',
];

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

  const deps: ModelCallDeps = {
    env: {},
    sessionAffinity: 'kinu-test',
    workspaceAffinity: 'kinu-test',
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
  const reader = streamText({ model, prompt: 'hello', maxRetries: 0 }).stream.getReader();

  for (;;) {
    const next = await reader.read().then((read) => ({ read }), (...rejection: [unknown]) => ({ thrown: rejection[0] }));

    if ('thrown' in next) return { error: next.thrown };

    if (next.read.done) return { error: null };

    if (next.read.value.type === 'error') return { error: next.read.value.error };
  }
}

// preview-limitations (read 2026-10-05) requires store:false, forbids previous_response_id over HTTP, and says nothing of
// compaction: OpenAI's server-side compaction is unproven on this route, so it stays off.
describe('the request the preview accepts', () => {
  test('streams statelessly with developer instructions, namespaced tools and no refused field', async () => {
    const api = openai(answered());
    const { deps } = signedIn(api.fetch);
    const model = createChatGptProvider().createModel('gpt-6.1-sol', deps);

    const result = streamText({
      model,
      maxRetries: 0,
      instructions: 'You are Kinu.',
      tools: { read_file: tool({ description: 'Read a file.', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } } }) }) },
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

    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true });

    // preview-limitations (2026-09-30), whole, and `previous_response_id`, which nothing stored can answer.
    for (const refused of PREVIEW_REFUSED_FIELDS) expect(body).not.toHaveProperty(refused);

    const input = v.parse(v.array(v.looseObject({ type: v.optional(v.string()), role: v.optional(v.string()) })), body.input);

    expect(input.filter((item) => item.role === 'system')).toEqual([]);
    expect(input[0]).toMatchObject({ role: 'developer', content: 'You are Kinu.' });
    expect(input.find((item) => item.type === 'function_call')).toMatchObject({ call_id: 'call_1', name: 'read_file', namespace: 'functions' });
    expect(body.tools).toEqual([{
      type: 'namespace', name: 'functions', description: '',
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }],
    }]);
  });

  // codex.ts `chatgptSessionHeaders`: the backend caches under the session, which a workspace's conversations share.
  test('a login that names no account keeps its workspace as the session; each conversation is its own', async () => {
    const api = openai(answered(), answered(), answered(), answered());
    const { deps } = signedIn(api.fetch);
    const provider = createChatGptProvider();
    const model = (affinity: Partial<ModelAffinity>) => provider.createModel('gpt-6.1-sol', { ...deps, ...affinity });
    const [first, sibling, elsewhere] = [model({}), model({ sessionAffinity: 'kinu-hire' }), model({ workspaceAffinity: 'kinu-workspace-other' })];

    for (const called of [first, first, sibling, elsewhere]) expect(await streamText({ model: called, maxRetries: 0, prompt: 'hello' }).text).toBe('ok');

    const [[session, conversation, request] = [], again, [hireSession, hireConversation] = [], [otherSession] = []] = api.sent.map((sent) => sent.session);

    expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect([again, request]).toEqual([[session, conversation, request], conversation]);
    expect([hireSession === session, hireConversation === conversation, otherSession === session]).toEqual([true, false, false]);
  });

  test('a login that names its account is that account\'s session in every workspace, and another account\'s is not', async () => {
    const api = openai(answered(), answered(), answered());
    const token = (account: string) => `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.s`;
    const provider = createChatGptProvider();

    const model = (account: string, workspaceAffinity: string) => provider.createModel('gpt-6.1-sol', {
      ...signedIn(api.fetch).deps, workspaceAffinity, getAuth: async () => ({ headers: { Authorization: `Bearer ${token(account)}` } }),
    });

    for (const called of [model('acct-1', 'kinu-workspace-a'), model('acct-1', 'kinu-workspace-b'), model('acct-2', 'kinu-workspace-a')]) {
      expect(await streamText({ model: called, maxRetries: 0, prompt: 'hello' }).text).toBe('ok');
    }

    const [[a] = [], [b] = [], [other] = []] = api.sent.map((sent) => sent.session);

    expect([a === b, a === other]).toEqual([true, false]);
  });

  test('a call that wants one answer still streams, and the stream becomes that answer', async () => {
    const api = openai(answered());
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);

    const result = await generateText({ model, prompt: 'hello', maxRetries: 0 });

    expect(api.sent[0]?.body).toMatchObject({ stream: true, store: false });
    expect(result.text).toBe('ok');
    expect(result.usage.inputTokens).toBe(7);
  });

  test('a call that wants one answer is held to the silence bound its stream is', async () => {
    jest.useFakeTimers();
    const opened = Promise.withResolvers<void>();

    const api = openai(() => {
      opened.resolve();

      return new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    // As the registry resolves it: the one stack, which collects a generate from the plan's stream.
    const model = withModelStack(createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps), { provider: 'chatgpt', lane: 'chatgpt@main', generateByStream: true });
    // No retry, so the one silent attempt is the whole call.
    const failure = failureOf(generateText({ model, prompt: 'hello', maxRetries: 0, providerOptions: callRetries(0) }));

    await opened.promise;
    jest.advanceTimersByTime(silenceBoundMs('provider.stream.idle_ms'));

    expect(await failure).not.toBeNull();
  });
});

afterEach(() => { jest.useRealTimers(); });

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
    // The provider's own words reach the owner, not a sentence of Kinu's in their place, with the request id.
    expect(failed?.error).toMatchObject({ statusCode: status, isRetryable: false, message: expect.stringMatching(new RegExp(`^refused: ${code} .*request req_${code}`)) });
    expect(failed === null ? null : kinuCause(failed)?.code).toBe(kind);
  });

  test('the usage limit keeps OpenAI\'s words and names where the owner manages it', async () => {
    const api = openai(refusal(429, 'subscription_sharing_usage_limit_exceeded'));
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateText({ model, prompt: 'hello', maxRetries: 0 }));

    expect(failed?.error).toMatchObject({
      message: expect.stringMatching(/^refused: subscription_sharing_usage_limit_exceeded .*manage usage at https:\/\/chatgpt\.com\/settings\/usage$/),
    });
  });

  test.each(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'])('%s backs off and asks again', async (code) => {
    const api = openai(refusal(503, code), answered());
    // As the registry resolves it: the one stack, which waits the refusal out.
    const model = withModelStack(createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps), { provider: 'chatgpt', lane: 'chatgpt@main', sleep: async () => {} });

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

    expect(failed?.error).toMatchObject({ statusCode: 403, message: expect.stringContaining('serving region not permitted') });
    expect(failed === null ? null : kinuCause(failed)).toMatchObject({ code: 'denied', message: expect.stringContaining('serving region not permitted') });
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

  test('an answer ChatGPT stops on its content filter fails the stream, naming the reason', async () => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'o' },
      { type: 'response.incomplete', response: { ...RESPONSE, status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: USAGE } },
    ));

    const failure = await streamFailure(createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps));

    expect(kinuCause(failure)).toMatchObject({ code: 'denied', message: expect.stringContaining('content_filter') });
  });

  // The chat loop's continuation contract: it continues a `length` finish once (chat.ts, OUTPUT_LIMIT_REACHED).
  test('an answer stopped at its output limit reaches the stream as a `length` finish, which the chat loop continues', async () => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { ...MESSAGE, status: 'incomplete' } },
      { type: 'response.incomplete', response: { ...RESPONSE, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: USAGE } },
    ));

    const result = streamText({ model: createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps), prompt: 'hello', maxRetries: 0 });

    expect(await result.finishReason).toBe('length');
    expect(await result.text).toBe('ok');
  });

  test('a one-shot answer ChatGPT stops at its output limit fails the completion that asked for it: billed, never complete', async () => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { ...MESSAGE, status: 'incomplete' } },
      { type: 'response.incomplete', response: { ...RESPONSE, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [MESSAGE], usage: USAGE } },
    ));

    const billed: string[] = [];
    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateReported({ model, prompt: 'hello', maxRetries: 0 }, { spend: { source: 'compaction', report: (report) => billed.push(report.source) } }));

    expect({ failure: failed === null ? null : kinuCause(failed)?.message, billed })
      .toEqual({ failure: expect.stringContaining('max_output_tokens'), billed: ['compaction'] });
  });

  test.each(['content_filter'])('a one-shot answer ChatGPT stops short (%s) is a failure, not the partial text', async (reason) => {
    const api = openai(sse(
      { type: 'response.created', response: RESPONSE },
      { type: 'response.output_item.added', output_index: 0, item: { ...MESSAGE, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { ...MESSAGE, status: 'incomplete' } },
      { type: 'response.incomplete', response: { ...RESPONSE, status: 'incomplete', incomplete_details: { reason }, output: [MESSAGE], usage: USAGE } },
    ));

    const model = createChatGptProvider().createModel('gpt-6.1-sol', signedIn(api.fetch).deps);
    const failed = await failureOf(generateText({ model, prompt: 'hello', maxRetries: 0 }));

    expect(failed === null ? null : kinuCause(failed)).toMatchObject({ message: expect.stringContaining(reason) });
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

    expect(api.sent[0]).toMatchObject({ method: 'GET', authorization: 'Bearer at-1' });
    const listed = new URL(api.sent[0]?.url ?? '');
    expect(`${listed.origin}${listed.pathname}`).toBe('https://api.openai.com/v1/models');
    expect(listed.searchParams.get('client_version')).not.toBeNull();
    expect(models.map((model) => [model.id, model.label, model.contextWindow ?? null])).toEqual([
      ['gpt-6.1-sol', 'GPT-6.1 Sol', 400_000],
      ['gpt-6-luna', 'GPT-6 Luna', null],
    ]);
  });
  // Each window as the plan's catalog gives it on 2026-10-02 (OMP's generated `openai-codex` catalog): `context_window`
  // is the standard-priced window, `max_context_window` the most the model takes.
  test('a model\'s window is the most its catalog row allows, and the rows it hides are logged once, by slug', async () => {
    const api = openai(Response.json({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1, context_window: 272_000, max_context_window: 872_000 },
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'hide', priority: 0, context_window: 272_000, max_context_window: 872_000 },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 5, context_window: 272_000, max_context_window: 272_000 },
        { slug: 'gpt-6.1-sol-wm', visibility: 'experimental' },
      ],
    }));

    const logger = createRecordingLogger();
    const restore = setDiagnosticsSink(logger);

    try {
      const models = await createChatGptProvider().listModels(signedIn(api.fetch).deps);

      expect(models.map((model) => [model.id, model.contextWindow ?? null])).toEqual([['gpt-5.6-sol', 872_000], ['gpt-5.5', 272_000]]);
      expect(logger.emitted.filter((r) => r.event === 'provider.catalog_hidden').map((r) => r.fields))
        .toEqual([{ provider: 'chatgpt', hidden: 'gpt-6.1-sol:hide,gpt-6.1-sol-wm:experimental' }]);
    } finally {
      restore();
    }
  });
});

describe('on the web, through the machine that signed in', () => {
  test('the machine attaches its own token, and its signed-out answer is a missing sign-in', async () => {
    const api = openai(Response.json({ error: { code: 'chatgpt_signed_out', message: 'studio holds no ChatGPT sign-in with plan usage' } }, { status: 401 }));
    const asked: string[] = [];

    const deps: ModelCallDeps = {
      env: {},
      sessionAffinity: 'kinu-test',
      workspaceAffinity: 'kinu-test',
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

  test('an account holding its own sign-in calls api.openai.com itself, past a machine that could carry it', async () => {
    const api = openai(answered());
    const machine = openai();
    const { deps } = signedIn(api.fetch);
    const provider = createChatGptProvider({ device: { fetch: machine.fetch, unavailableReason: async () => undefined } });

    expect((await generateText({ model: provider.createModel('gpt-6.1-sol', deps), prompt: 'hello', maxRetries: 0 })).text).toBe('ok');
    expect(machine.sent).toEqual([]);
    expect(api.sent.map(({ url, authorization, body }) => ({ url, authorization, store: body?.store, stream: body?.stream }))).toEqual([
      { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer at-1', store: false, stream: true },
    ]);
  });
});

describe('a stream after its sign-in was renewed', () => {
  test('keepalives on the renewed request reach the silence bound', async () => {
    jest.useFakeTimers();
    const encoder = new TextEncoder();
    let pulls = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();

    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls.resolve(controller); } }, { highWaterMark: 0 });

    const next = async (): Promise<ReadableStreamDefaultController<Uint8Array>> => {
      const controller = await pulls.promise;

      pulls = Promise.withResolvers();

      return controller;
    };

    const api = openai(refusal(401, 'token_expired'), () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { deps, asked } = signedIn(api.fetch);
    const registry = createProviderRegistry();

    registry.register(createChatGptProvider());
    const result = streamText({ model: registry.resolve('chatgpt/gpt-6.1-sol', deps), prompt: 'hello', maxRetries: 0 });
    const IDLE_MS = silenceBoundMs('provider.stream.idle_ms');

    // The model thinks for three bounds, sending only keepalive comments, then answers.
    for (let comment = 0; comment < 3; comment++) {
      const controller = await next();

      for (let turn = 0; turn < 100; turn++) await Promise.resolve();
      jest.advanceTimersByTime(IDLE_MS - 1);
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    }

    const answer = await answered().text();

    (await next()).enqueue(encoder.encode(answer));
    (await next()).close();

    expect({ text: await result.text, renewed: asked.some((request) => request?.rejected !== undefined), sent: api.sent.length })
      .toEqual({ text: 'ok', renewed: true, sent: 2 });
  });
});

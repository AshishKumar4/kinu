// developers.openai.com/siwc, ADR P1.
import { createOpenAI } from '@ai-sdk/openai';
import { EventSourceParserStream, type EventSourceMessage } from '@ai-sdk/provider-utils';
import type { JSONObject, LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, diagnostics, KinuError, settle, tolerate, type ErrorCode } from '../obs/index';
import { chatgptCatalogRows } from './codex';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { OAuthTokenError } from './oauth-token-error';
import { withCallAccount } from './quota';
import { withRateLimitRetry } from './rate-limit-retry';
import type { AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { StaleModelList, statelessResponses } from './util';

export const CHATGPT_BASE_URL = 'https://api.openai.com/v1';

export const CHATGPT_CRED_KEY = 'chatgpt.oauth';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const CHATGPT_DEFAULT_MODEL = 'gpt-6.1-sol';

const CHATGPT_SIGNED_OUT = 'chatgpt_signed_out';

const TOOL_NAMESPACE = 'functions';

export function chatgptEgressAllowed(input: { readonly method: string; readonly url: string }): boolean {
  const url = URL.parse(input.url);

  if (url?.protocol !== 'https:' || url.hostname !== 'api.openai.com' || url.port !== '') return false;

  return (input.method === 'GET' && url.pathname === '/v1/models') || (input.method === 'POST' && url.pathname === '/v1/responses');
}

export interface ChatGptDeviceRoute {
  readonly fetch: typeof fetch;
  unavailableReason(): Promise<string | undefined>;
}

export interface ChatGptProviderOptions {
  readonly device?: ChatGptDeviceRoute;
}

const REFUSED_OPTIONS = [
  'conversation', 'maxToolCalls', 'metadata', 'previousResponseId', 'user', 'promptCacheRetention', 'safetyIdentifier', 'logprobs', 'truncation',
] as const;

function namespacedCall(message: LanguageModelV3Message, functions: ReadonlySet<string>): LanguageModelV3Message {
  if (message.role !== 'assistant') return message;

  return {
    ...message,
    content: message.content.map((part) => (part.type !== 'tool-call' || !functions.has(part.toolName) || part.providerOptions?.openai?.namespace !== undefined
      ? part
      : { ...part, providerOptions: { ...part.providerOptions, openai: { ...part.providerOptions?.openai, namespace: TOOL_NAMESPACE } } })),
  };
}

const PLAN_REQUEST: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }): Promise<LanguageModelV3CallOptions> => {
    const openai: JSONObject = { ...params.providerOptions?.openai, systemMessageMode: 'developer' };

    for (const field of REFUSED_OPTIONS) delete openai[field];
    const functions = new Set(params.tools?.flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])));

    return {
      ...params,
      temperature: undefined,
      topP: undefined,
      prompt: params.prompt.map((message) => namespacedCall(message, functions)),
      tools: params.tools?.map((tool) => (tool.type === 'function'
        ? { ...tool, providerOptions: { ...tool.providerOptions, openai: { ...tool.providerOptions?.openai, namespace: { name: TOOL_NAMESPACE, description: '' } } } }
        : tool)),
      providerOptions: { ...params.providerOptions, openai },
    };
  },
};

interface Refusal {
  readonly code: ErrorCode;
  readonly status: number;
  readonly words: (said: { readonly param: string | null; readonly message: string | null }) => string;
}

const NOT_AUTHORIZED: Refusal = { code: 'denied', status: 403, words: () => 'This sign-in\'s ChatGPT plan permission does not authorize the call' };

const PLAN_REFUSALS = new Map<string, Refusal>([
  ['subscription_sharing_user_not_eligible', { code: 'denied', status: 403, words: () => 'ChatGPT plan usage is not available for this ChatGPT account, workspace or policy' }],
  ['subscription_sharing_usage_limit_exceeded', { code: 'budget', status: 429, words: () => `The ChatGPT plan's usage limit is reached; manage usage at ${CHATGPT_USAGE_URL}` }],
  ['subscription_sharing_usage_unavailable', { code: 'unavailable', status: 503, words: () => 'ChatGPT could not check plan usage right now' }],
  ['subscription_sharing_user_unavailable', { code: 'unavailable', status: 503, words: () => 'ChatGPT account information is unavailable right now' }],
  ['subscription_sharing_unsupported_capability', { code: 'unsupported', status: 400, words: ({ param }) => `ChatGPT plan usage does not support ${param ?? 'part of this request'}` }],
  ['subscription_sharing_route_not_supported', { code: 'unsupported', status: 403, words: () => 'ChatGPT plan usage does not serve this route' }],
  ['subscription_sharing_invalid_user', { code: 'denied', status: 401, words: () => 'ChatGPT could not validate the subscriber behind this sign-in' }],
  ['chatpass_v2_scope_not_authorized', NOT_AUTHORIZED],
  ['chatpass_v2_invalid_authorization_context', NOT_AUTHORIZED],
  [CHATGPT_SIGNED_OUT, { code: 'missing', status: 401, words: ({ message }) => message ?? 'No ChatGPT sign-in with plan usage' }],
]);

const ADMISSION_REFUSALS = new Map<number, Refusal>([
  [401, { code: 'denied', status: 401, words: () => 'ChatGPT did not accept this sign-in or its plan permission' }],
  [403, { code: 'denied', status: 403, words: () => 'ChatGPT refused admission (a policy or the serving region)' }],
  [503, { code: 'unavailable', status: 503, words: () => 'ChatGPT plan routing is unavailable right now' }],
]);

const PlanErrorSchema = v.object({
  code: v.optional(v.nullable(v.string())),
  param: v.optional(v.nullable(v.string())),
  message: v.optional(v.nullable(v.string())),
});

const PlanErrorBodySchema = v.object({ error: PlanErrorSchema });

interface PlanError {
  readonly code: string | null;
  readonly param: string | null;
  readonly message: string | null;
}

function planErrorOf(said: { readonly error: unknown }): PlanError | null {
  const parsed = v.safeParse(PlanErrorSchema, said.error);

  return parsed.success ? { code: parsed.output.code ?? null, param: parsed.output.param ?? null, message: parsed.output.message ?? null } : null;
}

function refusalError(input: {
  readonly url: string;
  readonly refusal: Refusal;
  readonly said: PlanError | null;
  readonly headers: Headers;
  readonly body: unknown;
}): APICallError {
  const { refusal, said } = input;
  const requestId = input.headers.get('x-request-id') ?? input.headers.get('openai-request-id');
  const tags = [`HTTP ${String(refusal.status)}`, ...(said?.code ? [said.code] : []), ...(requestId === null ? [] : [`request ${requestId}`])];
  const message = `${refusal.words({ param: said?.param ?? null, message: said?.message ?? null })} (${tags.join(', ')})`;
  const cause = new KinuError(refusal.code, message);

  diagnostics.failure('provider.chatgpt_refused', cause, { code: said?.code ?? '', status: refusal.status, request: requestId ?? '' });

  return new APICallError({
    message,
    url: input.url,
    requestBodyValues: undefined,
    statusCode: refusal.status,
    responseHeaders: Object.fromEntries(input.headers),
    data: input.body,
    isRetryable: false,
    cause,
  });
}

function refusalOf(res: Response, url: string): Effect.Effect<APICallError | null> {
  if (res.ok) return Effect.succeed(null);

  return Effect.map(Effect.promise(() => res.clone().text()), (text) => {
    const body = tolerate<unknown>(() => JSON.parse(text), 'malformed-input') ?? text;
    const envelope = v.safeParse(PlanErrorBodySchema, body);
    const said = envelope.success ? planErrorOf({ error: envelope.output.error }) : null;
    const refusal = (said?.code ? PLAN_REFUSALS.get(said.code) : undefined) ?? ADMISSION_REFUSALS.get(res.status);

    return refusal === undefined ? null : refusalError({ url, refusal, said, headers: res.headers, body });
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

const EventSchema = v.object({ type: v.string() });

const FailedSchema = v.object({ response: v.object({ error: v.optional(v.nullable(v.unknown())) }) });

const TERMINAL = new Set(['response.completed', 'response.incomplete']);

const ENDED_EARLY = 'ChatGPT ended the stream before response.completed';

function eventOf(message: EventSourceMessage): { readonly type: string; readonly value: unknown } | null {
  const value = tolerate<unknown>(() => JSON.parse(message.data), 'malformed-input');
  const typed = v.safeParse(EventSchema, value);

  return typed.success ? { type: typed.output.type, value } : null;
}

function streamRefusal(event: { readonly type: string; readonly value: unknown }, url: string, headers: Headers): APICallError | KinuError {
  const failed = v.safeParse(FailedSchema, event.value);
  const said = planErrorOf({ error: failed.success ? failed.output.response.error : event.value });
  const refusal = said?.code ? PLAN_REFUSALS.get(said.code) : undefined;

  if (refusal !== undefined) return refusalError({ url, refusal, said, headers, body: event.value });

  return new KinuError('unavailable', `ChatGPT failed the response${said?.code ? ` (${said.code})` : ''}: ${said?.message ?? event.type}`);
}

function guardedStream(res: Response, url: string): Response {
  let ended = false;

  const guard = new TransformStream<EventSourceMessage, string>({
    transform(message, controller) {
      const event = eventOf(message);

      if (event !== null && (event.type === 'response.failed' || event.type === 'error')) {
        controller.error(streamRefusal(event, url, res.headers));

        return;
      }

      if (event !== null && TERMINAL.has(event.type)) ended = true;
      controller.enqueue(`${message.event === undefined ? '' : `event: ${message.event}\n`}data: ${message.data}\n\n`);
    },
    flush(controller) {
      if (!ended) controller.error(new KinuError('unavailable', ENDED_EARLY));
    },
  });

  const body = res.body?.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).pipeThrough(guard).pipeThrough(new TextEncoderStream());

  return new Response(body ?? null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const OutputItemDoneSchema = v.object({ output_index: v.number(), item: v.unknown() });

const TerminalSchema = v.object({ response: v.looseObject({ output: v.optional(v.array(v.unknown())) }) });

function collectedResponse(res: Response, url: string): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const items = new Map<number, unknown>();
    const events = res.body?.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    let terminal: v.InferOutput<typeof TerminalSchema>['response'] | null = null;

    while (events !== undefined && terminal === null) {
      const next = yield* attempt({ doing: 'reading the ChatGPT stream', otherwise: 'unavailable' }, () => events.read());

      if (next.done) break;
      const event = eventOf(next.value);

      if (event === null) continue;

      if (event.type === 'response.failed' || event.type === 'error') return yield* Effect.die(streamRefusal(event, url, res.headers));
      const done = event.type === 'response.output_item.done' ? v.safeParse(OutputItemDoneSchema, event.value) : null;

      if (done?.success === true) items.set(done.output.output_index, done.output.item);
      const finished = TERMINAL.has(event.type) ? v.safeParse(TerminalSchema, event.value) : null;

      if (finished?.success === true) terminal = finished.output.response;
    }

    if (terminal === null) return yield* Effect.fail(new KinuError('unavailable', ENDED_EARLY));
    yield* attempt({ doing: 'closing the ChatGPT stream', otherwise: 'io' }, async () => events?.cancel());
    const output = v.safeParse(v.array(v.unknown()), terminal.output);
    const headers = new Headers(res.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');

    const body = output.success && output.output.length > 0
      ? terminal
      : { ...terminal, output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item) };

    return new Response(JSON.stringify(body), { status: 200, headers });
  });
}

const StreamFlagSchema = v.looseObject({ stream: v.optional(v.boolean()) });

interface PlanCall {
  readonly init: RequestInit | undefined;
  readonly streamed: boolean;
}

function streamingRequest(init: RequestInit | undefined): PlanCall {
  const text = v.safeParse(v.string(), init?.body);
  const body = text.success ? v.safeParse(StreamFlagSchema, tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input')) : null;

  if (body?.success !== true || body.output.stream === true) return { init, streamed: true };

  return { init: { ...init, body: JSON.stringify({ ...body.output, stream: true }) }, streamed: false };
}

function resolvedAuth(deps: ProviderDeps, rejected?: Readonly<Record<string, string>>): Effect.Effect<AuthResolution | null, KinuError> {
  return Effect.tryPromise({
    try: () => deps.getAuth(CHATGPT_CRED_KEY, rejected === undefined ? undefined : { rejected }),
    catch: (cause) => (cause instanceof OAuthTokenError && cause.revoked
      ? new KinuError('denied', `ChatGPT ended this machine's sign-in (${cause.oauthError})`, { cause })
      : new KinuError('unavailable', 'the ChatGPT sign-in could not be read', { cause })),
  });
}

export function createChatGptProvider(opts: ChatGptProviderOptions = {}): ModelProvider {
  const { device } = opts;

  const unsigned = (deps: ProviderDeps): Effect.Effect<AuthResolution | null, KinuError> => (device === undefined ? resolvedAuth(deps) : Effect.succeed({ headers: {} }));

  return {
    id: 'chatgpt',
    credentialKey: CHATGPT_CRED_KEY,
    label: 'ChatGPT',
    defaultModel: CHATGPT_DEFAULT_MODEL,

    async isAvailable(deps) {
      return device === undefined ? deps.hasCredential(CHATGPT_CRED_KEY) : (await device.unavailableReason()) === undefined;
    },
    async unavailableReason() {
      return device === undefined
        ? 'Sign in with ChatGPT on this machine (kinu provider connect chatgpt) to use your ChatGPT plan.'
        : device.unavailableReason();
    },

    async listModels(deps) {
      const stale = (reason: string, failure?: KinuError) => new StaleModelList([], { reason: `ChatGPT models could not be read: ${reason}`, cause: failure });

      return settle(Effect.gen(function* () {
        const auth = yield* unsigned(deps).pipe(Effect.catch((failure) => Effect.fail(stale(failure.message, failure))));

        if (auth === null) return [];
        const url = `${CHATGPT_BASE_URL}/models`;

        const res = yield* attempt({ doing: 'listing the ChatGPT models', otherwise: 'unavailable' }, () => (device?.fetch ?? deps.fetch ?? fetch)(url, { headers: auth.headers }))
          .pipe(Effect.catch((failure) => Effect.fail(stale(failure.message, failure))));

        if (!res.ok) return yield* Effect.fail(stale((yield* refusalOf(res, url))?.message ?? `api.openai.com answered HTTP ${String(res.status)}`));
        const body: unknown = yield* Effect.promise(() => res.json());

        return chatgptCatalogRows({ body }).filter((row) => row.visibility === 'list').map((row): ModelInfo => row.model);
      }));
    },

    createModel(modelId, deps): LanguageModel {
      const transport = device?.fetch ?? deps.fetch ?? fetch;

      const refusing = asFetchFunction(async (input, init) => {
        const res = await transport(input, init);

        if (res.status === 401 || res.status === 503) return res;

        return settle(Effect.flatMap(refusalOf(res, requestUrl(input)), (refusal) => (refusal === null ? Effect.succeed(res) : Effect.die(refusal))));
      });

      const send = withRateLimitRetry(refusing, {
        provider: 'chatgpt',
        modelId,
        lane: CHATGPT_CRED_KEY,
        ...(deps.onProviderWait !== undefined && { onWait: deps.onProviderWait }),
      });

      const customFetch = asFetchFunction(async (input, requested) => {
        const { init, streamed } = streamingRequest(requested);
        const url = requestUrl(input);

        const sending = (headers: Readonly<Record<string, string>>) => Effect.promise(() => {
          const merged = copyHeaders(init?.headers);

          for (const [name, value] of Object.entries(headers)) merged.set(name, value);

          return send(input, { ...init, headers: merged });
        });

        return settle(Effect.gen(function* () {
          const auth = yield* unsigned(deps);

          if (auth === null) return yield* Effect.fail(new KinuError('missing', 'No ChatGPT sign-in with plan usage on this machine'));
          let res = yield* sending(auth.headers);

          if (res.status === 401 && device === undefined) {
            const refreshed = yield* resolvedAuth(deps, auth.headers);

            if (refreshed !== null) res = yield* sending(refreshed.headers);
          }

          const refusal = yield* refusalOf(res, url);

          if (refusal !== null) return yield* Effect.die(refusal);
          const answered = withCallAccount(res, 'chatgpt', CHATGPT_CRED_KEY);

          if (!answered.ok || (init?.method ?? 'GET').toUpperCase() !== 'POST') return answered;

          return streamed ? guardedStream(answered, url) : yield* collectedResponse(answered, url);
        }));
      });

      const provider = createOpenAI({ baseURL: CHATGPT_BASE_URL, apiKey: 'chatgpt-plan', fetch: customFetch });

      return wrapLanguageModel({ model: provider.responses(modelId), middleware: [statelessResponses(true), PLAN_REQUEST] });
    },
  };
}

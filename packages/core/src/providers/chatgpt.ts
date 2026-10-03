// developers.openai.com/siwc, ADR P1.
import { authenticatedSend } from './authenticated-send';
import { createOpenAI } from '@ai-sdk/openai';
import { EventSourceParserStream, type EventSourceMessage } from '@ai-sdk/provider-utils';
import type { JSONObject, LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, diagnostics, KinuError, settle, tolerate, type ErrorCode } from '../obs/index';
import { chatgptCatalogRows } from './codex';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { withCallAccount } from './quota';
import { withRateLimitRetry } from './rate-limit-retry';
import type { AuthRequest, AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { StaleModelList, statelessResponses } from './util';
import { JsonObjectSchema } from '../utils/json';

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

const REFUSED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'previous_response_id', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user',
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
    const functions = new Set(params.tools?.flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])));

    return {
      ...params,
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
  readonly unsaid: (param: string | null) => string;
  readonly next?: string;
}

const NOT_AUTHORIZED: Refusal = { code: 'denied', status: 403, unsaid: () => 'This sign-in\'s ChatGPT plan permission does not authorize the call' };

const PLAN_REFUSALS = new Map<string, Refusal>([
  ['subscription_sharing_user_not_eligible', { code: 'denied', status: 403, unsaid: () => 'ChatGPT plan usage is not available for this ChatGPT account, workspace or policy' }],
  ['subscription_sharing_usage_limit_exceeded', {
    code: 'budget', status: 429, unsaid: () => 'The ChatGPT plan\'s usage limit is reached', next: `manage usage at ${CHATGPT_USAGE_URL}`,
  }],
  ['subscription_sharing_usage_unavailable', { code: 'unavailable', status: 503, unsaid: () => 'ChatGPT could not check plan usage right now' }],
  ['subscription_sharing_user_unavailable', { code: 'unavailable', status: 503, unsaid: () => 'ChatGPT account information is unavailable right now' }],
  ['subscription_sharing_unsupported_capability', { code: 'unsupported', status: 400, unsaid: (param) => `ChatGPT plan usage does not support ${param ?? 'part of this request'}` }],
  ['subscription_sharing_route_not_supported', { code: 'unsupported', status: 403, unsaid: () => 'ChatGPT plan usage does not serve this route' }],
  ['subscription_sharing_invalid_user', { code: 'denied', status: 401, unsaid: () => 'ChatGPT could not validate the subscriber behind this sign-in' }],
  ['chatpass_v2_scope_not_authorized', NOT_AUTHORIZED],
  ['chatpass_v2_invalid_authorization_context', NOT_AUTHORIZED],
  [CHATGPT_SIGNED_OUT, { code: 'missing', status: 401, unsaid: () => 'No ChatGPT sign-in with plan usage' }],
]);

const ADMISSION_REFUSALS = new Map<number, Refusal>([
  [401, { code: 'denied', status: 401, unsaid: () => 'ChatGPT did not accept this sign-in or its plan permission' }],
  [403, { code: 'denied', status: 403, unsaid: () => 'ChatGPT refused admission (a policy or the serving region)' }],
  [503, { code: 'unavailable', status: 503, unsaid: () => 'ChatGPT plan routing is unavailable right now' }],
]);

const PlanErrorSchema = v.object({
  code: v.optional(v.nullable(v.string())),
  param: v.optional(v.nullable(v.string())),
  message: v.optional(v.nullable(v.string())),
});

const PlanErrorBodySchema = v.object({ error: PlanErrorSchema });

const AdmissionBodySchema = v.object({ detail: v.string() });

interface PlanError {
  readonly code: string | null;
  readonly param: string | null;
  readonly message: string | null;
}

function planErrorOf(said: { readonly error: unknown }): PlanError | null {
  const parsed = v.safeParse(PlanErrorSchema, said.error);

  return parsed.success ? { code: parsed.output.code ?? null, param: parsed.output.param ?? null, message: parsed.output.message ?? null } : null;
}

function requestIdOf(headers: Headers): string | null {
  return headers.get('x-request-id') ?? headers.get('openai-request-id');
}

function refusalError(input: {
  readonly url: string;
  readonly refusal: Refusal;
  readonly said: PlanError | null;
  readonly words: string | null;
  readonly headers: Headers;
  readonly body: unknown;
}): APICallError {
  const { refusal, said } = input;
  const requestId = requestIdOf(input.headers);
  const tags = [`HTTP ${String(refusal.status)}`, ...(said?.code ? [said.code] : []), ...(requestId === null ? [] : [`request ${requestId}`])];
  const stated = `${input.words ?? refusal.unsaid(said?.param ?? null)} (${tags.join(', ')})`;
  const message = refusal.next === undefined ? stated : `${stated}; ${refusal.next}`;
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
    const admission = v.safeParse(AdmissionBodySchema, body);
    const refusal = (said?.code ? PLAN_REFUSALS.get(said.code) : undefined) ?? ADMISSION_REFUSALS.get(res.status);
    const words = said?.message ?? (admission.success ? admission.output.detail : null);

    return refusal === undefined ? null : refusalError({ url, refusal, said, words, headers: res.headers, body });
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

const EventSchema = v.object({ type: v.string() });

const FailedSchema = v.object({ response: v.object({ error: v.optional(v.nullable(v.unknown())) }) });

const COMPLETED = 'response.completed';

const INCOMPLETE = 'response.incomplete';

const OUTPUT_LIMIT = 'max_output_tokens';

const ENDED_EARLY = 'ChatGPT ended the stream before response.completed';

const IncompleteSchema = v.object({
  response: v.object({ incomplete_details: v.optional(v.nullable(v.object({ reason: v.optional(v.nullable(v.string())) }))) }),
});

function eventOf(message: EventSourceMessage): { readonly type: string; readonly value: unknown } | null {
  const value = tolerate<unknown>(() => JSON.parse(message.data), 'malformed-input');
  const typed = v.safeParse(EventSchema, value);

  return typed.success ? { type: typed.output.type, value } : null;
}

function streamRefusal(event: { readonly type: string; readonly value: unknown }, url: string, headers: Headers): APICallError | KinuError {
  const failed = v.safeParse(FailedSchema, event.value);
  const said = planErrorOf({ error: failed.success ? failed.output.response.error : event.value });
  const refusal = said?.code ? PLAN_REFUSALS.get(said.code) : undefined;

  if (refusal !== undefined) return refusalError({ url, refusal, said, words: said?.message ?? null, headers, body: event.value });

  return new KinuError('unavailable', `ChatGPT failed the response${said?.code ? ` (${said.code})` : ''}: ${said?.message ?? event.type}`);
}

function incompleteReason(event: { readonly value: unknown }): string {
  const parsed = v.safeParse(IncompleteSchema, event.value);

  return (parsed.success ? parsed.output.response.incomplete_details?.reason : null) ?? 'no reason given';
}

function incompleteFailure(reason: string, headers: Headers): KinuError {
  const requestId = requestIdOf(headers);
  const failure = new KinuError(reason === 'content_filter' ? 'denied' : 'unavailable', `ChatGPT stopped the response short: ${reason}${requestId === null ? '' : ` (request ${requestId})`}`);

  diagnostics.failure('provider.chatgpt_incomplete', failure, { reason, request: requestId ?? '' });

  return failure;
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

      const reason = event?.type === INCOMPLETE ? incompleteReason(event) : null;

      if (reason !== null && reason !== OUTPUT_LIMIT) {
        controller.error(incompleteFailure(reason, res.headers));

        return;
      }

      if (event?.type === COMPLETED || reason === OUTPUT_LIMIT) ended = true;
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

      if (event.type === INCOMPLETE) return yield* Effect.fail(incompleteFailure(incompleteReason(event), res.headers));
      const done = event.type === 'response.output_item.done' ? v.safeParse(OutputItemDoneSchema, event.value) : null;

      if (done?.success === true) items.set(done.output.output_index, done.output.item);
      const finished = event.type === COMPLETED ? v.safeParse(TerminalSchema, event.value) : null;

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

interface PlanCall {
  readonly init: RequestInit | undefined;
  readonly streamed: boolean;
}

function planRequest(init: RequestInit | undefined): PlanCall {
  const text = v.safeParse(v.string(), init?.body);
  const parsed = text.success ? v.safeParse(JsonObjectSchema, tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input')) : null;

  if (parsed?.success !== true) return { init, streamed: true };
  const body = { ...parsed.output };

  for (const field of REFUSED_FIELDS) delete body[field];

  return { init: { ...init, body: JSON.stringify({ ...body, stream: true }) }, streamed: parsed.output.stream === true };
}

function resolvedAuth(deps: ProviderDeps): Effect.Effect<AuthResolution | null, KinuError> {
  return Effect.tryPromise({
    try: () => deps.getAuth(CHATGPT_CRED_KEY),
    catch: (cause) => new KinuError('unavailable', 'the ChatGPT sign-in could not be read', { cause }),
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
        ? "ChatGPT isn't signed in on this machine."
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
        const { init, streamed } = planRequest(requested);
        const url = requestUrl(input);

        // A device's own sign-in renews nowhere from here: its 401 is the answer.
        const deviceLogin = async (_key: string, request?: AuthRequest): Promise<AuthResolution | null> => (request === undefined ? { headers: {} } : null);

        const sendWith = (auth: AuthResolution): Promise<Response> => {
          const merged = copyHeaders(init?.headers);

          for (const [name, value] of Object.entries(auth.headers)) merged.set(name, value);

          return send(input, { ...init, headers: merged });
        };

        return settle(Effect.gen(function* () {
          // A refusal the transport raised is the owner's answer and passes through unchanged.
          const answer = yield* Effect.promise(() => authenticatedSend({
            key: CHATGPT_CRED_KEY, getAuth: device === undefined ? deps.getAuth : deviceLogin, send: sendWith,
          }));

          if (answer.kind === 'absent') return yield* Effect.fail(new KinuError('missing', 'No ChatGPT sign-in with plan usage on this machine'));
          const res = answer.response;
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

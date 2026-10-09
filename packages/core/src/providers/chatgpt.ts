// developers.openai.com/siwc, ADR P1.
import { authenticatedSend, signedSend } from './authenticated-send';
import type { JSONObject, LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, diagnostics, KinuError, settle, tolerate, type ErrorCode } from '../obs/index';
import { accountSession, chatgptCatalogRows, chatgptSessionHeaders, shownCatalogRows } from './codex';
import { asFetchFunction } from './fetch-shim';
import { withCallAccount } from './quota';
import type { AuthRequest, AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { StaleModelList, statelessResponses } from './util';
import { streamedGenerate } from './middleware/stream-generate';
import { heardFetch } from './middleware/attempt';
import { lazyModel } from './wire-model';

export const CHATGPT_BASE_URL = 'https://api.openai.com/v1';

export const CHATGPT_CRED_KEY = 'chatgpt.oauth';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const CHATGPT_DEFAULT_MODEL = 'gpt-6.1-sol';

const CURRENT_CODEX_CLIENT = '0.160.1';

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

const RESPONSES_URL = `${CHATGPT_BASE_URL}/responses`;

function namespacedCall(message: LanguageModelV4Message, functions: ReadonlySet<string>): LanguageModelV4Message {
  if (message.role !== 'assistant') return message;

  return {
    ...message,
    content: message.content.map((part) => (part.type !== 'tool-call' || !functions.has(part.toolName) || part.providerOptions?.openai?.namespace !== undefined
      ? part
      : { ...part, providerOptions: { ...part.providerOptions, openai: { ...part.providerOptions?.openai, namespace: TOOL_NAMESPACE } } })),
  };
}

const PLAN_REQUEST: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }): Promise<LanguageModelV4CallOptions> => {
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

/** A refusal the route answered with this status and body, in its words, or null when it is not one the plan names. */
function refusalFrom(answer: { readonly url: string; readonly status: number; readonly headers: Headers; readonly text: string }): APICallError | null {
  const body = tolerate<unknown>(() => JSON.parse(answer.text), 'malformed-input') ?? answer.text;
  const envelope = v.safeParse(PlanErrorBodySchema, body);
  const said = envelope.success ? planErrorOf({ error: envelope.output.error }) : null;
  const admission = v.safeParse(AdmissionBodySchema, body);
  const refusal = (said?.code ? PLAN_REFUSALS.get(said.code) : undefined) ?? ADMISSION_REFUSALS.get(answer.status);
  const words = said?.message ?? (admission.success ? admission.output.detail : null);

  return refusal === undefined ? null : refusalError({ url: answer.url, refusal, said, words, headers: answer.headers, body });
}

/** The SDK's error for a call the route refused before its stream opened, in the plan's words; a 503 is the model
 *  stack's to wait out and ask again. */
function planRefusal(cause: APICallError): APICallError {
  if (cause.statusCode === undefined || cause.statusCode === 503) return cause;

  return refusalFrom({ url: cause.url, status: cause.statusCode, headers: new Headers(cause.responseHeaders), text: cause.responseBody ?? '' }) ?? cause;
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

/** A raw part's event as the SDK parsed it off the wire. */
function eventOf(part: LanguageModelV4StreamPart): { readonly type: string; readonly value: unknown } | null {
  if (part.type !== 'raw') return null;
  const typed = v.safeParse(EventSchema, part.rawValue);

  return typed.success ? { type: typed.output.type, value: part.rawValue } : null;
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

/** The plan's answer read from the events the SDK parsed (its raw chunks): a failed or filtered answer, or one cut off
 *  before `response.completed` (an output-limit stop aside), fails its stream; a refused call is the plan's refusal. */
function planAnswer(open: () => PromiseLike<LanguageModelV4StreamResult>): Effect.Effect<LanguageModelV4StreamResult> {
  return Effect.gen(function* () {
    const opened = yield* Effect.tryPromise({ try: () => open(), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.die(APICallError.isInstance(cause) ? planRefusal(cause) : cause)),
    );

    const headers = new Headers(opened.response?.headers);
    let ended = false;

    const guard = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform(part, controller) {
        const event = eventOf(part);

        if (event !== null && (event.type === 'response.failed' || event.type === 'error')) {
          controller.error(streamRefusal(event, RESPONSES_URL, headers));

          return;
        }

        const reason = event?.type === INCOMPLETE ? incompleteReason(event) : null;

        if (reason !== null && reason !== OUTPUT_LIMIT) {
          controller.error(incompleteFailure(reason, headers));

          return;
        }

        if (event?.type === COMPLETED || reason === OUTPUT_LIMIT) ended = true;

        // The SDK finishes a stream cut short too.
        if (part.type === 'finish' && !ended) controller.error(new KinuError('unavailable', ENDED_EARLY));
        else controller.enqueue(part);
      },
    });

    return { ...opened, stream: opened.stream.pipeThrough(guard) };
  });
}

function resolvedAuth(deps: ProviderDeps): Effect.Effect<AuthResolution | null, KinuError> {
  return Effect.tryPromise({
    try: () => deps.getAuth(CHATGPT_CRED_KEY),
    catch: (cause) => new KinuError('unavailable', 'the ChatGPT sign-in could not be read', { cause }),
  });
}

export function createChatGptProvider(opts: ChatGptProviderOptions = {}): ModelProvider {
  const { device } = opts;

  /** The machine carries a call only for an account that holds no sign-in of its own. */
  const relayed = async (deps: ProviderDeps): Promise<ChatGptDeviceRoute | null> => (device === undefined || await deps.hasCredential(CHATGPT_CRED_KEY) ? null : device);

  return {
    streamsGenerate: true,
    id: 'chatgpt',
    credentialKey: CHATGPT_CRED_KEY,
    label: 'ChatGPT',
    defaultModel: CHATGPT_DEFAULT_MODEL,

    async isAvailable(deps) {
      const route = await relayed(deps);

      return route === null ? deps.hasCredential(CHATGPT_CRED_KEY) : (await route.unavailableReason()) === undefined;
    },
    async unavailableReason(deps) {
      const route = await relayed(deps);

      return route === null ? "ChatGPT isn't signed in." : route.unavailableReason();
    },

    async listModels(deps) {
      const stale = (reason: string, failure?: KinuError) => new StaleModelList([], { reason: `ChatGPT models could not be read: ${reason}`, cause: failure });

      return settle(Effect.gen(function* () {
        const route = yield* Effect.promise(() => relayed(deps));
        const signed: Effect.Effect<AuthResolution | null, KinuError> = route === null ? resolvedAuth(deps) : Effect.succeed({ headers: {} });
        const auth = yield* signed.pipe(Effect.catch((failure) => Effect.fail(stale(failure.message, failure))));

        if (auth === null) return [];
        const url = `${CHATGPT_BASE_URL}/models?client_version=${CURRENT_CODEX_CLIENT}`;

        const res = yield* attempt({ doing: 'listing the ChatGPT models', otherwise: 'unavailable' }, () => (route?.fetch ?? deps.fetch ?? fetch)(url, { headers: auth.headers }))
          .pipe(Effect.catch((failure) => Effect.fail(stale(failure.message, failure))));

        if (!res.ok) {
          const text = yield* Effect.promise(() => res.text());

          return yield* Effect.fail(stale(refusalFrom({ url, status: res.status, headers: res.headers, text })?.message ?? `api.openai.com answered HTTP ${String(res.status)}`));
        }

        const body: unknown = yield* Effect.promise(() => res.json());

        // OpenAI's rule for this route (developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
        return shownCatalogRows('chatgpt', chatgptCatalogRows({ body }), (visibility) => visibility === 'list').map((row): ModelInfo => row.model);
      }));
    },

    createModel(modelId, deps): LanguageModel {
      // The sign-in and the machine that carry a call: its request and answer are the SDK's, shaped by `PLAN_REQUEST` and
      // read by `planAnswer`.
      const customFetch = asFetchFunction(async (input, init) => {
        const route = await relayed(deps);
        const send = heardFetch(route?.fetch ?? deps.fetch ?? fetch);

        // A device's own sign-in renews nowhere from here: its 401 is the answer.
        const deviceLogin = async (_key: string, request?: AuthRequest): Promise<AuthResolution | null> => (request === undefined ? { headers: {} } : null);

        return settle(Effect.gen(function* () {
          // A refusal the transport raised is the owner's answer and passes through unchanged.
          const answer = yield* Effect.promise(() => authenticatedSend({
            key: CHATGPT_CRED_KEY, getAuth: route === null ? deps.getAuth : deviceLogin, send: signedSend(accountSession(send), input, init),
          }));

          if (answer.kind === 'absent') return yield* Effect.fail(new KinuError('missing', 'No ChatGPT sign-in with plan usage on this machine'));

          return withCallAccount(answer.response, 'chatgpt', CHATGPT_CRED_KEY);
        }));
      });

      const model = lazyModel('openai.responses', modelId, async () => (await import('@ai-sdk/openai'))
        .createOpenAI({ baseURL: CHATGPT_BASE_URL, apiKey: 'chatgpt-plan', headers: chatgptSessionHeaders(deps), fetch: customFetch })
        .responses(modelId));

      return wrapLanguageModel({ model, middleware: [statelessResponses(true), PLAN_REQUEST, streamedGenerate, {
        specificationVersion: 'v4',
        transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
        wrapStream: ({ doStream }) => settle(planAnswer(doStream)),
      }] });
    },
  };
}

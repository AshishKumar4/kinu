// Shared provider internals: the auth-injecting fetch wrapper and catalog parse helpers.
import type { LanguageModelV3Message } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { withRateLimitRetry } from './rate-limit-retry';
import { withCallAccount } from './quota';
import { evidenceWindow } from '../prompts/evidence-window';
import * as v from 'valibot';
import { nonEmptyString } from '../utils/json';
import {
  KinuError, classifyErrorCode, diagnostics, tolerate, type ErrorCode,
} from '../obs/index';

export interface AuthedFetchOptions {
  /** Credential key passed to the AuthResolver on every request. */
  credKey: string;
  /** Named in rate-limit wait notices. */
  provider: string;
  /** Absent for the count-endpoint wrapper. */
  modelId?: string;
  /** 401 JSON body `error` text when no credential is configured. */
  missingCredentialError: string;
  /** Reject (401) when the credential lacks a baseURL (openai-compat). */
  requireBaseURL?: boolean;
  /** Adjust headers and/or return a replacement URL after auth injection. */
  mutate?: (ctx: { url: string; headers: Headers; auth: AuthResolution }) => string | void;
}

/** Auth-injecting fetch; auth is re-resolved per request so credential changes apply live. */
export function createAuthedFetch(deps: ProviderDeps, opts: AuthedFetchOptions): typeof globalThis.fetch {
  const waitListener = deps.onProviderWait;

  const retrying = (lane: string): typeof globalThis.fetch => withRateLimitRetry(deps.fetch ?? fetch, {
    provider: opts.provider,
    lane,
    ...(opts.modelId !== undefined && { modelId: opts.modelId }),
    ...(waitListener !== undefined && { onWait: waitListener }),
  });

  return asFetchFunction(async (input, init) => {
    const resolved = await deps.getAuth(opts.credKey);

    if (!resolved || (opts.requireBaseURL && !resolved.baseURL)) {
      return new Response(
        JSON.stringify({ error: opts.missingCredentialError }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const auth = resolved;

    const headers = copyHeaders(init?.headers);

    for (const [name, value] of Object.entries(auth.headers)) headers.set(name, value);
    const url = input instanceof Request ? input.url : input.toString();
    const rewritten = opts.mutate?.({ url, headers, auth });

    const paid = auth.credentialKey ?? opts.credKey;

    return withCallAccount(await retrying(paid)(rewritten ?? input, { ...init, headers }), opts.provider, paid);
  });
}

/** As opencode's client: nothing stored, steps sent whole, effort for ids the SDK's allowlist misses. */
export function statelessResponses(reasoning: boolean): LanguageModelMiddleware {
  const stateless = reasoning ? { store: false, forceReasoning: true } : { store: false };

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: params.prompt.map(withoutItemIds),
      providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, ...stateless } },
    }),
  };
}

function withoutItemIds(message: LanguageModelV3Message): LanguageModelV3Message {
  if (message.role !== 'assistant') return message;

  return {
    ...message,
    content: message.content.map((part) => {
      const { itemId, ...openai } = part.providerOptions?.openai ?? {};

      return itemId === undefined ? part : { ...part, providerOptions: { ...part.providerOptions, openai } };
    }),
  };
}

/** Credential identity for keying catalog caches. */
export function authCacheKey(auth: AuthResolution): string {
  return JSON.stringify([auth.headers, auth.baseURL ?? null]);
}

/** An unreadable live model list: the built-in list stands in, and the registry reports why. */
export class StaleModelList extends KinuError {
  readonly reason: string;

  constructor(readonly models: readonly ModelInfo[], options: { readonly reason: string; readonly cause?: unknown }) {
    super('unavailable', `${options.reason}; showing the built-in list`, { cause: options.cause });
    this.reason = options.reason;
  }
}

/** A list read live, or the stand-in a `StaleModelList` carries; any other failure propagates. */
export async function settleModelList(
  list: Promise<ModelInfo[]> | ModelInfo[],
): Promise<{ readonly models: readonly ModelInfo[]; readonly stale: StaleModelList | null }> {
  try {
    return { models: await list, stale: null };
  } catch (error) {
    if (!(error instanceof StaleModelList)) throw error;

    return { models: error.models, stale: error };
  }
}

export async function mapModelList(list: Promise<ModelInfo[]>, map: (models: readonly ModelInfo[]) => ModelInfo[]): Promise<ModelInfo[]> {
  const { models, stale } = await settleModelList(list);

  if (stale !== null) throw new StaleModelList(map(models), { reason: stale.reason, cause: stale.cause });

  return map(models);
}

export function cloneModelInfos(models: readonly ModelInfo[] | undefined): ModelInfo[] {
  return (models ?? []).map((model) => ({
    ...model,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    cost: model.cost ? { ...model.cost } : undefined,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
  }));
}

/** One model's catalog entry, or null when unknown. An unreadable catalog throws, so
 *  "models.dev is down" is not mistaken for "no such model". */
export async function catalogModelInfo(
  provider: Pick<ModelProvider, 'listModels'> | undefined,
  deps: ProviderDeps,
  modelId: string,
): Promise<ModelInfo | null> {
  if (!provider) return null;

  const { models } = await settleModelList(provider.listModels(deps));

  return models.find((m) => m.id === modelId) ?? null;
}

export function positiveInteger(input: { value: unknown }): number | undefined {
  const parsed = v.safeParse(v.pipe(v.number(), v.finite(), v.gtValue(0)), input.value);

  return parsed.success ? Math.floor(parsed.output) : undefined;
}

/** Nested `{ error: … }` depth: OpenAI nests once, gateways re-wrap. */
const PROVIDER_ERROR_MAX_DEPTH = 3;

const PROVIDER_ERROR_MAX_CHARS = 800;

/** Structural `APICallError` fields, so a gateway's re-thrown shape reads the same. */
const ApiCallErrorSchema = v.looseObject({
  statusCode: v.optional(v.number()),
  responseBody: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
});

/** Stream `error` chunks carry a status without being an `Error`. */
const StatusFieldSchema = v.looseObject({
  status: v.optional(v.number()),
  statusCode: v.optional(v.number()),
});

/** Provider failure facts as fields, so consumers never re-match prose. */
export interface ProviderFailureFacts {
  /** Safe to show a user; never a raw response body. */
  readonly message: string;
  /** The provider's stable error code (`code`, else `type`), verbatim. */
  readonly providerCode?: string;
  readonly status?: number;
}

/** Read a provider failure (often a plain object, not an `Error`) down to its facts.
 *  A response body is parsed, never forwarded: it may echo the request's headers. */
export function providerFailureFacts(failure: { readonly cause: unknown }): ProviderFailureFacts {
  return readProviderFailure({ cause: failure.cause, depth: 0 })
    ?? { message: 'unknown provider error' };
}

/** Null when nothing readable, so a caller keeps the reason it already had. */
function readProviderFailure(
  input: { readonly cause: unknown; readonly depth: number },
): ProviderFailureFacts | null {
  const { cause: error, depth } = input;

  if (error instanceof Error) {
    const envelope = v.safeParse(ApiCallErrorSchema, error);
    const status = envelope.success ? envelope.output.statusCode : undefined;
    const body = envelope.success ? envelope.output.responseBody : undefined;

    // The reason lives in the body; `||` because an empty message says nothing.
    const parsed = body === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
      ? undefined
      : tolerate<unknown>(() => JSON.parse(body), 'malformed-input');

    const fromBody = parsed === undefined
      ? null
      : readProviderFailure({ cause: parsed, depth: depth + 1 });

    return {
      message: fromBody?.message ?? (error.message || error.name),
      providerCode: fromBody?.providerCode,
      status,
    };
  }

  const text = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), error);

  if (text.success) return { message: text.output };

  if (v.is(v.string(), error)) return null;

  // Shallow, not `JsonObject`: the recursive schema overflows on self-referencing errors.
  const record = v.safeParse(v.record(v.string(), v.unknown()), error);

  if (!record.success) return null;

  const fields = record.output;
  const status = v.safeParse(StatusFieldSchema, fields);
  const reported = status.success ? status.output.status ?? status.output.statusCode : undefined;
  const providerCode = nonEmptyString({ value: fields.code }) ?? nonEmptyString({ value: fields.type });

  const stated = nonEmptyString({ value: fields.message })
    ?? nonEmptyString({ value: fields.error_description })
    ?? nonEmptyString({ value: fields.detail });

  // Gateways stamp code and status on the outer envelope.
  const nested = stated !== undefined || fields.error === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
    ? null
    : readProviderFailure({ cause: fields.error, depth: depth + 1 });

  // Name the keys, never the values: the values may leak.
  const named = Object.keys(fields).join(', ') || 'no fields';

  return {
    message: stated ?? nested?.message ?? `unrecognised provider error (fields: ${named})`,
    providerCode: nested?.providerCode ?? providerCode,
    status: nested?.status ?? reported,
  };
}

/** Reason plus identifiers it does not already state, bounded by `evidenceWindow`
 *  since the useful sentence is usually last. */
export function describeProviderError(failure: { readonly cause: unknown }): string {
  const facts = providerFailureFacts({ cause: failure.cause });
  const tags: string[] = [];

  if (facts.status !== undefined) tags.push(`HTTP ${String(facts.status)}`);
  const code = facts.providerCode;

  if (code !== undefined && !facts.message.toLowerCase().includes(code.toLowerCase())) tags.push(code);
  const rendered = tags.length > 0 ? `${facts.message} (${tags.join(', ')})` : facts.message;

  return evidenceWindow(rendered, PROVIDER_ERROR_MAX_CHARS);
}

/** HTTP status to `obs/error.ts` class; null when the status says nothing. */
function codeForStatus(status: number): ErrorCode | null {
  if (status === 401 || status === 402 || status === 403) return 'denied';

  if (status === 404) return 'missing';

  if (status === 408 || status === 504) return 'timeout';

  if (status === 400 || status === 413 || status === 422) return 'bad_input';

  if (status === 429 || status >= 500) return 'unavailable';

  return null;
}

/** Classified Kinu error whose message carries only code, facts, and a generic sentence;
 *  provider prose is unsafe there and stays on `cause` and diagnostics. */
export function toProviderError(input: {
  doing: string;
  cause: unknown;
  /** The provider the request was sent to, when the caller resolved one. */
  provider?: string;
}): KinuError {
  const facts = providerFailureFacts({ cause: input.cause });

  const code = classifyErrorCode({ cause: input.cause })
    ?? (facts.status === undefined ? null : codeForStatus(facts.status))
    ?? 'unavailable';

  const tags: string[] = [];

  if (facts.status !== undefined) tags.push(`HTTP ${String(facts.status)}`);

  if (facts.providerCode !== undefined) tags.push(facts.providerCode);

  if (input.provider !== undefined) tags.push(input.provider);

  /** The fields the diagnostics record carries beside the error itself. */
  interface ProviderFailureFields {
    detail: string;
    status?: number;
    providerCode?: string;
    provider?: string;
  }

  const fields: ProviderFailureFields = {
    detail: describeProviderError({ cause: input.cause }),
  };

  if (facts.status !== undefined) fields.status = facts.status;

  if (facts.providerCode !== undefined) fields.providerCode = facts.providerCode;

  if (input.provider !== undefined) fields.provider = input.provider;

  const error = new KinuError(
    code,
    `${input.doing}: the provider refused the request${tags.length > 0 ? ` (${tags.join(', ')})` : ''}.`,
    { cause: input.cause },
  );

  diagnostics.failure('provider.request_failed', error, fields);

  return error;
}

/** "131k" / "1M" / "1.05M"; null when unknown. */
export function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;

  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;

    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
  }

  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;

  return String(tokens);
}

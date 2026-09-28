import type { LanguageModelV3Message } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { withRateLimitRetry } from './rate-limit-retry';
import { withCallAccount } from './quota';
import { describeProviderError, readProviderFailure } from './provider-prose';
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  KinuError, classifyErrorCode, diagnostics, settle, type ErrorCode,
} from '../obs/index';

export interface AuthedFetchOptions {
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

/** Auth is re-resolved per request so credential changes apply live. */
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

type SettledModelList = { readonly models: readonly ModelInfo[]; readonly stale: StaleModelList | null };

export async function settleModelList(list: Promise<ModelInfo[]> | ModelInfo[]): Promise<SettledModelList> {
  return settle(modelList(list));
}

function modelList(list: Promise<ModelInfo[]> | ModelInfo[]): Effect.Effect<SettledModelList> {
  return Effect.tryPromise({ try: async (): Promise<SettledModelList> => ({ models: await list, stale: null }), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => (failed.cause instanceof StaleModelList
      ? Effect.succeed({ models: failed.cause.models, stale: failed.cause })
      : Effect.die(failed.cause))),
  );
}

export async function mapModelList(list: Promise<ModelInfo[]>, map: (models: readonly ModelInfo[]) => ModelInfo[]): Promise<ModelInfo[]> {
  return settle(Effect.flatMap(modelList(list), ({ models, stale }) => (stale === null
    ? Effect.succeed(map(models))
    : Effect.fail(new StaleModelList(map(models), { reason: stale.reason, cause: stale.cause })))));
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
  const parsed = v.safeParse(v.pipe(v.number(), v.finite(), v.minValue(1)), input.value);

  return parsed.success ? Math.floor(parsed.output) : undefined;
}

export interface ProviderFailureFacts {
  readonly said?: string;
  readonly providerCode?: string;
  readonly status?: number;
}

/** A code field carrying prose is dropped. */
const PROVIDER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/u;

export function providerFailureFacts(failure: { readonly cause: unknown }): ProviderFailureFacts {
  const { said, providerCode, status } = readProviderFailure(failure);

  return {
    ...(said !== undefined && { said }),
    ...(providerCode !== undefined && PROVIDER_CODE.test(providerCode) && { providerCode }),
    ...(status !== undefined && { status }),
  };
}

export function providerFailureTags(facts: ProviderFailureFacts): string[] {
  const tags: string[] = [];

  if (facts.status !== undefined) tags.push(`HTTP ${String(facts.status)}`);

  if (facts.providerCode !== undefined) tags.push(facts.providerCode);

  return tags;
}

/** The one way a provider failure reaches a user as text. */
export function providerFailureText(failure: { readonly cause: unknown }): string {
  const facts = providerFailureFacts(failure);
  const tags = providerFailureTags(facts);

  return `${facts.said ?? 'the provider refused the request'}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
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
  provider?: string;
}): KinuError {
  const facts = providerFailureFacts({ cause: input.cause });

  const code = classifyErrorCode({ cause: input.cause })
    ?? (facts.status === undefined ? null : codeForStatus(facts.status))
    ?? 'unavailable';

  const tags = providerFailureTags(facts);

  if (input.provider !== undefined) tags.push(input.provider);

  interface ProviderFailureFields {
    detail: string;
    status?: number;
    providerCode?: string;
    provider?: string;
  }

  const read = readProviderFailure({ cause: input.cause });

  const fields: ProviderFailureFields = {
    detail: describeProviderError({ cause: input.cause }),
  };

  if (read.status !== undefined) fields.status = read.status;

  if (read.providerCode !== undefined) fields.providerCode = read.providerCode;

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

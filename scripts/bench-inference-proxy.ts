import * as v from 'valibot';
import { createChatModel, parseJsonValue, type JsonValue, type LLMProviderConfig } from '../packages/core/src/index';
import type { LanguageModel } from 'ai';
import { tolerate } from '../packages/core/src/obs/index';

/** The static chat model for an explicit bench endpoint. A bench NAMES its
 *  endpoint through the metering proxy; it does not resolve one, so this is
 *  plain construction — no registry, no defaults. */
export function benchChatModel(config: LLMProviderConfig): LanguageModel {
  return createChatModel({
    kind: config.name === 'anthropic' ? 'anthropic' : 'openai-compat',
    name: config.name,
    baseURL: config.baseURL,
    headers: config.headers,
    modelId: config.model,
  });
}

const TokenCountSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const UsageSchema = v.object({
  prompt_tokens: v.optional(TokenCountSchema),
  completion_tokens: v.optional(TokenCountSchema),
  total_tokens: v.optional(TokenCountSchema),
  input_tokens: v.optional(TokenCountSchema),
  output_tokens: v.optional(TokenCountSchema),
  inputTokens: v.optional(TokenCountSchema),
  outputTokens: v.optional(TokenCountSchema),
});
const ResponseEnvelopeSchema = v.object({
  usage: v.optional(UsageSchema),
  result: v.optional(v.object({ usage: v.optional(UsageSchema) })),
});

interface CallUsage {
  tokens: number;
  promptTokens: number;
}

export interface BenchInferenceUsage {
  calls: number;
  tokens: number;
  peakPromptTokens: number;
  unmeteredResponses: number;
}

export interface BenchInferenceProxy {
  /** OpenAI-compatible base URL supplied to every model in the attempt. */
  baseURL: string;
  /** Route a registered upstream through this attempt's shared meter. */
  baseURLFor(upstreamBaseURL: string): string;
  usage(): BenchInferenceUsage;
  /** Wait until every cloned response body has been inspected. */
  settle(): Promise<void>;
  stop(closeActiveConnections?: boolean): void;
}

export interface BenchInferenceProxyOptions {
  upstreamBaseURL: string;
  additionalUpstreamBaseURLs?: readonly string[];
  maxTokens: number;
  onBreach?: () => void;
}

function usageOf(value: JsonValue): CallUsage | null {
  const parsed = v.safeParse(ResponseEnvelopeSchema, value);
  if (!parsed.success) return null;
  const usage = parsed.output.usage ?? parsed.output.result?.usage;
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens;
  if (promptTokens === undefined || (completionTokens === undefined && usage.total_tokens === undefined)) return null;
  const derivedTotal = promptTokens + (completionTokens ?? 0);
  if (usage.total_tokens !== undefined && completionTokens !== undefined && usage.total_tokens !== derivedTotal) return null;
  const tokens = usage.total_tokens ?? derivedTotal;
  return { tokens, promptTokens };
}

function usagesFromBody(body: string): CallUsage[] {
  const usages: CallUsage[] = [];
  const record = (raw: string): void => {
    if (!raw || raw === '[DONE]') return;
    // A body fragment is JSON when it carries an envelope and plain text otherwise.
    const value = tolerate(() => parseJsonValue(raw), 'malformed-input');
    if (value === undefined) return;
    const usage = usageOf(value);
    if (usage) usages.push(usage);
  };

  record(body.trim());
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) record(line.slice('data:'.length).trim());
  }
  return usages;
}

function upstreamURL(base: URL, incoming: URL): URL {
  const target = new URL(base);
  target.pathname = `${base.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(/^\//, '')}`;
  for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
  return target;
}

/**
 * One process-local request meter for an entire attempt. Pointing every model
 * config at it makes root turns, Pi turns, heads, MCTS branches, judges and
 * subprocess agents share the same counter without changing production model
 * seams. A successful response with no provider usage is recorded as invalid
 * evidence rather than silently counted as zero.
 */
export function createBenchInferenceProxy(opts: BenchInferenceProxyOptions): BenchInferenceProxy {
  const upstreams: URL[] = [];
  const routeByUpstream = new Map<string, number>();
  const upstreamKey = (raw: string): string => new URL(raw).href.replace(/\/$/, '');
  for (const raw of [opts.upstreamBaseURL, ...(opts.additionalUpstreamBaseURLs ?? [])]) {
    const key = upstreamKey(raw);
    if (routeByUpstream.has(key)) continue;
    routeByUpstream.set(key, upstreams.length);
    upstreams.push(new URL(raw));
  }
  const pending = new Set<Promise<void>>();
  const state: BenchInferenceUsage = {
    calls: 0,
    tokens: 0,
    peakPromptTokens: 0,
    unmeteredResponses: 0,
  };
  let breached = false;

  const inspect = async (response: Response): Promise<void> => {
    if (!response.ok) return;
    const callUsages = usagesFromBody(await response.text());
    if (callUsages.length === 0) {
      state.unmeteredResponses++;
      return;
    }

    // Providers sometimes repeat terminal usage in multiple SSE events. One
    // HTTP response is one inference call, so take its largest terminal total.
    const usage = callUsages.reduce((largest, next) => next.tokens > largest.tokens ? next : largest);
    state.tokens += usage.tokens;
    state.peakPromptTokens = Math.max(state.peakPromptTokens, ...callUsages.map((entry) => entry.promptTokens));
    if (state.tokens > opts.maxTokens && !breached) {
      breached = true;
      opts.onBreach?.();
    }
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (breached) return new Response('bench token budget exhausted', { status: 429 });
      const incoming = new URL(request.url);
      const route = /^\/__bench_upstream\/(\d+)(\/.*)?$/.exec(incoming.pathname);
      const routeIndex = route ? Number(route[1]) : Number.NaN;
      const upstream = upstreams[routeIndex];
      if (!upstream) return new Response('unknown bench inference upstream', { status: 400 });
      incoming.pathname = route?.[2] ?? '/';
      state.calls++;
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      let response: Response;
      try {
        response = await fetch(upstreamURL(upstream, incoming), {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
          redirect: 'manual',
          signal: request.signal,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return new Response(`bench inference upstream failed: ${detail}`, { status: 502 });
      }

      const task = inspect(response.clone())
        .catch(() => { if (response.ok) state.unmeteredResponses++; })
        .finally(() => pending.delete(task));
      pending.add(task);
      return response;
    },
  });

  const baseURLFor = (raw: string): string => {
    const route = routeByUpstream.get(upstreamKey(raw));
    if (route === undefined) throw new Error(`bench inference upstream was not registered: ${raw}`);
    return `http://127.0.0.1:${server.port}/__bench_upstream/${route}`;
  };

  return {
    baseURL: baseURLFor(opts.upstreamBaseURL),
    baseURLFor,
    usage: () => ({ ...state }),
    async settle() {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
  };
}

/**
 * A stable prefix reads back as a NONZERO cache hit — the missing half of the
 * cache contract (docs/ARCHITECTURE-DECISIONS.md O1). contract-cache-markers
 * proves the addressing lands on the wire; this file proves the addressing
 * pays off, in the only currency a caller can observe: the accumulated
 * `Usage.cacheRead` a three-step turn (tool call, tool call, continuation)
 * leaves in the TurnAccumulator.
 *
 * The method: runChat drives each real provider adapter against a mocked
 * fetch, and the mock carries the provider's prompt cache. Every request is
 * first reduced to its canonical cacheable unit — the prompt chain with the
 * addressing fields (`cache_control` markers, `prompt_cache_key`,
 * `x-session-affinity`) stripped, since those are cache bookkeeping rather
 * than prompt bytes — then judged by that provider's own cache model. A
 * request reports a nonzero read when, and only when, its deepest addressed
 * prefix continues a previous request's addressed prefix byte for byte on
 * the same route. That predicate, not a number baked into a fixture, is what
 * this gate proves about Kinu: the prefix engineering held.
 *
 * The predicate per provider, stated from its own docs:
 *   - anthropic / openrouter-claude: `cache_control` breakpoints; a request
 *     stores the prefix ending at its last breakpoint and a later request
 *     reads the longest stored prefix it still begins with. Modelled
 *     all-or-nothing — the read counter is the WHOLE stored prefix or zero,
 *     where a real cache also serves partial hits below a mutation.
 *     https://docs.claude.com/en/docs/build-with-claude/prompt-caching and
 *     https://openrouter.ai/docs/guides/best-practices/prompt-caching
 *     (cache_control pass-through to Claude upstreams).
 *   - openai / codex (Responses API): `prompt_cache_key` routes the lookup;
 *     the cached unit is the full prompt (instructions + tools + input).
 *     https://platform.openai.com/docs/guides/prompt-caching
 *   - my-gateway / ai-gateway / openai-compat: the same routing through the
 *     provider's own options namespace, spread onto the body as
 *     `prompt_cache_key`; no provider doc — the premise is the strategy
 *     map's, and the read field is the shared openai-compatible one.
 *   - workers-ai: `x-session-affinity` pins a replica whose default-on prefix
 *     cache keys the request bytes; no public doc — measured by live
 *     two-shot probes (cf-backend/src/providers/workers-ai-catalog.ts,
 *     2026-08-15).
 *   - a provider the map gives nothing (no key, no marker, no header) can
 *     never read anything back, whatever it reports.
 */

import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import {
  runChat,
  createAnthropicProvider, createOpenAIProvider, createCodexProvider,
  createOpenRouterProvider, createOpenAICompatProvider,
  createWorkersAIProvider,
  DynamicContextLedger, type DynamicContext,
  markLastToolForAnthropicCache,
  TurnAccumulator, ExtensionHost,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY, CODEX_CRED_KEY,
  JsonObjectSchema, JsonValueSchema, parseJsonObject,
  type JsonObject, type JsonValue, type KinuExtension, type Usage,
  type ProviderDeps, type AuthResolution,
} from '../src/index';
import { createMockFetch, type MockFetchHandle, type RecordedRequest } from '@kinu.run/test-utils';

/* ── The provider-cache oracle ───────────────────────────────────────────── */

interface WireView {
  /** The route the cache lives behind: a prompt-cache key, an affinity
   *  header, or undefined where the cache is unkeyed. A request on a
   *  different route sees an empty cache. */
  route?: string;
  /** The canonical prompt chain this request addresses, in the provider's
   *  prefix order — per tool, per system block, then per wire content part
   *  (Anthropic), per wire message (chat-completions), or per input item
   *  (Responses API). Marker dialects end the chain at the LAST element
   *  carrying a breakpoint; key-routed dialects take the whole chain. */
  elements: string[];
}

/** The fields that address the cache rather than carry prompt bytes. */
const ADDRESSING_KEYS = new Set(['cache_control', 'cacheControl', 'prompt_cache_key', 'prompt_cache_retention']);

const JsonPrimitiveSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** JSON.stringify minus every addressing key, recursively — the prompt bytes
 *  a cache lookup would hash. `value` is wire JSON already; `JsonValue` is
 *  the domain type the body schemas deliver. */
function canon(value: JsonValue): string {
  if (v.is(JsonPrimitiveSchema, value)) return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;

  return `{${Object.entries(value)
    .filter(([key]) => !ADDRESSING_KEYS.has(key))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canon(entry)}`)
    .join(',')}}`;
}

/** Whether an element carries a `cache_control` breakpoint anywhere inside —
 *  provider-level on a tool, block-level on a system block, last-part-level
 *  on a message part. Our own fixtures never embed the literal in content. */
function marked(value: JsonValue): boolean {
  return JSON.stringify(value).includes('"cache_control"');
}

/** chars/4 — the scale the context budget already prices on. The figure is
 *  fabricated only in that the real provider tokenizes; the gate is
 *  zero-versus-nonzero, which this preserves. */
function tokensOf(elements: readonly string[]): number {
  return Math.max(1, Math.round(elements.join('').length / 4));
}

interface Verdict { read: number; write: number }

/**
 * One provider's prompt cache, modelled on the request stream it is fed.
 * `stored` is the previous request's addressed prefix; a request reads only
 * when its own addressed region contains that prefix byte for byte — the
 * strictest honest reading of "the prefix is stable".
 */
class PrefixCacheOracle {
  private stored: { route?: string; elements: string[] } | undefined;

  submit(view: WireView): Verdict {
    const previous = this.stored;

    const hit = previous !== undefined
      && previous.route === view.route
      && previous.elements.length <= view.elements.length
      && previous.elements.every((element, index) => element === view.elements[index]);

    if (view.elements.length > 0) {
      this.stored = { route: view.route, elements: view.elements };
    }

    return hit && previous !== undefined
      ? { read: tokensOf(previous.elements), write: Math.max(0, tokensOf(view.elements) - tokensOf(previous.elements)) }
      : { read: 0, write: tokensOf(view.elements) };
  }
}

/* ── Canonical wire views, one per dialect ───────────────────────────────── */

const AnthropicBodySchema = v.looseObject({
  tools: v.optional(v.array(JsonValueSchema)),
  system: v.optional(v.union([v.string(), v.array(JsonValueSchema)])),
  messages: v.optional(v.array(JsonValueSchema)),
});

/** Anthropic: tools + system blocks + message content parts, prefix order,
 *  addressed through the last element carrying a breakpoint. */
function anthropicView(body: JsonObject): WireView {
  const parsed = v.parse(AnthropicBodySchema, body);
  const elements: string[] = [];
  const marks: boolean[] = [];

  for (const wireTool of parsed.tools ?? []) {
    elements.push(`tool:${canon(wireTool)}`);
    marks.push(marked(wireTool));
  }

  const systemBlocks = v.is(v.string(), parsed.system) ? [parsed.system] : (parsed.system ?? []);

  for (const block of systemBlocks) {
    elements.push(`system:${canon(block)}`);
    marks.push(marked(block));
  }

  for (const message of parsed.messages ?? []) {
    if (!v.is(JsonObjectSchema, message)) continue;

    const content = message.content;

    if (content === undefined) continue;

    for (const part of Array.isArray(content) ? content : [content]) {
      elements.push(`part:${canon(part)}`);
      marks.push(marked(part));
    }
  }

  let last = -1;

  for (const [index, flag] of marks.entries()) {
    if (flag) last = index;
  }

  return { elements: elements.slice(0, last + 1) };
}

const CompatBodySchema = v.looseObject({
  prompt_cache_key: v.optional(v.unknown()),
  messages: v.optional(v.array(JsonValueSchema)),
});

/**
 * Chat-completions wire (openrouter, gateways, openai-compat, workers-ai):
 * one head element for the fixed fields (model, params), then one per wire
 * message — the system prompt rides as a message here. On a marker dialect
 * the addressed region ends at the last message carrying `cache_control`,
 * and a request that marks nothing addresses nothing.
 */
function compatView(body: JsonObject, request: RecordedRequest, markers: boolean): WireView {
  const parsed = v.parse(CompatBodySchema, body);
  const { messages, prompt_cache_key: _key, ...rest } = parsed;
  // `rest` came out of a JsonObject body minus two keys — still JsonObject.
  const head = v.parse(JsonObjectSchema, rest);
  const all: string[] = [`head:${canon(head)}`];
  const marks: boolean[] = [];

  for (const message of messages ?? []) {
    all.push(`msg:${canon(message)}`);
    marks.push(marked(message));
  }

  const route = v.is(v.string(), parsed.prompt_cache_key)
    ? parsed.prompt_cache_key
    : request.headers['x-session-affinity'];

  if (!markers) return { route, elements: all };

  let last = -1;

  for (const [index, flag] of marks.entries()) {
    if (flag) last = index;
  }

  return { route, elements: all.slice(0, last + 2) };
}

const ResponsesBodySchema = v.looseObject({
  instructions: v.optional(v.unknown()),
  tools: v.optional(v.array(JsonValueSchema)),
  input: v.optional(v.array(JsonValueSchema)),
  prompt_cache_key: v.optional(v.unknown()),
});

/** Responses API (openai + codex): instructions, tools, then input items. */
function responsesView(body: JsonObject): WireView {
  const parsed = v.parse(ResponsesBodySchema, body);
  const elements: string[] = [];

  if (v.is(v.string(), parsed.instructions)) elements.push(`instructions:${JSON.stringify(parsed.instructions)}`);

  for (const wireTool of parsed.tools ?? []) elements.push(`tool:${canon(wireTool)}`);

  for (const item of parsed.input ?? []) elements.push(`item:${canon(item)}`);

  return {
    route: v.is(v.string(), parsed.prompt_cache_key) ? parsed.prompt_cache_key : undefined,
    elements,
  };
}

/* ── Streamed reply shapes, per dialect ──────────────────────────────────── */

/** Anthropic usage: read + write split the request's prompt into served and
 *  stored. The decoy keeps the whole count on the WRITE counter. */
function anthropicUsage(verdict: Verdict, decoy: boolean): JsonObject {
  return {
    input_tokens: 12,
    output_tokens: 6,
    cache_read_input_tokens: decoy ? 0 : verdict.read,
    cache_creation_input_tokens: decoy ? verdict.read + verdict.write : verdict.write,
  };
}

/** Responses API usage. The decoy lands the count on the sibling detail
 *  fields — `orchestration_input_cached_tokens`, which the normaliser has no
 *  business reading, and `reasoning_tokens` on the output side. */
function responsesUsage(verdict: Verdict, decoy: boolean): JsonObject {
  const details: JsonObject = { cached_tokens: decoy ? 0 : verdict.read };

  if (decoy) details.orchestration_input_cached_tokens = verdict.read;

  return {
    input_tokens: 12 + verdict.read + verdict.write,
    output_tokens: 6,
    total_tokens: 18 + verdict.read + verdict.write,
    input_tokens_details: details,
    output_tokens_details: { reasoning_tokens: decoy ? verdict.read : 0 },
  };
}

/** Chat-completions usage, same decoy: the count rides the output-side
 *  reasoning detail while the read detail says 0. */
function compatUsage(verdict: Verdict, decoy: boolean): JsonObject {
  return {
    prompt_tokens: 12 + verdict.read + verdict.write,
    completion_tokens: 6,
    total_tokens: 18 + verdict.read + verdict.write,
    prompt_tokens_details: {
      cached_tokens: decoy ? 0 : verdict.read,
      cache_write_tokens: verdict.write,
    },
    completion_tokens_details: { reasoning_tokens: decoy ? verdict.read : 0 },
  };
}

/** A provider that never addresses a cache reports plain usage. */
const SILENT_USAGE: JsonObject = { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 };

function anthropicSse(step: number, usage: JsonObject): string {
  const frames: Array<readonly [string, JsonObject]> = [
    ['message_start', {
      type: 'message_start',
      message: { id: `msg_${step}`, type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage },
    }],
  ];

  if (step < 2) {
    frames.push(
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${step}`, name: 'probe' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"x":${step}}` } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } }],
    );
  } else {
    frames.push(
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'settled' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
    );
  }

  frames.push(['message_stop', { type: 'message_stop' }]);

  return `${frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

/** Responses API stream: function_call items on tool steps, a message item on
 *  the last, `response.completed` carrying usage. */
function responsesSse(step: number, usage: JsonObject): string {
  const events: JsonObject[] = [
    { type: 'response.created', response: { id: `resp_${step}`, created_at: 1700000000, model: 'gpt-5.5' } },
  ];

  if (step < 2) {
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: `fc_${step}`, call_id: `call_probe_${step}`, name: 'probe', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: `fc_${step}`, call_id: `call_probe_${step}`, name: 'probe', arguments: `{"x":${step}}`, status: 'completed' } },
    );
  } else {
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${step}` } },
      { type: 'response.output_text.delta', item_id: `msg_${step}`, delta: 'settled' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${step}` } },
    );
  }

  events.push({ type: 'response.completed', response: { incomplete_details: null, usage } });

  return events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Chat-completions stream: a tool_calls delta on tool steps, usage on the
 *  finish chunk, `[DONE]`. */
function compatSse(step: number, usage: JsonObject): string {
  const chunk = (delta: JsonObject, finish: string | null, usageChunk?: JsonObject) => {
    const frame: JsonObject = {
      id: `cmpl_${step}`, object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }],
    };

    if (usageChunk !== undefined) frame.usage = usageChunk;

    return `data: ${JSON.stringify(frame)}\n\n`;
  };

  const body = step < 2
    ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${step}`, function: { name: 'probe', arguments: `{"x":${step}}` } }] }, null)
      + chunk({}, 'tool_calls', usage)
    : chunk({ role: 'assistant', content: 'settled' }, null)
      + chunk({}, 'stop', usage);

  return `${body}data: [DONE]\n\n`;
}

/* ── The provider table ──────────────────────────────────────────────────── */

type WireDialect = 'anthropic' | 'responses' | 'compat';

interface ProviderCase {
  label: string;
  /** The registry id the cache map resolves. */
  providerId: string;
  modelId: string;
  dialect: WireDialect;
  /** Chat-completions rows only: whether the strategy places markers. */
  markers?: boolean;
  /** The provider addresses no cache at all — the mock answers plain usage. */
  unaddressed?: boolean;
  credentials: Record<string, AuthResolution>;
  model: (deps: ProviderDeps) => LanguageModel;
}

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));

  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

const SESSION_KEY = 'kinu-cache-hit-gate';

const CACHING_PROVIDERS: readonly ProviderCase[] = [
  {
    label: 'anthropic', providerId: 'anthropic', modelId: 'claude-opus-4-7', dialect: 'anthropic',
    credentials: { [ANTHROPIC_CRED_KEY]: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } } },
    model: (deps) => createAnthropicProvider().createModel('claude-opus-4-7', deps),
  },
  {
    label: 'openai', providerId: 'openai', modelId: 'gpt-5.5', dialect: 'responses',
    credentials: { [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } },
    model: (deps) => createOpenAIProvider().createModel('gpt-5.5', deps),
  },
  {
    label: 'codex', providerId: 'codex', modelId: 'gpt-5.5', dialect: 'responses',
    credentials: { [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } } },
    model: (deps) => createCodexProvider().createModel('gpt-5.5', deps),
  },
  {
    label: 'openrouter-claude', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6',
    dialect: 'compat', markers: true,
    credentials: { [OPENROUTER_CRED_KEY]: { headers: { Authorization: 'Bearer sk-or' } } },
    model: (deps) => createOpenRouterProvider().createModel('anthropic/claude-sonnet-4.6', deps),
  },
  {
    label: 'openrouter-other', providerId: 'openrouter', modelId: 'meta-llama/llama-4-maverick',
    dialect: 'compat', markers: false,
    credentials: { [OPENROUTER_CRED_KEY]: { headers: { Authorization: 'Bearer sk-or' } } },
    model: (deps) => createOpenRouterProvider().createModel('meta-llama/llama-4-maverick', deps),
  },
  {
    label: 'my-gateway', providerId: 'my-gateway', modelId: 'workers-ai/@cf/x', dialect: 'compat', markers: false,
    credentials: { 'my-gateway': { headers: { Authorization: 'Bearer g' }, baseURL: 'https://my-gateway.example/v1' } },
    model: (deps) => createOpenAICompatProvider('my-gateway').createModel('workers-ai/@cf/x', deps),
  },
  {
    label: 'ai-gateway', providerId: 'ai-gateway', modelId: 'workers-ai/@cf/x', dialect: 'compat', markers: false,
    credentials: { 'ai-gateway': { headers: { Authorization: 'Bearer g' }, baseURL: 'https://ai-gateway.example/v1' } },
    model: (deps) => createOpenAICompatProvider('ai-gateway').createModel('workers-ai/@cf/x', deps),
  },
  {
    label: 'openai-compat', providerId: 'openai-compat', modelId: 'llama-4', dialect: 'compat', markers: false,
    credentials: { 'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: 'https://groq.example/v1' } },
    model: (deps) => createOpenAICompatProvider().createModel('llama-4', deps),
  },
  {
    // The affinity header is attached where the model is built in production
    // (cf-backend workers-ai.ts requestHeaders); a credential header reaches
    // the wire the same way through core's authed fetch.
    label: 'workers-ai', providerId: 'workers-ai', modelId: '@cf/moonshotai/kimi-k2.6', dialect: 'compat', markers: false,
    credentials: {
      'workers-ai': {
        headers: { Authorization: 'Bearer cf', 'x-session-affinity': SESSION_KEY },
        baseURL: 'https://workers-ai.example/v1',
      },
    },
    model: (deps) => createWorkersAIProvider({ sessionAffinity: SESSION_KEY }, {
      async run(model, inputs, options) {
        if (deps.fetch === undefined) throw new Error('the binding fixture needs its recording fetch');

        return deps.fetch('https://workers-ai.example/v1/chat/completions', {
          method: 'POST', headers: options?.extraHeaders,
          body: JSON.stringify({ model, ...inputs }),
        });
      },
    }).createModel('@cf/moonshotai/kimi-k2.6', deps),
  },
];

/** A provider id the strategy map resolves to `none`: the turn runs, the
 *  request leaves unaddressed, and the provider reports plain usage. */
const UNADDRESSED_PROVIDER: ProviderCase = {
  label: 'unaddressed', providerId: 'claude', modelId: 'claude-sonnet-4-x', dialect: 'compat',
  unaddressed: true,
  credentials: { 'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: 'https://claude.example/v1' } },
  model: (deps) => createOpenAICompatProvider().createModel('claude-sonnet-4-x', deps),
};

/* ── The turn ────────────────────────────────────────────────────────────── */

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
];

const SYSTEM = 'You are Kinu.';

function chatTools(): ToolSet {
  const tools: ToolSet = {
    probe: tool({
      description: 'probe a number',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => `probed:${x}`,
    }),
  };

  // Both backends mark the tool surface at build time; the same holds here.
  markLastToolForAnthropicCache(tools);

  return tools;
}

function viewOf(entry: ProviderCase, request: RecordedRequest): WireView {
  const body = parseJsonObject(v.parse(v.string(), request.body));

  if (entry.dialect === 'anthropic') return anthropicView(body);

  if (entry.dialect === 'responses') return responsesView(body);

  return compatView(body, request, entry.markers === true);
}

function requestAt(mock: MockFetchHandle, index: number): RecordedRequest {
  const request = mock.requests[index];

  if (request === undefined) throw new Error(`no request ${index} was recorded`);

  return request;
}

function sseFor(entry: ProviderCase, callIndex: number, usage: JsonObject): string {
  if (entry.dialect === 'anthropic') return anthropicSse(callIndex, usage);

  if (entry.dialect === 'responses') return responsesSse(callIndex, usage);

  return compatSse(callIndex, usage);
}

function usageFor(entry: ProviderCase, verdict: Verdict, decoy: boolean): JsonObject {
  if (entry.dialect === 'anthropic') return anthropicUsage(verdict, decoy);

  if (entry.dialect === 'responses') return responsesUsage(verdict, decoy);

  return compatUsage(verdict, decoy);
}

interface TurnResult {
  mock: MockFetchHandle;
  /** The per-step usage reports, in order — the same projection the
   *  step_finish activity line renders. */
  steps: Usage[];
  /** The turn's accumulated usage, from the real TurnAccumulator. */
  total: Usage;
}

/** One three-step turn — tool call, tool call, answer — against the
 *  provider's mocked cache. The mock reads each request's addressed prefix
 *  BEFORE deciding what the usage line reports. */
async function driveTurn(
  entry: ProviderCase,
  opts: { decoy?: boolean; extension?: KinuExtension; dynamic?: () => DynamicContext } = {},
): Promise<TurnResult> {
  const oracle = new PrefixCacheOracle();

  const mock = createMockFetch([{
    match: () => true,
    respond: (req, callIndex) => {
      const verdict = entry.unaddressed === true ? { read: 0, write: 0 } : oracle.submit(viewOf(entry, req));

      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseFor(entry, callIndex, entry.unaddressed === true
          ? SILENT_USAGE
          : usageFor(entry, verdict, opts.decoy === true)),
      };
    },
  }]);

  const deps = makeDeps(entry.credentials, mock.fetch);
  const acc = new TurnAccumulator();
  acc.reset(0);
  const steps: Usage[] = [];
  const extensions = opts.extension ? new ExtensionHost().register(opts.extension) : undefined;

  for await (const event of runChat({
    model: entry.model(deps),
    system: SYSTEM,
    history: [...HISTORY],
    tools: chatTools(),
    stopWhen: stepCountIs(5),
    extensions,
    dynamicContext: opts.dynamic ? { ledger: new DynamicContextLedger(), snapshot: opts.dynamic } : undefined,
    cache: { providerId: entry.providerId, modelId: entry.modelId, sessionKey: SESSION_KEY },
  })) {
    if (event.type === 'step-finish') {
      steps.push(event.usage ?? {});
      acc.recordStep({ response: { messages: event.responseMessages }, usage: event.usage });
    }
  }

  return { mock, steps, total: acc.reportedUsage() ?? {} };
}

/* ── Wire-body surgery for the marker-placement proof ────────────────────── */

/** Strip `cache_control` everywhere — tools, system, every message — and
 *  re-place ONE breakpoint on the first message: a marker inside the prefix
 *  step 1 already stored, nowhere near the tail. */
function demoteBreakpoints(entry: ProviderCase, body: JsonObject): JsonObject {
  const stripped = removeBreakpoint(body);
  const messages = stripped.messages;

  if (!Array.isArray(messages)) return stripped;

  const moved = messages.map((message, index) =>
    index === 0 && v.is(JsonObjectSchema, message) ? placeBreakpoint(entry, message) : message);

  return { ...stripped, messages: moved };
}

function removeBreakpoint(value: JsonObject): JsonObject {
  const out: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cache_control') continue;

    out[key] = Array.isArray(entry)
      ? entry.map((item) => (v.is(JsonObjectSchema, item) ? removeBreakpoint(item) : item))
      : entry;
  }

  return out;
}

function placeBreakpoint(entry: ProviderCase, value: JsonObject): JsonObject {
  const breakpoint = { type: 'ephemeral' };

  if (entry.dialect === 'anthropic') {
    const content = value.content;

    if (Array.isArray(content) && content.length > 0) {
      const parts = content.map((part, index) =>
        index === content.length - 1 && v.is(JsonObjectSchema, part)
          ? { ...part, cache_control: breakpoint }
          : part);

      return { ...value, content: parts };
    }
  }

  return { ...value, cache_control: breakpoint };
}

/* ── The gate ────────────────────────────────────────────────────────────── */

const BLIND_SPOTS = [
  "a mocked fetch cannot prove a live cache; each predicate is the test's own model of the provider's cache, stated from its docs in the file header",
  'the oracle reads the WHOLE stored prefix or nothing — real caches also serve partial hits below a mutation, so this gate is stricter than the platform',
  'chat-completions streams are answered with usage on the finish chunk even though the adapter does not ask for stream_options.include_usage — production Workers-AI goes through a binding that forces it',
  "token counts are canonical bytes/4, not the provider's tokenizer; the gate measures zero-versus-nonzero",
];

describe('a stable prefix reads back as a nonzero cache hit', () => {
  test('a tool crafted during the conversation appends its declaration behind the cached prefix', async () => {
    for (const entry of CACHING_PROVIDERS) {
      let step = 0;

      const { mock, steps } = await driveTurn(entry, { dynamic: () => {
        step++;

        return step === 1 ? { factsBlock: 'The workspace is ready.' }
          : { factsBlock: 'The workspace is ready.', craftedTools: [{ name: 'cache_echo', description: 'Return the supplied text' }] };
      } });

      expect(requestAt(mock, 0).body).not.toContain('cache_echo');
      expect(requestAt(mock, 1).body).toContain('cache_echo');
      expect(steps[1]?.cacheRead ?? 0).toBeGreaterThan(0);
      expect(steps[2]?.cacheRead ?? 0).toBeGreaterThan(0);
    }
  });

  test('the actual Workers AI provider routes every binding step to its conversation replica', async () => {
    const entry = CACHING_PROVIDERS.find((candidate) => candidate.label === 'workers-ai');

    if (entry === undefined) throw new Error('missing Workers AI case');
    const { mock } = await driveTurn(entry);
    expect(mock.requests).toHaveLength(3);

    for (const request of mock.requests) {
      expect(request.headers['x-session-affinity']).toBe(SESSION_KEY);
    }
  });

  test('every caching provider accumulates a nonzero cacheRead on the multi-step turn', async () => {
    const lines: string[] = [];

    for (const entry of CACHING_PROVIDERS) {
      const { mock, steps, total } = await driveTurn(entry);

      expect(mock.requests.length).toBe(3);
      expect(steps.length).toBe(3);
      // Step 1 writes the prefix; steps 2 and 3 must READ it back — and the
      // read grows as the addressed prefix extends.
      expect(steps[0]?.cacheRead ?? 0).toBe(0);
      expect(steps[1]?.cacheRead ?? 0).toBeGreaterThan(0);
      expect(steps[2]?.cacheRead ?? 0).toBeGreaterThan(steps[1]?.cacheRead ?? 0);
      expect(total.cacheRead ?? 0).toBeGreaterThan(0);

      lines.push(`${entry.label}: cacheRead=[${steps.map((s) => s.cacheRead ?? 0).join(',')}] turn=${total.cacheRead ?? 0}`);
    }

    console.log(`cache-hit gate, per provider:\n${lines.join('\n')}`);
    console.log(`blind spots:\n${BLIND_SPOTS.map((s) => `- ${s}`).join('\n')}`);
  });

  test('a provider the map gives nothing leaves the request unaddressed and reads 0', async () => {
    const { mock, total } = await driveTurn(UNADDRESSED_PROVIDER);

    expect(mock.requests.length).toBe(3);

    for (const request of mock.requests) {
      const body = parseJsonObject(v.parse(v.string(), request.body));
      expect(body.prompt_cache_key).toBeUndefined();
      expect(body.prompt_cache_retention).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('"cache_control"');
      expect(request.headers['x-session-affinity']).toBeUndefined();
    }

    // The provider reported plain usage; the read field was never mentioned.
    expect(total.cacheRead ?? 0).toBe(0);
  });

  test('a per-step mutation before the deepest breakpoint drops the hit to 0', async () => {
    // A clock-derived string spliced into the FIRST history message at every
    // step — the failure mode this gate exists to catch.
    const clock: KinuExtension = {
      name: 'clock-mutation',
      prepareStep: ({ stepNumber, messages }) => messages.map((message, index) => {
        if (index !== 0 || message.role !== 'user' || !v.is(v.string(), message.content)) return message;

        return { ...message, content: `${message.content}#step-${stepNumber}` };
      }),
    };

    for (const entry of CACHING_PROVIDERS) {
      const { mock, total } = await driveTurn(entry, { extension: clock });

      expect(mock.requests.length).toBe(3);
      // The mutation reached the wire — the miss is its fault, not a silent
      // turn that never ran.
      expect(requestAt(mock, 1).body).toContain('#step-1');
      expect(requestAt(mock, 2).body).toContain('#step-2');
      expect(total.cacheRead ?? 0).toBe(0);
    }
  });

  test('breakpoints anywhere but the tail read 0 — the oracle discriminates on real wire bytes', async () => {
    // The pipeline marks the tail unconditionally, so no live turn can place
    // a marker wrong; the discrimination is proved on the REAL captured
    // bodies, replayed through the same oracle the green path used.
    for (const entry of CACHING_PROVIDERS.filter((e) => e.markers === true || e.dialect === 'anthropic')) {
      const { mock } = await driveTurn(entry);
      const first = requestAt(mock, 0);
      const second = requestAt(mock, 1);

      // Control: the real pair hits.
      const control = new PrefixCacheOracle();
      control.submit(viewOf(entry, first));
      expect(control.submit(viewOf(entry, second)).read).toBeGreaterThan(0);

      // Move every tail breakpoint onto the FIRST message — inside the
      // prefix step 1 already stored, so the request's addressed region no
      // longer extends it.
      const demoted = demoteBreakpoints(entry, parseJsonObject(v.parse(v.string(), second.body)));

      // The demoted body still carries exactly one breakpoint — on the
      // first message, not the tail.
      expect(JSON.stringify(demoted).match(/"cache_control"/g)?.length).toBe(1);

      const mutated = new PrefixCacheOracle();
      mutated.submit(viewOf(entry, first));
      const replay: RecordedRequest = { ...second, body: JSON.stringify(demoted) };
      expect(mutated.submit(viewOf(entry, replay)).read).toBe(0);
    }
  });

  test('the count landing on the sibling field reads 0 — the normaliser cannot confuse dialects', async () => {
    for (const entry of CACHING_PROVIDERS) {
      const { steps, total } = await driveTurn(entry, { decoy: true });

      expect(total.cacheRead ?? 0).toBe(0);
      // The count DID arrive — on the wrong field, where it stays.
      expect(steps[1]?.cacheWrite ?? steps[1]?.reasoning ?? 0).toBeGreaterThan(0);
    }
  });
});

/** A turn that fails over, through the session a backend drives: the catalog's chain, the real provider adapters on a
 *  mocked network, the durable step record and the warming lane. Every cache decision is the serving provider's. */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createMockFetch, type MockFetchHandle } from '@kinu.run/test-utils';
import {
  ANTHROPIC_CRED_KEY, CacheWarmingLane, CacheWarmStore, createAnthropicProvider, createOpenAIProvider, initCacheWarmTable,
  OPENAI_CRED_KEY, parseJsonObject, type AuthResolution, type JsonObject, type JsonValue, type ModelCallDeps,
} from '../src/index';
import { modelWindow } from '../src/context-window';
import { fixtureCatalog } from './helpers-actor-host';
import { sessionFixture } from './helpers-session';

const OPENAI = 'openai/gpt-5.5';

const ANTHROPIC = 'anthropic/claude-opus-5-5';

const REFUSED = { status: 503, body: JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }) };

function sse(frames: readonly JsonObject[]): string {
  return frames.map((data) => `event: ${v.parse(v.string(), data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** An answer that read 100 cached tokens and wrote none: what earns a warm. */
const ANTHROPIC_ANSWER = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'planned' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

const OPENAI_ANSWER = sse([
  { type: 'response.created', response: { id: 'resp_1', created_at: 1700000000, model: 'gpt-5.5' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'planned' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.completed', response: { incomplete_details: null, usage: {
    input_tokens: 112, output_tokens: 2, total_tokens: 114, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 0 },
  } } },
]);

const STREAMED = { status: 200, headers: { 'content-type': 'text/event-stream' } };

/** The body each provider was sent, by its host. */
function sentTo(mock: MockFetchHandle, host: string): JsonObject {
  const request = mock.requests.find((each) => each.url.includes(host));

  return parseJsonObject(v.parse(v.string(), request?.body));
}

const CREDENTIALS = new Map<string, AuthResolution>([
  [OPENAI_CRED_KEY, { headers: { Authorization: 'Bearer sk-openai' } }],
  [ANTHROPIC_CRED_KEY, { headers: { 'x-api-key': 'sk-ant' } }],
]);

/** Where a warm went, and the model its body named. */
interface Warm {
  readonly provider: string;
  readonly modelId: string;
  readonly model: JsonValue | undefined;
}

interface Failover {
  readonly primary: string;
  readonly fallback: string;
  readonly warmed: readonly Warm[];
}

const FAILOVERS: readonly Failover[] = [
  { primary: OPENAI, fallback: ANTHROPIC, warmed: [{ provider: 'anthropic', modelId: 'claude-opus-5-5', model: 'claude-opus-5-5' }] },
  // The Responses API keeps its own cache: there is nothing to warm, and Anthropic is never sent OpenAI's body.
  { primary: ANTHROPIC, fallback: OPENAI, warmed: [] },
];

test.each([...FAILOVERS])('a turn on $primary served by $fallback is cached for and warmed for $fallback', async ({ primary, fallback, warmed }) => {
  const mock = createMockFetch([
    { match: 'api.openai.com', respond: primary === OPENAI ? REFUSED : { ...STREAMED, body: OPENAI_ANSWER } },
    { match: 'api.anthropic.com', respond: primary === ANTHROPIC ? REFUSED : { ...STREAMED, body: ANTHROPIC_ANSWER } },
  ]);

  const deps: ModelCallDeps = {
    env: {}, sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test', fetch: mock.fetch,
    getAuth: async (key) => CREDENTIALS.get(key) ?? null,
    hasCredential: async (key) => CREDENTIALS.has(key),
  };

  const resolve = (spec: string) => (spec === OPENAI
    ? createOpenAIProvider().createModel('gpt-5.5', deps)
    : createAnthropicProvider().createModel('claude-opus-5-5', deps));

  const sent: Warm[] = [];
  let lane: CacheWarmingLane | undefined;

  const fixture = await sessionFixture({
    model: resolve(primary),
    sources: {
      models: {
        catalog: { window: () => modelWindow(null), windowFor: async () => modelWindow(null), warm: async () => {}, acceptedMedia: () => new Set() },
        normalize: (spec) => spec,
        resolve,
        routed: {
          attemptFor: async (spec) => ({ lane: spec, modelId: spec, credential: spec, ref: spec }),
          countInputTokens: async () => ({ kind: 'unsupported', provider: 'fixture', reason: 'no count endpoint' }),
        },
      },
      profileInputs: async () => ({
        envelope: fixtureCatalog({ default: { model: primary, fallbacks: [fallback] } }),
        provider: { revision: 'rev-failover', availableModels: [primary, fallback] },
      }),
    },
    cacheWarming: (actor) => {
      initCacheWarmTable(actor.runtime.storage.execRaw);

      lane = new CacheWarmingLane({
        store: new CacheWarmStore(actor.runtime.storage.sql, actor.handle),
        wake: () => {}, spend: () => {}, now: Date.now,
        send: async ({ modelSpec, body }) => {
          sent.push({ provider: modelSpec.provider, modelId: modelSpec.modelId, model: body.model });

          return { usage: {} };
        },
      });

      return lane;
    },
  });

  try {
    await fixture.chat.send('plan the quarterly offsite', { id: 'q-1' });
    await lane?.runDue(Number.MAX_SAFE_INTEGER);

    const anthropic = sentTo(mock, 'api.anthropic.com');
    const openai = sentTo(mock, 'api.openai.com');

    // Anthropic is addressed by its markers, OpenAI by its prefix alone: neither request carries the other's addressing.
    expect({
      anthropicMarked: JSON.stringify(anthropic.system).includes('cache_control'),
      openaiMarked: JSON.stringify(openai).includes('cache_control'),
      keyed: [anthropic, openai].some((body) => 'prompt_cache_key' in body),
    }).toEqual({ anthropicMarked: true, openaiMarked: false, keyed: false });
    expect(sent).toEqual([...warmed]);
  } finally { fixture.close(); }
});

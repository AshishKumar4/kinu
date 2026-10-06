// The ChatGPT plan's two routes compact on the provider, the way its own client does (Codex compaction V2, as
// oh-my-pi implements it after codex-rs `compact_remote_v2.rs`): the request that should compact ends in a
// `compaction_trigger` item and is answered by one compaction item alone. The fake keeps what both routes impose:
// nothing is stored (`store: false`), so an item is sent whole and never named by reference.
import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import {
  CHATGPT_CRED_KEY, CODEX_CRED_KEY, JsonObjectSchema, asFetchFunction, createChatGptProvider, createCodexProvider,
  type JsonObject, type ModelCallDeps,
} from '@kinu.run/core';
import { namedSpec, resolverRest, setupWithResolver } from './helpers/local-session';

const SESSION = 'plan-session';

const InputItemSchema = v.looseObject({ type: v.optional(v.string()), id: v.optional(v.string()), encrypted_content: v.optional(v.string()) });

const RequestSchema = v.looseObject({ store: v.optional(v.boolean()), input: v.array(InputItemSchema) });

/** A Responses stream event: its type, and the rest of what the API sends with it. */
interface StreamEvent {
  readonly type: string;
  readonly [field: string]: JsonObject[string];
}

function stream(events: readonly StreamEvent[]): Response {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

function refused(message: string): Response {
  return Response.json({ error: { message, type: 'invalid_request_error', param: null, code: null } }, { status: 400 });
}

/** The plan backend: unstored requests only, and a trailing `compaction_trigger` answered by the compaction alone. */
function planBackend() {
  const sent: JsonObject[] = [];
  let compactions = 0;
  let reply = 'Renamed.';

  const fetch = asFetchFunction(async (url, init) => {
    const body = v.parse(JsonObjectSchema, JSON.parse(await new Request(url, init).text()));
    sent.push(body);
    const { store, input } = v.parse(RequestSchema, body);

    if (store !== false) return refused('Store must be set to false');
    const referenced = input.find((item) => item.type === 'item_reference');

    if (referenced !== undefined) return refused(`Item with id '${referenced.id ?? ''}' not found. Items are not persisted when \`store\` is set to false.`);

    if (input.some((item) => item.type === 'compaction' && (item.id === undefined || item.encrypted_content === undefined))) {
      return refused('A compaction item needs its id and encrypted_content.');
    }

    const response = { id: `resp_${String(sent.length)}`, object: 'response', created_at: 1_790_000_000, model: 'gpt-6.1-sol', status: 'in_progress', output: [] };
    const usage = { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 };

    if (input.at(-1)?.type === 'compaction_trigger') {
      compactions += 1;

      return stream([
        { type: 'response.created', response },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'compaction', id: `cmp_${String(compactions)}`, encrypted_content: `ENC-${String(compactions)}` } },
        { type: 'response.completed', response: { ...response, status: 'completed', usage } },
      ]);
    }

    const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };

    return stream([
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: reply },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { ...response, status: 'completed', usage } },
    ]);
  });

  return { fetch, sent, answer: (text: string) => { reply = text; } };
}

const ROUTES = [
  { spec: 'chatgpt/gpt-6.1-sol', key: CHATGPT_CRED_KEY, model: (deps: ModelCallDeps) => createChatGptProvider().createModel('gpt-6.1-sol', deps) },
  { spec: 'codex/gpt-6.1-sol', key: CODEX_CRED_KEY, model: (deps: ModelCallDeps) => createCodexProvider().createModel('gpt-6.1-sol', deps) },
] as const;

/** A signed-in session whose model is the plan route, its window 100k tokens as the catalog says. */
function planSession(route: (typeof ROUTES)[number], backend: ReturnType<typeof planBackend>) {
  const deps: ModelCallDeps = {
    env: {}, sessionAffinity: SESSION, fetch: backend.fetch,
    getAuth: async (key) => (key === route.key ? { headers: { Authorization: 'Bearer plan' } } : null),
    hasCredential: async (key) => key === route.key,
  };

  const model: LanguageModel = route.model(deps);

  return setupWithResolver({
    normalizeSpecSync: (spec) => namedSpec(spec) ?? route.spec,
    resolveModel: () => model,
    listProviders: async () => [],
    listModels: async () => ({ models: [], failures: [] }),
    modelInfo: async () => ({ id: route.spec, label: 'plan', capabilities: ['tools', 'streaming'], contextWindow: 100_000 }),
    ...resolverRest,
  }).session;
}

const kinds = (body: JsonObject | undefined) => v.parse(RequestSchema, body).input.map((item) => item.type ?? 'message');

const compacting = (body: JsonObject) => kinds(body).at(-1) === 'compaction_trigger';

describe('a ChatGPT plan route compacts on the provider', () => {
  for (const route of ROUTES) {
    test(`on ${route.spec}, the turn that passes the trigger asks once, answers from the item, and later turns replay it whole`, async () => {
      const backend = planBackend();
      const session = planSession(route, backend);

      // Eight long answers pass 85% of the window; two short ones follow the compaction.
      backend.answer(`noted: ${'detail '.repeat(5_700)}`);

      for (let i = 0; i < 8; i++) await session.send(`requirement ${String(i)}`, { id: crypto.randomUUID() });
      backend.answer('Renamed.');

      for (const ask of ['rename the parser module', 'and the tests']) await session.send(ask, { id: crypto.randomUUID() });
      await session.end();

      const asked = backend.sent.findIndex(compacting);
      // The conversation's requests: a background call (titles, memory) sends one message of its own.
      const after = backend.sent.slice(asked + 1).map((body) => v.parse(RequestSchema, body).input).filter((input) => input.length > 1);

      expect({
        asked: backend.sent.filter(compacting).length,
        thresholdAsked: backend.sent.some((body) => body.context_management !== undefined),
        items: after.map((input) => input.filter((item) => item.type === 'compaction')),
        olderSent: after.some((input) => JSON.stringify(input).includes('requirement 0')),
      }).toEqual({
        asked: 1,
        thresholdAsked: false,
        items: after.map(() => [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'ENC-1' }]),
        olderSent: false,
      });
      // The turn that compacted, and the one after it.
      expect(after).toHaveLength(2);
    });
  }
});

import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { mcpToolKey } from '../src/tools/mcp-naming';
import { describeMcpTool, McpToolSurfaceCache, type SerializableToolDescriptor } from '../src/tools/mcp-surface';
import { fitToolSchema } from '../src/providers/middleware/tool-schema-dialect';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../src/utils/json';
import { createTestRuntime } from '@kinu.run/test-utils';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { buildBuiltinTools } from '../src/tools/builtins';
import { runChat, type ChatEvent } from '../src/chat';
import { createProviderRegistry, type ModelCallDeps } from '../src/index';
import { conversationsFor } from './helpers';

/** An MCP tool whose schema uses what providers reject: `$schema`, `const`, `oneOf`, a boolean subschema, a root `anyOf`. */
const REMOTE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  anyOf: [
    { type: 'object', properties: { mode: { const: 'fast' }, target: { oneOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } } }] } }, required: ['mode', 'target'] },
    { type: 'object', properties: { mode: { const: 'slow' }, anything: true, hidden: false, note: { type: ['string', 'null'] } }, required: ['mode'] },
  ],
};

const DEPS: ModelCallDeps = { env: {}, sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false };

function sentSchema(gemini: boolean, schema: JsonObject = REMOTE_SCHEMA): JsonObject {
  return v.parse(JsonObjectSchema, fitToolSchema(schema, gemini));
}

describe('MCP input schemas per provider', () => {
  test('every model gets an object root with the branches merged', () => {
    for (const gemini of [false, true]) {
      const schema = sentSchema(gemini);

      expect({ gemini, type: schema.type, combiner: 'anyOf' in schema }).toEqual({ gemini, type: 'object', combiner: false });
      expect({ gemini, properties: Object.keys(obj(schema.properties)).sort(), required: schema.required }).toEqual({ gemini, properties: ['anything', 'mode', 'note', 'target'], required: ['mode'] });
    }
  });

  test('only Gemini loses $schema, which the other providers take', () => {
    expect([false, true].map((gemini) => '$schema' in sentSchema(gemini))).toEqual([true, false]);
  });

  test('Gemini gets its OpenAPI subset: const as enum, oneOf as anyOf, nullable for a null type', () => {
    const properties = obj(sentSchema(true).properties);

    expect(properties.mode).toEqual({ enum: ['fast', 'slow'] });
    expect(obj(properties.target).anyOf).toHaveLength(2);
    expect('oneOf' in obj(properties.target)).toBe(false);
    expect(properties.note).toEqual({ type: 'string', nullable: true });
    expect(properties.anything).toEqual({});
  });

  test('other models keep a nested oneOf, which they accept', () => {
    expect('oneOf' in obj(obj(sentSchema(false).properties).target)).toBe(true);
  });

  test('a root union keeps every branch value of a property the branches share', () => {
    const union: JsonObject = {
      anyOf: [
        { type: 'object', properties: { action: { const: 'create' }, target: { type: 'string' } }, required: ['action'] },
        { type: 'object', properties: { action: { const: 'delete' }, target: { type: 'integer' } }, required: ['action'] },
        { type: 'object', properties: { action: { enum: ['archive', 'create'] } }, required: ['action'] },
      ],
    };

    for (const gemini of [false, true]) {
      const properties = obj(sentSchema(gemini, union).properties);

      expect({ gemini, action: properties.action }).toEqual({ gemini, action: { enum: ['create', 'delete', 'archive'] } });
      expect({ gemini, target: properties.target }).toEqual({ gemini, target: { anyOf: [{ type: 'string' }, { type: 'integer' }] } });
    }
  });

  test('instance values are copied as written, never read as schemas', () => {
    const values: JsonObject = {
      type: 'object',
      properties: {
        recursive: { type: 'boolean', default: true },
        mode: { type: 'string', enum: ['auto', 'manual'], default: 'auto', examples: ['auto'] },
        strict: { const: true },
        options: { type: 'object', default: { depth: 2, flags: { verbose: true }, anyOf: true }, example: { depth: 1 } },
      },
    };

    for (const gemini of [false, true]) {
      const properties = obj(sentSchema(gemini, values).properties);

      expect({ gemini, recursive: obj(properties.recursive).default, options: obj(properties.options).default, example: obj(properties.options).example })
        .toEqual({ gemini, recursive: true, options: { depth: 2, flags: { verbose: true }, anyOf: true }, example: { depth: 1 } });
    }

    const properties = obj(sentSchema(false, values).properties);

    expect({ strict: properties.strict, mode: properties.mode })
      .toEqual({ strict: { const: true }, mode: { type: 'string', enum: ['auto', 'manual'], default: 'auto', examples: ['auto'] } });
  });
});

describe('built-in input schemas per model, as the registry resolves it', () => {
  /** One turn on a model the registry resolves as `provider`/`modelId`, whose model calls tasks with an off-vocabulary
   *  status: what it was sent, and what came back. */
  async function builtinTurn(provider: string, modelId: string) {
    const { rt } = createTestRuntime();
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

    const model = scriptedTurnModel({
      provider,
      modelId,
      doGenerate: () => (step++ === 0
        ? { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'tasks', input: JSON.stringify({ op: 'update', id: 't1', status: 'Done' }) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] }
        : { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }),
    });

    const registry = createProviderRegistry();
    registry.register({ id: 'probe', isAvailable: () => true, listModels: () => [], createModel: (): LanguageModel => model });
    const results: Extract<ChatEvent, { type: 'tool-result' }>[] = [];

    for await (const event of runChat({
      modelSpec: 'test/model',
      model: registry.resolve('probe/m', DEPS), system: 's', history: [{ role: 'user', content: 'go' }],
      tools: buildBuiltinTools({ rt, conversations: conversationsFor(rt) }),
    })) {
      if (event.type === 'tool-result') results.push(event);
    }

    const sent = new Map((model.doStreamCalls[0]?.tools ?? []).flatMap((entry) => entry.type === 'function' ? [[entry.name, entry.inputSchema] as const] : []));

    return { sent, results };
  }

  test('a Gemini model gets each built-in in its subset: no $schema or additionalProperties, a nullable as `nullable`', async () => {
    const { sent } = await builtinTurn('google.chat', 'gemini-2.5-pro');

    expect(sent.size).toBeGreaterThan(0);

    for (const [name, schema] of sent) {
      expect({ name, meta: JSON.stringify(schema).includes('"$schema"'), closed: JSON.stringify(schema).includes('"additionalProperties"') })
        .toEqual({ name, meta: false, closed: false });
    }

    expect(obj(obj(v.parse(JsonObjectSchema, sent.get('tasks')).properties).note)).toMatchObject({ type: 'string', nullable: true });
  });

  test('Gemini is known by its route or, through a gateway, by its id', async () => {
    const routes = [
      ['anthropic.messages', 'claude-opus-4-7'], ['openrouter.chat', 'anthropic/claude-sonnet-4.6'], ['openrouter.chat', 'google/gemini-2.5-pro'],
      ['google.chat', 'gemini-2.5-flash'], ['google-vertex.chat', 'gemma-3-27b-it'], ['openai.responses', 'gpt-5.5'], ['openrouter.chat', 'deepseek/deepseek-v4'],
    ] as const;

    const nullable = await Promise.all(routes.map(async ([provider, modelId]) => {
      const { sent } = await builtinTurn(provider, modelId);

      return 'nullable' in obj(obj(v.parse(JsonObjectSchema, sent.get('tasks')).properties).note);
    }));

    expect(nullable).toEqual([false, false, true, true, true, false, false]);
  });

  test('a fitted built-in is still checked by its own schema', async () => {
    for (const [provider, modelId] of [['google.chat', 'gemini-2.5-pro'], ['openai.responses', 'gpt-5.5']] as const) {
      const { results } = await builtinTurn(provider, modelId);

      expect({ provider, outcome: results[0] }).toMatchObject({ provider, outcome: { success: false, reason: 'bad_input', error: expect.stringContaining('received "Done"') } });
    }
  });
});

describe('MCP tool names', () => {
  test('a 70-character server and tool name is cut to 64 with a deterministic suffix, and stays unique', () => {
    const server = 'enterprise-knowledge-base-connector';
    const first = mcpToolKey(server, 'search_documents_by_semantic_similarity');
    const second = mcpToolKey(server, 'search_documents_by_semantic_similarity_v2');

    expect(first).toHaveLength(64);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
    expect(mcpToolKey(server, 'search_documents_by_semantic_similarity')).toBe(first);
    expect(first).toMatch(/^mcp_enterprise-knowledge-base-connector_search_document_[0-9a-f]{8}$/);
    expect(mcpToolKey('github', 'create_issue')).toBe('mcp_github_create_issue');
  });

  test('tools whose keys would collide are all offered, each under its own key', async () => {
    // `a.b` and `a_b` sanitize alike; server `x_y` + tool `z` and server `x` + tool `y_z` join alike.
    const described = [['srv', 'a.b'], ['srv', 'a_b'], ['x_y', 'z'], ['x', 'y_z'], ['srv', 'plain']].map(([server = '', name = '']) => {
      const answer = describeMcpTool({ id: server, name: server }, { name, inputSchema: { type: 'object' } });

      if ('refused' in answer) throw new Error(answer.refused.reason);

      return answer.admitted;
    });

    // Admitted as a turn admits them: through the surface cache, against a window that carries every one.
    let admitted: readonly SerializableToolDescriptor[] = [];
    const cache = new McpToolSurfaceCache(async (descriptors) => { admitted = descriptors; });

    await cache.refresh(async () => ({ descriptors: described, unavailable: [] }), { contextWindow: 200_000, modelOutputLimit: null, nativeToolTokens: 0 });
    const keys = admitted.map((descriptor) => descriptor.toolKey);

    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(keys.every((key) => key.length <= 64)).toBe(true);
    expect(keys).toContain('mcp_srv_plain');
  });
});

function obj(value: JsonObject[string] | undefined): JsonObject {
  return v.parse(JsonObjectSchema, value);
}

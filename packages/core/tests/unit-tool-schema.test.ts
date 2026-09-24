import { describe, expect, test } from 'bun:test';
import { asSchema, jsonSchema, tool, type ToolSet } from 'ai';
import { mcpToolKey } from '../src/tools/mcp-naming';
import { admitMcpDescriptors, describeMcpTool } from '../src/tools/mcp-surface';
import { toolSchemaDialect, withToolSchemaDialect, type ToolSchemaDialect } from '../src/tools/tool-schema';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../src/utils/json';

/** An MCP tool whose schema uses what providers reject: `$schema`, `const`, `oneOf`, a boolean subschema, a root `anyOf`. */
const REMOTE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  anyOf: [
    { type: 'object', properties: { mode: { const: 'fast' }, target: { oneOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } } }] } }, required: ['mode', 'target'] },
    { type: 'object', properties: { mode: { const: 'slow' }, anything: true, hidden: false, note: { type: ['string', 'null'] } }, required: ['mode'] },
  ],
};

function sentSchema(dialect: ToolSchemaDialect, schema: JsonObject = REMOTE_SCHEMA): JsonObject {
  const name = mcpToolKey('srv', 'probe');
  const tools: ToolSet = { [name]: tool({ description: 'probe', inputSchema: jsonSchema<JsonObject>(schema), execute: async () => 'ran' }) };
  const entry = withToolSchemaDialect(tools, dialect)[name];

  if (entry === undefined) throw new Error('the MCP tool vanished from the set');

  return v.parse(JsonObjectSchema, asSchema(entry.inputSchema).jsonSchema);
}

describe('MCP input schemas per provider', () => {
  test('every provider gets an object root with the branches merged, and no $schema', () => {
    for (const dialect of ['openai', 'anthropic', 'gemini'] as const) {
      const schema = sentSchema(dialect);

      expect({ dialect, type: schema.type, combiner: 'anyOf' in schema, meta: '$schema' in schema }).toEqual({ dialect, type: 'object', combiner: false, meta: false });
      expect({ dialect, properties: Object.keys(obj(schema.properties)).sort(), required: schema.required }).toEqual({ dialect, properties: ['anything', 'mode', 'note', 'target'], required: ['mode'] });
    }
  });

  test('Gemini gets its OpenAPI subset: const as enum, oneOf as anyOf, nullable for a null type', () => {
    const properties = obj(sentSchema('gemini').properties);

    expect(properties.mode).toEqual({ enum: ['fast', 'slow'] });
    expect(obj(properties.target).anyOf).toHaveLength(2);
    expect('oneOf' in obj(properties.target)).toBe(false);
    expect(properties.note).toEqual({ type: 'string', nullable: true });
    expect(properties.anything).toEqual({});
  });

  test('OpenAI and Anthropic keep a nested oneOf, which they accept', () => {
    for (const dialect of ['openai', 'anthropic'] as const) {
      expect({ dialect, target: 'oneOf' in obj(obj(sentSchema(dialect).properties).target) }).toEqual({ dialect, target: true });
    }
  });

  test('a root union keeps every branch value of a property the branches share', () => {
    const union: JsonObject = {
      anyOf: [
        { type: 'object', properties: { action: { const: 'create' }, target: { type: 'string' } }, required: ['action'] },
        { type: 'object', properties: { action: { const: 'delete' }, target: { type: 'integer' } }, required: ['action'] },
        { type: 'object', properties: { action: { enum: ['archive', 'create'] } }, required: ['action'] },
      ],
    };

    for (const dialect of ['openai', 'anthropic', 'gemini'] as const) {
      const properties = obj(sentSchema(dialect, union).properties);

      expect({ dialect, action: properties.action }).toEqual({ dialect, action: { enum: ['create', 'delete', 'archive'] } });
      expect({ dialect, target: properties.target }).toEqual({ dialect, target: { anyOf: [{ type: 'string' }, { type: 'integer' }] } });
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

    for (const dialect of ['openai', 'anthropic', 'gemini'] as const) {
      const properties = obj(sentSchema(dialect, values).properties);

      expect({ dialect, recursive: obj(properties.recursive).default, options: obj(properties.options).default, example: obj(properties.options).example })
        .toEqual({ dialect, recursive: true, options: { depth: 2, flags: { verbose: true }, anyOf: true }, example: { depth: 1 } });
    }

    for (const dialect of ['openai', 'anthropic'] as const) {
      const properties = obj(sentSchema(dialect, values).properties);

      expect({ dialect, strict: properties.strict, mode: properties.mode })
        .toEqual({ dialect, strict: { const: true }, mode: { type: 'string', enum: ['auto', 'manual'], default: 'auto', examples: ['auto'] } });
    }
  });

  test('the dialect follows the model, including through a gateway', () => {
    expect([
      'anthropic/claude-opus-4-7', 'openrouter/anthropic/claude-sonnet-4.6', 'openrouter/google/gemini-2.5-pro',
      'google/gemini-2.5-flash', 'openai/gpt-5.5', 'codex/gpt-5.5', 'openrouter/deepseek/deepseek-v4',
    ].map(toolSchemaDialect)).toEqual(['anthropic', 'anthropic', 'gemini', 'gemini', 'openai', 'openai', 'openai']);
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

  test('tools whose keys would collide are all offered, each under its own key', () => {
    // `a.b` and `a_b` sanitize alike; server `x_y` + tool `z` and server `x` + tool `y_z` join alike.
    const described = [['srv', 'a.b'], ['srv', 'a_b'], ['x_y', 'z'], ['x', 'y_z'], ['srv', 'plain']].map(([server = '', name = '']) => {
      const answer = describeMcpTool({ id: server, name: server }, { name, inputSchema: { type: 'object' } });

      if ('refused' in answer) throw new Error(answer.refused.reason);

      return answer.admitted;
    });

    const keys = admitMcpDescriptors(described, { contextWindow: 200_000, modelOutputLimit: null, nativeToolTokens: 0 })
      .admitted.map((descriptor) => descriptor.toolKey);

    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(keys.every((key) => key.length <= 64)).toBe(true);
    expect(keys).toContain('mcp_srv_plain');
  });
});

function obj(value: JsonObject[string] | undefined): JsonObject {
  return v.parse(JsonObjectSchema, value);
}

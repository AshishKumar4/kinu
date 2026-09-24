/**
 * `agents.*` on the cf backend: what the model is told it can call, and typed caps
 * (numbers) surviving the dispatcher's JSON crossing of the isolate boundary.
 */

import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import {
  decodeJsonValue,
  BUILTIN_TOOL_DESCRIPTIONS, CODEMODE_CODE_DESCRIPTION,
  createAgentsCodemodeProvider,
  parseJsonValue,
  type AgentsToolDeps,
  type JsonValue,
  type SubordinateHandoff,
  type WebSearchProvider,
} from '@kinu.run/core';
import { ROOT_DELEGATION_BUDGET } from '@kinu.run/core';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import * as v from 'valibot';

const codemodeHandoff: SubordinateHandoff = {
  eventId: 'evt-1', delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};

import { createTestRuntime, scriptedTurnModel } from '@kinu.run/test-utils';
import { hostedSeatsOver } from '../../core/tests/helpers-actor-host';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

// These reach `cloudflare:workers` at module load, so import them after the mock is registered.
const { resolveProvider } = await import('@cloudflare/codemode/ai');

const { createCodemodeToolFactory } = await import('../src/codemode-tool');

const SearchResultSchema = v.object({
  caps: v.object({
    branches: v.object({ value: v.number(), origin: v.string() }),
    depth: v.object({ value: v.number(), origin: v.string() }),
  }),
  report: v.object({ expansions: v.number(), tokens: v.nullable(v.number()) }),
});

function workerLoader(): WorkerLoader {
  return {
    get() { throw new Error('test loader is not executed'); },
    load() { throw new Error('test loader is not executed'); },
  };
}

function webSearchProvider(): WebSearchProvider {
  return {
    search: async (query: string) => ({ query, results: [], source: 'duckduckgo' }),
    fetch: async (url: string) => ({
      url,
      title: '',
      retrievedAt: new Date(0).toISOString(),
      markdown: '',
    }),
  };
}

/** The native surface handed to `toolFor` is one `file` tool, so `tools` has a member to assert on. */
function buildCodemode(agents?: () => AgentsToolDeps) {
  const { rt, testSql } = createTestRuntime();
  initCraftedToolsTables(testSql.sql);

  const options = {
    loader: workerLoader(),
    egress: null,
    rt,
    sql: testSql.sql,
    workspace: 'test-workspace',
    webSearch: webSearchProvider(),
  };

  const native = {
    file: tool({
      description: 'The file plane.',
      inputSchema: jsonSchema<{ action: string; path: string }>({
        type: 'object',
        properties: { action: { type: 'string' }, path: { type: 'string' } },
        required: ['action', 'path'],
      }),
      execute: async () => 'x',
    }),
  };

  return agents
    ? createCodemodeToolFactory({ ...options, agents }).toolFor(native)
    : createCodemodeToolFactory(options).toolFor(native);
}

function codemodeDescription(agents?: () => AgentsToolDeps): string {
  const built = buildCodemode(agents);

  if (!built.description) throw new Error('eval description is missing');

  return built.description;
}

/** 5 in + 3 out per expansion, so a run's total is arithmetic over expansion count. */
const PER_EXPANSION_TOKENS = 8;

/** `swarm` runs branches in this process off `rt` and `model`, so the model is the scripting seam. */
function expandingModel() {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-search',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'one approach' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 3, text: 3, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function searchOnlyDeps(): AgentsToolDeps {
  const { rt, testSql } = createTestRuntime();
  // Hosted actors over this fixture's one database: the seat factory is where a wave
  // would otherwise share one claim ledger and loop pointer.
  const seats = hostedSeatsOver({ rt, db: testSql.db });

  return { mode: 'build', swarm: { rt, hostNode: seats.hostNode, model: expandingModel() } };
}

function fullDeps(): AgentsToolDeps {
  return {
    ...searchOnlyDeps(),
    team: {
      delegation: ROOT_DELEGATION_BUDGET,
      snapshot: () => [],
      list: async () => [],
      create: async () => ({
        name: 'n',
        displayName: 'N',
        subordinate: { name: 'n', displayName: 'N', role: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      rename: async () => ({
        ok: true as const,
        name: 'n',
        displayName: 'N',
        subordinate: { name: 'n', displayName: 'N', role: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      recordTitle: async () => ({ ok: true as const, name: 'n', displayName: 'N', applied: true }),
      spawn: async () => ({ name: 'n', displayName: 'N' }),
      assign: async () => ({ ok: true as const, name: 'n', ...codemodeHandoff }),
      knows: async () => true,
      status: async () => ({}),
      message: async () => ({ ok: true as const, name: 'n', ...codemodeHandoff }),
      dismiss: async () => ({ ok: true, name: 'n', historyKept: true }),
    },
    peers: {
      listPeers: async () => [],
      ask: async () => ({ status: 'replied', from: 'a', reply: '' }),
      send: async () => ({ status: 'queued', message_id: 'm' }),
      reply: async () => ({ ok: true }),
      spawnWorkspace: async () => ({ agent: 'a', created: true, status: 'replied', from: 'a', reply: '' }),
    },
  };
}

// The model must receive the registry's eval description, not @cloudflare/codemode's
// DEFAULT_DESCRIPTION (whose example calls `codemode.searchWeb`, unbound here).

describe('the eval docstring the model receives', () => {
  test('carries the registry description, not the vendor default', () => {
    const description = codemodeDescription();
    expect(description).toContain(BUILTIN_TOOL_DESCRIPTIONS.eval);
    expect(description).not.toContain('Execute code to achieve a goal.');
    expect(description).not.toContain('codemode.searchWeb');
  });

  test('declares its own namespaces, and not the native tools a second time', () => {
    // Each native tool's schema is already in the request; `tools.<name>` takes that same input.
    const description = codemodeDescription();
    expect(description).toContain('export declare const state: {');
    expect(description).not.toContain('export declare const tools');
    expect(description).not.toContain('file(input:');
  });

  test('web.* is declared with its real positional signature', () => {
    // Without an explicit `types`, codemode generates an object-argument signature
    // while the implementation reads String(args[0]).
    const description = codemodeDescription();
    expect(description).toContain('export declare const web: {');
    expect(description).toContain('search(query: string, opts?: { limit?: number })');
    expect(description).toContain('fetch(url: string)');
    expect(description).not.toContain('type SearchInput = unknown');
  });

  test('a declaration reaches the model verbatim, `$` sequences included', () => {
    // `workspace.slates` names lifecycle members with `$`; a string `.replace` read "$`" as the text before the token.
    const types = "export declare const probe: {\n  /** Members named with `$` are lifecycle: $' and $& and $$ too. */\n  $preview(): Promise<unknown>;\n};";
    const { rt, testSql } = createTestRuntime();
    initCraftedToolsTables(testSql.sql);

    const built = createCodemodeToolFactory({
      loader: workerLoader(), egress: null, rt, sql: testSql.sql, workspace: 'test-workspace', webSearch: webSearchProvider(),
      extraProviders: () => [{ name: 'probe', tools: {}, types, positionalArgs: true }],
    }).toolFor({});

    expect(built.description).toContain(types);
  });

  test('the code field is labelled as the script body it actually is', () => {
    // The inputSchema is core's (codemodeInputSchema), so the field and the docstring cannot disagree.
    const built = buildCodemode();

    const schema = v.parse(v.object({
      jsonSchema: v.object({
        properties: v.object({ code: v.object({ description: v.string() }) }),
        required: v.array(v.string()),
      }),
    }), built.inputSchema).jsonSchema;

    expect(schema.properties.code.description).toBe(CODEMODE_CODE_DESCRIPTION);
    expect(schema.required).toEqual(['code']);
  });
});

describe('agents.* in the cf codemode tool', () => {
  test('the namespace is declared in the sandbox types the model reads', () => {
    const description = codemodeDescription(fullDeps);
    expect(description).toContain('export declare const agents: {');

    for (const member of ['swarm(input', 'hire(input', 'msg(input', 'list(input', 'dismiss(input']) {
      expect(description).toContain(member);
    }

    expect(description).toContain('export declare const web: {');
  });

  test('a search-only actor is told about swarm and nothing else', () => {
    const deps = searchOnlyDeps();
    const description = codemodeDescription(() => deps);
    expect(description).toContain('swarm(input');
    expect(description).not.toContain('hire(input');
    expect(description).not.toContain('dismiss(input');
  });

  test('an actor with no delegation deps has no agents namespace at all', () => {
    // The head shape: containment is the absent `agents` dep, as for the top-level tool.
    const description = codemodeDescription();
    expect(description).not.toContain('const agents');
    expect(description).toContain('export declare const web: {');
  });
});

describe('agents.swarm marshalled through the sandbox dispatcher', () => {
  /** Invoke through codemode's provider resolution with args JSON round-tripped as the dispatcher does. */
  async function sandboxSwarm(deps: AgentsToolDeps, input: JsonValue) {
    const { fns } = resolveProvider(createAgentsCodemodeProvider(() => deps));
    const swarm = v.parse(v.function(), fns.swarm);
    const roundTrippedInput = parseJsonValue(JSON.stringify(input));

    return decodeJsonValue({ value: await swarm(roundTrippedInput) });
  }

  test('the search input survives the dispatcher round-trip intact', async () => {
    // A number dropped or stringified on the crossing surfaces as `origin:'preset'`
    // with ideate's defaults, not a parse error.
    const result = v.parse(SearchResultSchema, await sandboxSwarm(searchOnlyDeps(), {
      task: 'review the diff', preset: 'ideate', branches: 2, depth: 1,
    }));

    expect(result.caps.branches).toEqual({ value: 2, origin: 'call' });
    expect(result.caps.depth).toEqual({ value: 1, origin: 'call' });
    expect(result.report.expansions).toBe(2);
    expect(result.report.tokens).toBe(2 * PER_EXPANSION_TOKENS);
  });
});

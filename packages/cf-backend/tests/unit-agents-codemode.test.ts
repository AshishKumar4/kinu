/**
 * `agents.*` on the cf backend — the namespace as codemode actually resolves
 * it, and the one thing about it that was genuinely unproven.
 *
 * Two subjects:
 *
 *   1. The tool the model reads. `createExecuteToolsTool` is the real one:
 *      @cloudflare/codemode composes the sandbox type block from each
 *      provider's declaration, so the assertions here are on what the model is
 *      literally told it can call — and on the actor kinds that are told
 *      nothing, because they were handed no delegation deps.
 *
 *   2. The dispatcher round-trip. A sandbox call's arguments cross the isolate
 *      boundary as JSON, so a member's typed non-string fields arrive only if
 *      that crossing carries them — and a branch count that arrived as a string
 *      reads back as a cap nobody set rather than as a marshalling fault.
 *      `agents.swarm` runs its branches IN-PROCESS on this origin plane and
 *      spawns no facet, so the crossing is the whole risk: the test below
 *      drives the real provider resolution with the argument array JSON
 *      round-tripped exactly as the dispatcher marshals it, and reads the
 *      resolved caps back off the answer.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  decodeJsonValue,
  BUILTIN_TOOL_DESCRIPTIONS,
  createAgentsCodemodeProvider,
  createProviderRegistry,
  createStrategyRegistry,
  parseJsonValue,
  type AgentsToolDeps,
  type JsonValue,
  type SubordinateHandoff,
  type WebSearchProvider,
} from '@proteus/core';
import { ROOT_DELEGATION_BUDGET } from '@proteus/core';
import * as v from 'valibot';
import type { AgentProviderRegistry } from '../src/providers/agent-registry';

/** The admission facts every handoff carries back to the sender. */
const codemodeHandoff: SubordinateHandoff = {
  eventId: 'evt-1', delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};
import { createTestRuntime } from '@proteus/test-utils';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// Every one of these reaches `cloudflare:workers` at module load, so they are
// imported after the mock is registered.
const { resolveProvider } = await import('@cloudflare/codemode/ai');
const { createExecuteToolsTool } = await import('../src/execute-tools');

/** A search's answer, narrowed to what the round-trip is read back off. */
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

function providerRegistry(): AgentProviderRegistry {
  const model = new MockLanguageModelV3();
  return {
    registry: createProviderRegistry(),
    deps: {
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    },
    resolveModel: () => model,
    normalizeSpecSync: (spec?: string | null) => spec ?? 'test/model',
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

/** The cf construction with only the pieces `createExecuteToolsTool` reaches:
 *  a craft store with nothing in it, no executors, and stub model/web seams. */
function executeToolsDescription(agents?: () => AgentsToolDeps): string {
  const { rt, testSql } = createTestRuntime();
  const options = {
    loader: workerLoader(),
    rt,
    sql: testSql.sql,
    registry: providerRegistry(),
    modelSpec: () => null,
    webSearch: webSearchProvider(),
  };
  const built = createExecuteToolsTool(options);
  if (agents) {
    const withAgents = createExecuteToolsTool({ ...options, agents });
    if (!withAgents.description) throw new Error('execute_tools description is missing');
    return withAgents.description;
  }
  if (!built.description) throw new Error('execute_tools description is missing');
  return built.description;
}

/** One expansion's provider-reported usage: 5 in + 3 out. A run's total is then
 *  arithmetic over the expansion count rather than a number read back off the
 *  thing under test. */
const PER_EXPANSION_TOKENS = 8;

/** A model that answers once per expansion. `swarm` runs its branches in THIS
 *  process off `rt` and `model`, so the model is the seam a search's behaviour
 *  is scripted through — there is no strategy in between to script instead. */
function expandingModel() {
  return new MockLanguageModelV3({
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
  const { rt } = createTestRuntime();
  // The registry is empty deliberately: `swarm` dispatches through no strategy,
  // so a registration here would be a fixture scripting a path the action does
  // not take. `AgentsForkDeps` still declares the field, so it is still passed.
  return { mode: 'build', fork: { registry: createStrategyRegistry(), rt, model: expandingModel() } };
}

function fullDeps(): AgentsToolDeps {
  return {
    ...searchOnlyDeps(),
    team: {
      delegation: ROOT_DELEGATION_BUDGET,
      list: async () => [],
      create: async () => ({
        name: 'n',
        displayName: 'N',
        subordinate: {
          name: 'n', displayName: 'N', role: 'researcher', createdBy: 'user', status: 'idle',
          currentTask: null, createdAt: 1, dismissedAt: null,
        },
      }),
      spawn: async () => ({ name: 'n', displayName: 'N' }),
      assign: async () => ({ ok: true as const, name: 'n', ...codemodeHandoff }),
      status: async () => ({}),
      message: async () => ({ ok: true as const, name: 'n', ...codemodeHandoff }),
      dismiss: async () => ({ ok: true, name: 'n', historyKept: true }),
    },
    peers: {
      listPeers: async () => [],
      ask: async () => ({ status: 'no_reply', note: '' }),
      send: async () => ({ status: 'queued', message_id: 'm' }),
      reply: async () => ({ ok: true }),
      spawnWorkspace: async () => ({ agent: 'a', created: true, status: 'no_reply', note: '' }),
    },
  };
}

// ── The execute_tools docstring itself ──────────────────────────────────────
// This tool's description used to be @cloudflare/codemode's DEFAULT_DESCRIPTION:
// createExecuteToolsTool passed none, so the model received "Execute code to
// achieve a goal." and NOTHING from BUILTIN_TOOL_SPECS.execute_tools — no
// Use-when, no Avoid-when, no workspace doctrine, no Returns — plus a worked
// example calling `codemode.searchWeb(...)`, the exact shape
// craftedDispatcherEntry is written to throw on. Both halves are asserted here
// because both were absent from any test: the registry's doctrine, and the
// namespace declarations it wraps.

describe('the execute_tools docstring the model receives', () => {
  test('carries the registry doctrine, not the vendor default', () => {
    const description = executeToolsDescription();
    expect(description).toContain(BUILTIN_TOOL_DESCRIPTIONS.execute_tools);
    expect(description).toContain('Use when:');
    expect(description).toContain('Avoid when:');
    expect(description).toContain('Returns:');
    // The workspace doctrine — the sentence that tells the model `workspace.*`
    // and the `file` tool address the same bytes.
    expect(description).toContain('canonical durable workspace');
    expect(description).not.toContain('Execute code to achieve a goal.');
    // The vendor's example named a member Proteus makes throw.
    expect(description).not.toContain('codemode.searchWeb');
  });

  test('states what the sandbox is without constraining the code shape', () => {
    // The shape is deliberately unconstrained now that injectPreamble reaches
    // every shape; the two facts that remain are runtime facts.
    const description = executeToolsDescription();
    expect(description).toContain('JavaScript isolate');
    expect(description).toContain('Type annotations, interfaces and generics do not parse');
  });

  test('web.* is declared with its real positional signature', () => {
    // Without an explicit `types`, codemode generates `search: (input:
    // SearchInput) => Promise<SearchOutput>` from an absent input schema — an
    // object-argument signature, while the implementation reads String(args[0]).
    const description = executeToolsDescription();
    expect(description).toContain('export declare const web: {');
    expect(description).toContain('search(query: string, opts?: { limit?: number })');
    expect(description).toContain('fetch(url: string)');
    expect(description).not.toContain('type SearchInput = unknown');
  });
});

// ── What the model is told it can call ─────────────────────────────────────

describe('agents.* in the cf codemode tool', () => {
  test('the namespace is declared in the sandbox types the model reads', () => {
    const description = executeToolsDescription(fullDeps);
    expect(description).toContain('export declare const agents: {');
    for (const member of ['swarm(input', 'hire(input', 'ask(input', 'send(input', 'reply(input', 'list(input', 'dismiss(input']) {
      expect(description).toContain(member);
    }
    // Its neighbours are untouched — this is one more namespace, not a rewrite.
    expect(description).toContain('export declare const llm: {');
  });

  test('a search-only actor is told about swarm and nothing else', () => {
    const deps = searchOnlyDeps();
    const description = executeToolsDescription(() => deps);
    expect(description).toContain('swarm(input');
    expect(description).not.toContain('hire(input');
    expect(description).not.toContain('dismiss(input');
    // The cost of searching in-sandbox is in the docstring, not only the prompt.
    expect(description).toContain('NOT resumable from here');
  });

  test('an actor with no delegation deps has no agents namespace at all', () => {
    // The head shape: `createExecuteToolsTool` without `agents`. Containment
    // is the absent dep, exactly as it is for the top-level tool.
    const description = executeToolsDescription();
    expect(description).not.toContain('const agents');
    expect(description).toContain('export declare const llm: {');
  });
});

// ── The dispatcher round-trip across the isolate boundary ───────────────────

describe('agents.swarm marshalled through the sandbox dispatcher', () => {
  /** Invoke the namespace the way the sandbox does: through codemode's own
   *  provider resolution, with the argument array JSON round-tripped as the
   *  dispatcher marshals it across the isolate boundary. */
  async function sandboxSwarm(deps: AgentsToolDeps, input: JsonValue) {
    const { fns } = resolveProvider(createAgentsCodemodeProvider(() => deps));
    const swarm = v.parse(v.function(), fns.swarm);
    const roundTrippedInput = parseJsonValue(JSON.stringify(input));
    return decodeJsonValue({ value: await swarm(roundTrippedInput) });
  }

  test('the search input survives the dispatcher round-trip intact', async () => {
    // `branches` and `depth` are the fields with something to lose on the way
    // across: they are NUMBERS, and the resolver reports where each cap's value
    // came from. So a crossing that dropped one, or handed it over as a string,
    // comes back as `origin:'preset'` carrying ideate's own defaults rather than
    // as a parse complaint — which is exactly the failure a round-trip test has
    // to be able to see.
    const result = v.parse(SearchResultSchema, await sandboxSwarm(searchOnlyDeps(), {
      task: 'review the diff', preset: 'ideate', branches: 2, depth: 1,
    }));
    expect(result.caps.branches).toEqual({ value: 2, origin: 'call' });
    expect(result.caps.depth).toEqual({ value: 1, origin: 'call' });
    // And the caps that arrived are the ones the run was actually governed by:
    // two branches expanded, each charging one expansion's reported usage.
    expect(result.report.expansions).toBe(2);
    expect(result.report.tokens).toBe(2 * PER_EXPANSION_TOKENS);
  });
});

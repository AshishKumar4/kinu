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
 *   2. Reentrancy. An in-sandbox `agents.fork` calls back into the DO while
 *      the DO is awaiting the sandbox, and that callback spawns facets.
 *      `workspace.exec` / `llm.query` already prove the callback path itself;
 *      what is new is a callback that spawns a head. This drives the real
 *      `spawnHeadFacet` from inside an in-flight sandbox call against the
 *      recording facet host, which proves the APPLICATION layer holds no
 *      guard against it — the busy check that rejects `forkAgent` mid-turn
 *      sits on the workspace-clone RPC, not here. The workerd RPC isolate
 *      cannot be run in this harness, so that layer stays a live probe.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  decodeJsonValue,
  FORK_STRATEGY_ID,
  BUILTIN_TOOL_DESCRIPTIONS,
  createAgentsCodemodeProvider,
  createProviderRegistry,
  createStrategyRegistry,
  parseJsonValue,
  strategyOption,
  type AgentsToolDeps,
  type HeadInput,
  type HeadReport,
  type JsonValue,
  type StrategyContext,
  type SubordinateHandoff,
  type WebSearchProvider,
} from '@proteus/core';
import * as v from 'valibot';
import type { AgentProviderRegistry } from '../src/providers/agent-registry.js';

/** The admission facts every handoff carries back to the sender. */
const codemodeHandoff: SubordinateHandoff = {
  eventId: 'evt-1', delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};
import { createTestRuntime } from '@proteus/test-utils';
import { mockAgentsSdk } from './helpers/agents-sdk.js';

mockAgentsSdk();
// Every one of these reaches `cloudflare:workers` at module load, so they are
// imported after the mock is registered.
const { resolveProvider } = await import('@cloudflare/codemode/ai');
const { createExecuteToolsTool } = await import('../src/execute-tools.ts');
const { ExplorationAgent } = await import('../src/exploration.ts');
const { spawnHeadFacet } = await import('../src/facet-spawn.ts');
type FacetHost = Parameters<typeof spawnHeadFacet>[0];

const ForkResultSchema = v.object({ text: v.string() });

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

function forkOnlyDeps(explore?: (ctx: StrategyContext) => Promise<JsonValue>): AgentsToolDeps {
  const registry = createStrategyRegistry();
  registry.register({
    id: FORK_STRATEGY_ID,
    async explore(ctx) {
      const detail = await explore?.(ctx);
      return {
        strategy: FORK_STRATEGY_ID,
        best: { text: JSON.stringify(detail ?? 'settled'), score: 1, source: FORK_STRATEGY_ID },
        all: [],
        cost: { durationMs: 0 },
      };
    },
  });
  const { rt } = createTestRuntime();
  return { mode: 'build', fork: { registry, rt, model: new MockLanguageModelV3() } };
}

function fullDeps(): AgentsToolDeps {
  return {
    ...forkOnlyDeps(),
    team: {
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
    for (const member of ['fork(input', 'staff(input', 'ask(input', 'send(input', 'reply(input', 'list(input', 'dismiss(input']) {
      expect(description).toContain(member);
    }
    // Its neighbours are untouched — this is one more namespace, not a rewrite.
    expect(description).toContain('export declare const llm: {');
  });

  test('a fork-only actor is told about fork and nothing else', () => {
    const deps = forkOnlyDeps();
    const description = executeToolsDescription(() => deps);
    expect(description).toContain('fork(input');
    expect(description).not.toContain('staff(input');
    expect(description).not.toContain('dismiss(input');
    // The cost of forking in-sandbox is in the docstring, not only the prompt.
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

// ── Reentrancy: a sandbox callback that spawns facets ───────────────────────

describe('agents.fork called back from an in-flight sandbox call', () => {
  const headReport: HeadReport = {
    id: 'head-1', status: 'completed', summary: 'done', evidence: [], decisions: [],
    artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
    tokenUsage: { input: 1, output: 1, total: 2 }, wallClockMs: 1,
  };

  function headInput(): HeadInput {
    return {
      id: 'head-1', rootId: 'root-1', parentId: null, depth: 1,
      task: 'investigate', mode: 'build', rationale: 'one angle', inheritedContext: [],
      budget: { maxDepth: 1, maxWallClockMs: 1000, spawnedAt: 0 },
      mergeStrategy: 'synthesize',
    };
  }

  interface FacetStub {
    setOwner(): Promise<{ ok: boolean }>;
    setSharedParent(): Promise<{ ok: boolean }>;
    initHead(): Promise<{ ok: boolean }>;
    abortHead(): Promise<{ ok: boolean }>;
    runAsHead(): Promise<HeadReport>;
  }

  interface FacetHostProbe {
    subAgent(cls: typeof ExplorationAgent, name: string): Promise<FacetStub>;
    abortSubAgent(): void;
  }

  function facetHost(probe: FacetHostProbe): FacetHost {
    const host: Partial<FacetHost> = {};
    Object.assign(host, probe);
    // SAFETY: the constructed probe implements the two methods spawnHeadFacet
    // invokes; every returned facet method is explicitly typed above.
    return host as FacetHost;
  }

  /** The recording facet host — the Agent SDK is the only thing stubbed. */
  function makeHost() {
    const calls: string[] = [];
    const stub = {
      setOwner: async () => ({ ok: true }),
      setSharedParent: async () => ({ ok: true }),
      initHead: async () => ({ ok: true }),
      abortHead: async () => ({ ok: true }),
      runAsHead: async () => { calls.push('runAsHead'); return headReport; },
    };
    const host: FacetHostProbe = {
      subAgent: async (_cls, name) => { calls.push(`subAgent:${name}`); return stub; },
      abortSubAgent: () => { calls.push('abortSubAgent'); },
    };
    return { host: facetHost(host), calls };
  }

  /** Invoke the namespace the way the sandbox does: through codemode's own
   *  provider resolution, with the argument array JSON round-tripped as the
   *  dispatcher marshals it across the isolate boundary. */
  async function sandboxFork(deps: AgentsToolDeps, input: JsonValue) {
    const { fns } = resolveProvider(createAgentsCodemodeProvider(() => deps));
    const fork = v.parse(v.function(), fns.fork);
    const roundTrippedInput = parseJsonValue(JSON.stringify(input));
    return decodeJsonValue({ value: await fork(roundTrippedInput) });
  }

  test('the fork input survives the dispatcher round-trip intact', async () => {
    let seen: StrategyContext | undefined;
    const deps = forkOnlyDeps(async (ctx) => { seen = ctx; return null; });
    await sandboxFork(deps, {
      task: 'review the diff',
      forks: [{ task: 'read it', rationale: 'ground it' }, { task: 'test it', rationale: 'check it' }],
      budget: 12,
    });
    expect(seen?.task).toBe('review the diff');
    expect(seen?.budget?.maxIterations).toBe(12);
    expect(strategyOption(seen?.options, 'heads')).toEqual({
      heads: [
        { task: 'read it', rationale: 'ground it' },
        { task: 'test it', rationale: 'check it' },
      ],
    });
  });

  test('the callback spawns, runs and tears down a head facet while the outer call awaits', async () => {
    const { host, calls } = makeHost();
    // The fork strategy does what the heads strategy does — spawn a facet —
    // so the spawn happens INSIDE the provider callback, which is what an
    // in-sandbox fork makes happen inside an awaited execute_tools call.
    const deps = forkOnlyDeps(async () => {
      const head = await spawnHeadFacet(host, headInput(), {
        ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'proteus-main',
      });
      const report = await head.run();
      await head.abort('done');
      return report.summary;
    });

    let outerSettled = false;
    // The enclosing execute_tools call is still awaiting when the callback runs.
    const outer = sandboxFork(deps, { task: 'investigate' }).then((result) => {
      outerSettled = true;
      return result;
    });
    expect(outerSettled).toBe(false);

    const result = v.parse(ForkResultSchema, await outer);
    expect(parseJsonValue(result.text)).toBe('done');
    expect(calls).toEqual(['subAgent:head-1', 'runAsHead', 'abortSubAgent']);
  });

  test('two forks scripted in parallel each get their own facet', async () => {
    const { host, calls } = makeHost();
    const deps = forkOnlyDeps(async (ctx) => {
      const head = await spawnHeadFacet(host, { ...headInput(), id: ctx.task }, {
        ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'proteus-main',
      });
      await head.run();
      await head.abort('done');
      return ctx.task;
    });
    await Promise.all([
      sandboxFork(deps, { task: 'a' }),
      sandboxFork(deps, { task: 'b' }),
    ]);
    expect(calls.filter((c) => c.startsWith('subAgent:')).sort()).toEqual(['subAgent:a', 'subAgent:b']);
    expect(calls.filter((c) => c === 'abortSubAgent')).toHaveLength(2);
  });

  test('heads spawn the bare ExplorationAgent, so an in-sandbox fork cannot widen the spawn tree', async () => {
    const spawned: Array<typeof ExplorationAgent> = [];
    const host: FacetHostProbe = {
      subAgent: async (cls) => {
        spawned.push(cls);
        return {
          setOwner: async () => ({ ok: true }),
          setSharedParent: async () => ({ ok: true }),
          initHead: async () => ({ ok: true }),
          abortHead: async () => ({ ok: true }),
          runAsHead: async () => headReport,
        };
      },
      abortSubAgent: () => {},
    };
    const deps = forkOnlyDeps(async () => {
      await spawnHeadFacet(facetHost(host), headInput(), {
        ownerUserId: 'u',
        capabilityToken: null,
        sharedParent: 'p',
      });
      return null;
    });
    await sandboxFork(deps, { task: 't' });
    expect(spawned).toEqual([ExplorationAgent]);
  });
});

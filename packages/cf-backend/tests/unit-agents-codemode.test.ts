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
import type { SubordinateHandoff } from '@proteus/core';

/** The admission facts every handoff carries back to the sender. */
const codemodeHandoff: SubordinateHandoff = {
  eventId: 'evt-1', delivery: 'starts_now',
  phase: { busy: false, lastActivityAt: null, workingOn: null },
};
import {
  FORK_STRATEGY_ID, createAgentsCodemodeProvider, createStrategyRegistry,
  type AgentsToolDeps, type HeadInput, type HeadReport, type StrategyContext,
} from '@proteus/core';
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

/** The cf construction with only the pieces `createExecuteToolsTool` reaches:
 *  a craft store with nothing in it, no executors, and stub model/web seams. */
function executeToolsTool(agents?: () => AgentsToolDeps): { description: string } {
  const built = createExecuteToolsTool({
    loader: {},
    rt: { craftStore: { list: () => [] }, executionRouter: undefined } as never,
    sql: (() => { throw new Error('no craft_scores table'); }) as never,
    registry: { normalizeSpecSync: (s?: string | null) => s ?? 'm', resolveModel: () => ({}) } as never,
    modelSpec: () => null,
    webSearch: { search: async () => [], fetch: async () => ({ title: '', markdown: '' }) } as never,
    ...(agents ? { agents } : {}),
  });
  return built as { description: string };
}

function forkOnlyDeps(explore?: (ctx: StrategyContext) => Promise<unknown>): AgentsToolDeps {
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
  return { fork: { registry, rt, model: rt.llm as never } };
}

function fullDeps(): AgentsToolDeps {
  return {
    ...forkOnlyDeps(),
    team: {
      list: async () => [],
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

// ── What the model is told it can call ─────────────────────────────────────

describe('agents.* in the cf codemode tool', () => {
  test('the namespace is declared in the sandbox types the model reads', () => {
    const description = executeToolsTool(fullDeps).description;
    expect(description).toContain('export declare const agents: {');
    for (const member of ['fork(input', 'staff(input', 'ask(input', 'send(input', 'reply(input', 'list(input', 'dismiss(input']) {
      expect(description).toContain(member);
    }
    // Its neighbours are untouched — this is one more namespace, not a rewrite.
    expect(description).toContain('export declare const llm: {');
  });

  test('a fork-only actor is told about fork and nothing else', () => {
    const deps = forkOnlyDeps();
    const description = executeToolsTool(() => deps).description;
    expect(description).toContain('fork(input');
    expect(description).not.toContain('staff(input');
    expect(description).not.toContain('dismiss(input');
    // The cost of forking in-sandbox is in the docstring, not only the prompt.
    expect(description).toContain('NOT resumable from here');
  });

  test('an actor with no delegation deps has no agents namespace at all', () => {
    // The head shape: `createExecuteToolsTool` without `agents`. Containment
    // is the absent dep, exactly as it is for the top-level tool.
    const description = executeToolsTool().description;
    expect(description).not.toContain('const agents');
    expect(description).toContain('export declare const llm: {');
  });
});

// ── Reentrancy: a sandbox callback that spawns facets ───────────────────────

describe('agents.fork called back from an in-flight sandbox call', () => {
  const headReport: HeadReport = {
    id: 'head-1', status: 'completed', summary: 'done', evidence: [], decisions: [],
    artifactRefs: [], childHeadIds: [], toolCalls: [], steps: [],
    tokenUsage: { input: 1, output: 1, total: 2 }, wallClockMs: 1,
  };

  function headInput(): HeadInput {
    return {
      id: 'head-1', rootId: 'root-1', parentId: null, depth: 1,
      task: 'investigate', rationale: 'one angle', inheritedContext: [],
      budget: { maxDepth: 1, maxWallClockMs: 1000, spawnedAt: 0 },
      mergeStrategy: 'synthesize',
    };
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
    const host = {
      subAgent: async (_cls: unknown, name: string) => { calls.push(`subAgent:${name}`); return stub; },
      abortSubAgent: () => { calls.push('abortSubAgent'); },
    };
    return { host: host as unknown as FacetHost, calls };
  }

  /** Invoke the namespace the way the sandbox does: through codemode's own
   *  provider resolution, with the argument array JSON round-tripped as the
   *  dispatcher marshals it across the isolate boundary. */
  function sandboxCall(deps: AgentsToolDeps): (member: string, ...args: unknown[]) => Promise<unknown> {
    const { fns } = resolveProvider(createAgentsCodemodeProvider(() => deps) as never);
    return (member, ...args) => fns[member](...JSON.parse(JSON.stringify(args)) as unknown[]);
  }

  test('the fork input survives the dispatcher round-trip intact', async () => {
    let seen: StrategyContext | undefined;
    const deps = forkOnlyDeps(async (ctx) => { seen = ctx; return null; });
    await sandboxCall(deps)('fork', {
      task: 'review the diff',
      forks: [{ task: 'read it', rationale: 'ground it' }, { task: 'test it', rationale: 'check it' }],
      budget: 12,
    });
    expect(seen?.task).toBe('review the diff');
    expect(seen?.budget?.maxIterations).toBe(12);
    expect((seen?.options?.heads as { heads: unknown[] }).heads).toHaveLength(2);
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
    const outer = sandboxCall(deps)('fork', { task: 'investigate' }).then((r) => {
      outerSettled = true;
      return r;
    });
    expect(outerSettled).toBe(false);

    const result = await outer as { text: string };
    expect(JSON.parse(result.text)).toBe('done');
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
    const call = sandboxCall(deps);
    await Promise.all([call('fork', { task: 'a' }), call('fork', { task: 'b' })]);
    expect(calls.filter((c) => c.startsWith('subAgent:')).sort()).toEqual(['subAgent:a', 'subAgent:b']);
    expect(calls.filter((c) => c === 'abortSubAgent')).toHaveLength(2);
  });

  test('heads spawn the bare ExplorationAgent, so an in-sandbox fork cannot widen the spawn tree', async () => {
    const spawned: unknown[] = [];
    const host = {
      subAgent: async (cls: unknown) => {
        spawned.push(cls);
        return { setOwner: async () => ({}), setSharedParent: async () => ({}), initHead: async () => ({}) };
      },
      abortSubAgent: () => {},
    } as unknown as FacetHost;
    const deps = forkOnlyDeps(async () => {
      await spawnHeadFacet(host, headInput(), { ownerUserId: 'u', capabilityToken: null, sharedParent: 'p' });
      return null;
    });
    await sandboxCall(deps)('fork', { task: 't' });
    expect(spawned).toEqual([ExplorationAgent]);
  });
});

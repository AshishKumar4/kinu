/**
 * A running MCTS search has to be VISIBLE while it runs.
 *
 * The regression this pins: `runMCTS` has always taken an `onProgress` sink,
 * and the CF backend has always broadcast from it — but the only caller that
 * ever supplied one was the lifetime evolution cycle. Every search an operator
 * actually starts goes through the `agents` fork action → the MCTS
 * ExplorationStrategy, and that path dropped the sink on the floor. So a
 * twelve-hour search emitted nothing, and its tree changed only when some
 * surface happened to poll.
 *
 * Two links, tested separately because either one alone is useless:
 *   1. the fork substrate resolves the sink per fork call, at dispatch
 *      (`buildStrategyForkDeps`), exactly like heads' onPhase;
 *   2. the strategy forwards it into `runMCTS`, and events arrive while the
 *      search is still running — with the tree already grown when they do.
 */
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import { buildStrategyForkDeps, type ForkDepsWiring } from '../src/orchestrator/fork-deps.js';
import { createMCTSStrategy } from '../src/strategy/mcts.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import type { MCTSProgressEvent } from '../src/types/mcts.js';
import { HeadController } from '../src/heads/controller.js';
import { HeadJournal } from '../src/heads/journal.js';
import { MctsSearchStore } from '../src/mcts/search-store.js';
import type { AgentsForkDeps } from '../src/tools/agents-tool.js';
import { createTestRuntime, createMockSession } from './helpers.js';

function forkWiring(
  rt: ForkDepsWiring['rt'],
  onProgress?: ForkDepsWiring['mcts']['onProgress'],
): ForkDepsWiring {
  const controller = new HeadController({
    spawnHead: async () => { throw new Error('not exercised by MCTS progress tests'); },
    mergeLLM: async () => { throw new Error('not exercised by MCTS progress tests'); },
  }, new HeadJournal(rt.storage.sql));
  return {
    rt,
    model: new MockLanguageModelV3(),
    mcts: {
      session: () => createMockSession(),
      search: new MctsSearchStore(rt.storage.sql),
      overrides: () => ({}),
      onProgress,
    },
    heads: {
      controller: () => controller,
      inheritedContext: () => [],
      onPhase: () => () => {},
      onComplete: () => {},
    },
  };
}

function progressSink(deps: AgentsForkDeps): ((event: MCTSProgressEvent) => void) | undefined {
  const mcts = deps.defaultOptions?.().mcts;
  const parsed = v.parse(v.object({ onProgress: v.optional(v.function()) }), mcts);
  const { onProgress } = parsed;
  if (!onProgress) return undefined;
  return (event) => { onProgress(event); };
}

function defaultMctsOptions(deps: AgentsForkDeps): object {
  const mcts = deps.defaultOptions?.().mcts;
  return v.parse(v.looseObject({ onProgress: v.optional(v.function()) }), mcts);
}

describe('the fork substrate carries the MCTS progress sink', () => {
  test('defaultOptions() resolves the onProgress factory once per fork call', () => {
    const { rt } = createTestRuntime();
    let factoryCalls = 0;
    const deps = buildStrategyForkDeps(forkWiring(rt, () => {
      factoryCalls++;
      return () => {};
    }));

    const first = progressSink(deps);
    expect(factoryCalls).toBe(1);
    // Firing events does not re-invoke the factory — the closure resolved at
    // dispatch serves the whole search, however long it detaches for.
    if (!first) throw new Error('expected progress sink');
    first({ rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 3, branches: 2 });
    first({ rootId: 'r1', type: 'iteration-complete', iteration: 1, remainingBudget: 2, scores: [0.5] });
    expect(factoryCalls).toBe(1);

    defaultMctsOptions(deps);
    expect(factoryCalls).toBe(2);
  });

  test('a backend that wires no sink leaves onProgress absent rather than undefined-valued', () => {
    const { rt } = createTestRuntime();
    const options = defaultMctsOptions(buildStrategyForkDeps(forkWiring(rt)));
    expect('onProgress' in options).toBe(false);
  });

  test('the value a factory captures at dispatch survives a later change to the live source', () => {
    const { rt } = createTestRuntime();
    let liveRun: string | null = 'run-A';
    const seen: Array<string | null> = [];
    const deps = buildStrategyForkDeps(forkWiring(rt, () => {
      const captured = liveRun;
      return () => seen.push(captured);
    }));
    const onProgress = progressSink(deps);
    if (!onProgress) throw new Error('expected progress sink');

    onProgress({ rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 2, branches: 1 });
    liveRun = null; // the calling turn closed while the detached search ran on
    onProgress({ rootId: 'r1', type: 'iteration-complete', iteration: 1, remainingBudget: 1, scores: [0.5] });

    expect(seen).toEqual(['run-A', 'run-A']);
  });
});

describe('the MCTS strategy reports progress while the search runs', () => {
  test('events arrive per iteration, and the tree has already grown when they do', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach' }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);

    const events: MCTSProgressEvent[] = [];
    // Node count observed at the moment each 'evaluate' phase was reported —
    // proof the broadcast a surface receives carries a tree that is actually
    // advancing, not one that only settles at the end.
    const nodesAtEvaluate: number[] = [];

    const strategy = createMCTSStrategy();
    await strategy.explore({
      task: 'pick an approach',
      mode: 'build',
      rt,
      model: new MockLanguageModelV3(),
      budget: { maxIterations: 2 },
      options: {
        mcts: {
          session: createMockSession(),
          branches: 2,
          onProgress: (event: MCTSProgressEvent) => {
            events.push(event);
            if (event.type === 'phase' && event.phase === 'evaluate') {
              nodesAtEvaluate.push(
                rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_nodes`[0]?.n ?? 0,
              );
            }
          },
        },
      },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'explore')).toBe(true);
    expect(events.some((e) => e.type === 'iteration-complete')).toBe(true);
    // The first evaluate already sees the root plus its two fresh branches.
    expect(nodesAtEvaluate[0]).toBeGreaterThanOrEqual(3);
    // And the tree keeps growing across iterations rather than arriving whole.
    expect(nodesAtEvaluate.at(-1)).toBeGreaterThan(nodesAtEvaluate[0] ?? 0);
  });

  test('a strategy call with no sink runs identically — the option is optional', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach' }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);

    const result = await strategyWithoutSink(rt);
    expect(result.strategy).toBe('mcts');
  });
});

function strategyWithoutSink(rt: ReturnType<typeof createTestRuntime>['rt']) {
  return createMCTSStrategy().explore({
    task: 'pick an approach',
    mode: 'build',
    rt,
    model: new MockLanguageModelV3(),
    budget: { maxIterations: 1 },
    options: { mcts: { session: createMockSession(), branches: 1 } },
  });
}

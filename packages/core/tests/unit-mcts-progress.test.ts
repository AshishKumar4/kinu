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
import { buildStrategyForkDeps, type ForkDepsWiring } from '../src/orchestrator/fork-deps.js';
import { createMCTSStrategy } from '../src/strategy/mcts.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import type { MCTSProgressEvent } from '../src/types/mcts.js';
import { createTestRuntime, createMockSession } from './helpers.js';

function forkWiring(
  rt: ForkDepsWiring['rt'],
  onProgress?: ForkDepsWiring['mcts']['onProgress'],
): ForkDepsWiring {
  return {
    rt,
    model: rt.llm as never,
    mcts: {
      session: () => createMockSession(),
      search: {} as never,
      overrides: () => ({}),
      ...(onProgress ? { onProgress } : {}),
    },
    heads: {
      controller: () => ({}) as never,
      inheritedContext: () => [],
      onPhase: () => () => {},
      onComplete: () => {},
    },
  };
}

type MctsOptions = { mcts: { onProgress?: (event: MCTSProgressEvent) => void } };

describe('the fork substrate carries the MCTS progress sink', () => {
  test('defaultOptions() resolves the onProgress factory once per fork call', () => {
    const { rt } = createTestRuntime();
    let factoryCalls = 0;
    const deps = buildStrategyForkDeps(forkWiring(rt, () => {
      factoryCalls++;
      return () => {};
    }));

    const first = deps.defaultOptions!() as MctsOptions;
    expect(factoryCalls).toBe(1);
    // Firing events does not re-invoke the factory — the closure resolved at
    // dispatch serves the whole search, however long it detaches for.
    first.mcts.onProgress!({ type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 3, branches: 2 });
    first.mcts.onProgress!({ type: 'iteration-complete', iteration: 1, remainingBudget: 2, scores: [0.5] });
    expect(factoryCalls).toBe(1);

    deps.defaultOptions!();
    expect(factoryCalls).toBe(2);
  });

  test('a backend that wires no sink leaves onProgress absent rather than undefined-valued', () => {
    const { rt } = createTestRuntime();
    const options = buildStrategyForkDeps(forkWiring(rt)).defaultOptions!() as MctsOptions;
    expect('onProgress' in options.mcts).toBe(false);
  });

  test('the value a factory captures at dispatch survives a later change to the live source', () => {
    const { rt } = createTestRuntime();
    let liveRun: string | null = 'run-A';
    const seen: Array<string | null> = [];
    const deps = buildStrategyForkDeps(forkWiring(rt, () => {
      const captured = liveRun;
      return () => seen.push(captured);
    }));
    const options = deps.defaultOptions!() as MctsOptions;

    options.mcts.onProgress!({ type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 2, branches: 1 });
    liveRun = null; // the calling turn closed while the detached search ran on
    options.mcts.onProgress!({ type: 'iteration-complete', iteration: 1, remainingBudget: 1, scores: [0.5] });

    expect(seen).toEqual(['run-A', 'run-A']);
  });
});

describe('the MCTS strategy reports progress while the search runs', () => {
  test('events arrive per iteration, and the tree has already grown when they do', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach', codeUsed: null }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const events: MCTSProgressEvent[] = [];
    // Node count observed at the moment each 'evaluate' phase was reported —
    // proof the broadcast a surface receives carries a tree that is actually
    // advancing, not one that only settles at the end.
    const nodesAtEvaluate: number[] = [];

    const strategy = createMCTSStrategy();
    await strategy.explore({
      task: 'pick an approach',
      rt,
      model: rt.llm as never,
      budget: { maxIterations: 2 },
      options: {
        mcts: {
          session: createMockSession(),
          branches: 2,
          onProgress: (event: MCTSProgressEvent) => {
            events.push(event);
            if (event.type === 'phase' && event.phase === 'evaluate') {
              nodesAtEvaluate.push(
                rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_nodes`[0]!.n,
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
    expect(nodesAtEvaluate[nodesAtEvaluate.length - 1]).toBeGreaterThan(nodesAtEvaluate[0]!);
  });

  test('a strategy call with no sink runs identically — the option is optional', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach', codeUsed: null }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const result = await strategyWithoutSink(rt);
    expect(result.strategy).toBe('mcts');
  });
});

function strategyWithoutSink(rt: ReturnType<typeof createTestRuntime>['rt']) {
  return createMCTSStrategy().explore({
    task: 'pick an approach',
    rt,
    model: rt.llm as never,
    budget: { maxIterations: 1 },
    options: { mcts: { session: createMockSession(), branches: 1 } },
  });
}

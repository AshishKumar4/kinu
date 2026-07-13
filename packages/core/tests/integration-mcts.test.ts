/**
 * Integration test: full MCTS cycle with real in-memory SQLite.
 * Mock LLM + Executor, but real SQL tables, real UCT, real backprop,
 * real grounded evaluation (engine-seam evaluator, not branch self-rating).
 *
 * Verifies: init → select → expand → evaluate → backpropagate → prune → converge
 * Plus: execution grounding dominates, judge knobs respected, tree shape.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession } from './helpers.js';
import { runMCTS } from '../src/mcts/engine.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import type { SearchNode } from '../src/types/mcts.js';
import type { Executor, LLM } from '../src/types/primitives.js';

/** Executor that fails any code containing FAIL_MARKER, passes the rest. */
function markerExecutor(): Executor {
  return {
    async execute(code: string) {
      return String(code).includes('FAIL_MARKER')
        ? { result: undefined, error: 'marker assertion failed' }
        : { result: true };
    },
  } as unknown as Executor;
}

/** LLM whose complete() always returns `json` and counts judge-prompt calls. */
function countingLLM(json: string): LLM & { judgeCalls: () => number } {
  let judgeCalls = 0;
  return {
    judgeCalls: () => judgeCalls,
    async *stream() { yield json; },
    async complete(prompt: string) {
      if (prompt.includes('scoring ONE candidate')) judgeCalls++;
      return json;
    },
  };
}

function initTables(rt: ReturnType<typeof createTestRuntime>['rt']) {
  initSearchTables(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initCraftScoreTables(rt.storage.execRaw);
}

describe('MCTS integration', () => {
  test('DO-NOW #1: sibling diversity — each branch in an expansion gets a DISTINCT prompt naming the other branch angles', async () => {
    const { rt } = createTestRuntime();
    // Capture the siblings arg each branch received in its expansion.
    const seenSiblings: Array<readonly string[]> = [];
    let i = 0;
    rt.spawnBranch = async () => {
      const idx = i++;
      return {
        explore: async (_history, _tools, siblings = []) => {
          seenSiblings.push(siblings);
          // Echo the received sibling angles into the proposal text so we can
          // assert downstream that explore actually consumed them.
          return { text: `branch ${idx} differs from: ${siblings.join(' | ')}`, codeUsed: null };
        },
        generateReflection: async () => 'n/a',
      };
    };

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'pick a strategy', { budget: 1, branches: 2 });

    // Two branches in one expansion.
    expect(seenSiblings.length).toBe(2);
    // Each branch received exactly one sibling angle (the other branch's).
    expect(seenSiblings[0]!.length).toBe(1);
    expect(seenSiblings[1]!.length).toBe(1);
    // The two prompts are DISTINCT — branch 0 differs from branch 1's angle and
    // vice-versa, so they are not identical near-duplicates.
    expect(seenSiblings[0]![0]).not.toBe(seenSiblings[1]![0]);

    // And the distinct angles landed in the recorded node observations.
    const observations = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL`.map((n) => n.observation);
    expect(observations.length).toBe(2);
    expect(observations[0]).not.toBe(observations[1]);
    expect(observations.every((o) => o.includes('differs from:'))).toBe(true);
  });

  test('full cycle: budget=3, branches=2', async () => {
    let branchCounter = 0;
    const { rt } = createTestRuntime({
      llmResponses: {
        'Summarize': '- Used approach A\n- Worked well\n- Score high',
      },
    });

    // Even branches carry code that PASSES execution; odd branches are prose.
    // Each expansion pairs one code branch with one prose branch.
    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;
      return {
        explore: async () => ({
          text: `branch ${i} explored`,
          codeUsed: i % 2 === 0 ? 'const x = 1;' : null,
        }),
        generateReflection: async () => `reflection for branch ${i}`,
      };
    };

    initTables(rt);
    const session = createMockSession();
    const result = await runMCTS(rt, session, 'Refactor auth module', {
      budget: 3,
      branches: 2,
    });

    // The passing-code branch (judge 0.5 → 0.6 + 0.4×0.5 = 0.8) wins and clears
    // the default minAcceptableScore.
    expect(result.converged).toBe(true);
    expect(result.winnerValue).toBeGreaterThan(0.6);

    // Tree should have root + 3 iterations × 2 branches = 7 nodes
    const allNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    expect(allNodes.length).toBe(7); // 1 root + 6 children

    // Execution grounding dominates AND the A5 band loophole is closed: the
    // prose branch shares an expansion with a code branch, so it is capped at
    // the FAIL ceiling (0.30×0.5 = 0.15) — it cannot beat a passing code branch
    // by declining to attempt code.
    const children = allNodes.filter((n) => n.parent_id !== null);
    const codeBranches = children.filter((n) => n.code_used);
    const proseBranches = children.filter((n) => !n.code_used);
    expect(codeBranches.length).toBeGreaterThan(0);
    expect(proseBranches.length).toBeGreaterThan(0);
    const minPassing = Math.min(...codeBranches.map((n) => n.value));
    const maxProse = Math.max(...proseBranches.map((n) => n.value));
    expect(maxProse).toBeLessThanOrEqual(0.3);   // capped at the fail ceiling
    expect(minPassing).toBeGreaterThan(maxProse); // passing code dominates

    // Root should have been visited (backprop propagates to ancestors)
    const root = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE parent_id IS NULL`[0]!;
    expect(root.visits).toBeGreaterThan(0);

    // Convergence closes the tree: winner terminal, everything else pruned —
    // nothing stays open to contaminate the next task's UCT selection.
    const openNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE status = 'open'`;
    expect(openNodes.length).toBe(0);
    const terminal = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE status = 'terminal'`;
    expect(terminal.length).toBe(1);
    expect(terminal[0]!.id).toBe(result.winnerId);
  });

  test('a branch whose code FAILS execution scores below a branch whose code PASSES, despite a judge that loves both', async () => {
    let branchCounter = 0;
    const { rt } = createTestRuntime({
      // Every judge sample scores 0.95 for every candidate — only execution
      // can separate the branches.
      llmResponses: { 'scoring ONE candidate': '{"score": 0.95}' },
    });
    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;
      return {
        explore: async () => ({
          text: `approach ${i}`,
          codeUsed: i === 0 ? 'const broken = FAIL_MARKER;' : 'const ok = 1;',
        }),
        generateReflection: async () => 'n/a',
      };
    };

    initTables(rt);
    const result = await runMCTS(rt, createMockSession(), 'implement the widget', {
      budget: 1,
      branches: 2,
    });

    const children = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL ORDER BY action`;
    const failing = children.find((n) => n.code_used?.includes('FAIL_MARKER'))!;
    const passing = children.find((n) => !n.code_used?.includes('FAIL_MARKER'))!;
    expect(failing.value).toBeLessThanOrEqual(0.3);   // fail band ceiling
    expect(passing.value).toBeGreaterThanOrEqual(0.6); // pass band floor
    expect(result.winnerId).toBe(passing.id);
  });

  test('every branch reaches the grounded evaluator (one call per branch)', async () => {
    let candidateCalls = 0;
    const llm: LLM = {
      async *stream() { yield ''; },
      async complete(prompt: string) {
        if (prompt.includes('scoring ONE candidate')) candidateCalls++;
        return '{"score": 0.5}';
      },
    };
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'prose approach', codeUsed: null }),
      generateReflection: async () => 'n/a',
    });

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'no gate task', { budget: 1, branches: 2, judgeSamples: 1 });

    // Every branch is judged by the grounded evaluator — no pre-prune gate.
    expect(candidateCalls).toBe(2);
  });

  test('judgeSamples / maxEvalLLMCalls config knobs are respected at the engine seam', async () => {
    const llm = countingLLM('{"score": 0.5}');
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'prose approach', codeUsed: null }),
      generateReflection: async () => 'n/a',
    });

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'one-sample task', {
      budget: 1,
      branches: 2,
      judgeSamples: 1,
    });
    // 2 branches × 1 judge sample (prose: no assertion-generation call).
    expect(llm.judgeCalls()).toBe(2);
  });

  test('sequential tasks on one DB do not contaminate each other (fresh root per task)', async () => {
    // Regression: converge used to leave the winner status='open', so the
    // SECOND runMCTS's global-argmax UCT selected the FIRST task's high-value
    // winner instead of the new task's root and expanded under it.
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'explored', codeUsed: null }),
      generateReflection: async () => 'n/a',
    });

    initTables(rt);
    const first = await runMCTS(rt, createMockSession(), 'first task', { budget: 1, branches: 2 });
    expect(first.converged).toBe(true);

    const second = await runMCTS(rt, createMockSession(), 'second task', { budget: 1, branches: 2 });
    expect(second.converged).toBe(true);

    // Every node created for the second task must hang off the second task's
    // own root — never under the first task's winner.
    const secondNodes = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE task = 'second task'`;
    expect(secondNodes.length).toBe(3); // 1 root + 2 branches
    const secondRoot = secondNodes.find((n) => n.parent_id === null)!;
    expect(secondRoot).toBeDefined();
    for (const n of secondNodes) {
      if (n.id === secondRoot.id) continue;
      expect(n.parent_id).toBe(secondRoot.id);
    }
    // And the second winner is one of the second task's nodes.
    expect(secondNodes.some((n) => n.id === second.winnerId)).toBe(true);
  });

  test('reflections stored in memory on low scores', async () => {
    const { rt } = createTestRuntime({
      // Judge prompts contain the candidate trajectory — score it very low so
      // the reflection threshold (0.35) triggers.
      llmResponses: { 'bad approach': '{"score": 0.1}' },
    });
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'bad approach', codeUsed: null }),
      generateReflection: async () => 'approach failed because auth layer is tightly coupled',
    });

    initTables(rt);
    const session = createMockSession();
    await runMCTS(rt, session, 'Improve test coverage', {
      budget: 1,
      branches: 1,
      minAcceptableScore: 0.01, // low threshold so convergence succeeds
    });

    // Reflection should be in MEMORY.md
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('Failure lesson');
    expect(memory).toContain('auth layer is tightly coupled');
  });

  test('cost guard rejects overbudget requests', async () => {
    const { rt } = createTestRuntime();
    initTables(rt);

    const session = createMockSession();
    await expect(
      runMCTS(rt, session, 'huge task', { budget: 1000, branches: 10, maxCostUSD: 0.01 }),
    ).rejects.toThrow('exceeds limit');
  });

  test('BUG-4: all-low-score convergence returns converged=false', async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'hopeless attempt': '{"score": 0.05}' },
    });
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'hopeless attempt', codeUsed: null }),
      generateReflection: async () => 'everything failed',
    });

    initTables(rt);
    const session = createMockSession();
    const result = await runMCTS(rt, session, 'impossible task', {
      budget: 1,
      branches: 1,
      // Use default MIN_ACCEPTABLE_SCORE = 0.3
    });

    expect(result.converged).toBe(false);
  });

  test('judge infrastructure failure is backpropagated as 0, not neutral 0.5', async () => {
    const { rt } = createTestRuntime();
    const downLLM: LLM = {
      async *stream() { yield ''; },
      async complete() { throw new Error('judge provider failed'); },
    };
    rt.llm = downLLM;
    rt.judgeModel = downLLM;
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'provider produced rollout', codeUsed: null }),
      generateReflection: async () => 'judge failure should penalize the branch',
    });

    initTables(rt);
    const session = createMockSession();
    const result = await runMCTS(rt, session, 'Audit a failing task', {
      budget: 1,
      branches: 1,
    });

    expect(result.converged).toBe(false);
    const child = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL LIMIT 1
    `[0]!;
    expect(child.visits).toBe(1);
    expect(child.value).toBe(0);
  });
});

describe('MCTS strategy — stored operator overrides', () => {
  test('options.mcts budget/branches apply when the caller passes no explicit budget', async () => {
    // This is the seam the backends use to inject AgentConfigStore.getMctsOverrides():
    // think({strategy:'mcts'}) without an explicit budget must run with the
    // stored knobs, not hardcoded defaults.
    const { createMCTSStrategy } = await import('../src/strategy/mcts.js');
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'explored', codeUsed: null }),
      generateReflection: async () => 'n/a',
    });
    initTables(rt);

    const strategy = createMCTSStrategy();
    const result = await strategy.explore({
      task: 'tuned task',
      rt,
      model: undefined as never,
      budget: { maxIterations: undefined },
      options: { mcts: { session: createMockSession(), budget: 2, branches: 1 } },
    });

    expect(result.cost.iterations).toBe(2);
    // 1 root + 2 iterations × 1 branch = 3 nodes.
    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE task = 'tuned task'`;
    expect(nodes.length).toBe(3);
  });

  test('options.mcts.judgeSamples flows through to the evaluator', async () => {
    const { createMCTSStrategy } = await import('../src/strategy/mcts.js');
    const llm = countingLLM('{"score": 0.5}');
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'explored', codeUsed: null }),
      generateReflection: async () => 'n/a',
    });
    initTables(rt);

    const strategy = createMCTSStrategy();
    await strategy.explore({
      task: 'judge-knob task',
      rt,
      model: undefined as never,
      budget: { maxIterations: undefined },
      options: { mcts: { session: createMockSession(), budget: 1, branches: 2, judgeSamples: 1 } },
    });
    expect(llm.judgeCalls()).toBe(2); // 2 branches × 1 sample
  });
});

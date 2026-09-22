/** Full MCTS cycle over real SQL tables, UCT and backprop; LLM and executor are mocked. */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, createMockSession, captureConsole, makeSql } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import type { MCTSProgressEvent, SearchNode } from '../src/types/mcts';
import type { Executor, LLM } from '../src/types/primitives';
import type { BranchHandle } from '../src/types/agent-runtime';
import { present } from '@kinu.run/test-utils';

function markerExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code: string) {
      return code.includes('FAIL_MARKER')
        ? { result: undefined, error: 'marker assertion failed' }
        : { result: true };
    },
  };
}

function scriptedBranch(text: string, reflection = 'n/a'): BranchHandle {
  return {
    explore: async () => ({ text }),
    generateReflection: async () => ({ text: reflection }),
    release: async () => {},
  };
}

/** Simulates a facet/RPC boundary that resolves with a malformed payload. */
function malformedBranch(): BranchHandle {
  const branch: BranchHandle = { explore: async () => ({ text: 'placeholder' }), generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
  Object.defineProperty(branch, 'explore', { value: async () => undefined });

  return branch;
}

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
  initCraftedToolsTables(rt.storage.sql);
}

describe('MCTS integration', () => {
  // A branch's resolved value is untrusted: a malformed one scores 0 and is reported, not thrown.
  test('a branch that resolves a malformed exploration is reported, not fatal', async () => {
    const { rt } = createTestRuntime();
    const failures: string[] = [];
    rt.spawnBranch = async () => malformedBranch();

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'pick a strategy', {
      budget: 1,
      branches: 2,
      onProgress: (e) => { if (e.type === 'branch-failed') failures.push(e.error); },
    });

    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((e) => e.includes('no exploration'))).toBe(true);
  });

  test('DO-NOW #1: sibling diversity — each branch in an expansion gets a DISTINCT prompt naming the other branch angles', async () => {
    const { rt } = createTestRuntime();
    const seenSiblings: Array<readonly string[]> = [];
    let i = 0;
    rt.spawnBranch = async () => {
      const idx = i++;

      return { explore: async ({ siblings = [] }) => {
        seenSiblings.push(siblings);

        return { text: `branch ${idx} differs from: ${siblings.join(' | ')}` };
      }, generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'pick a strategy', { budget: 1, branches: 2 });

    expect(seenSiblings.length).toBe(2);
    expect(seenSiblings[0].length).toBe(1);
    expect(seenSiblings[1].length).toBe(1);
    expect(seenSiblings[0][0]).not.toBe(seenSiblings[1][0]);

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

    // Even branches carry passing code, odd branches prose.
    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      return { explore: async () => ({
        text: i % 2 === 0
          ? `branch ${i} explored\n\`\`\`js\nconst x = 1;\n\`\`\``
          : `branch ${i} explored`,
      }), generateReflection: async () => ({ text: `reflection for branch ${i}` }), release: async () => {} };
    };

    initTables(rt);
    const session = createMockSession();

    const result = await runMCTS(rt, session, 'Refactor auth module', {
      budget: 3,
      branches: 2,
    });

    // Passing code: 0.6 + 0.4×0.5 = 0.8, above the default minAcceptableScore.
    expect(result.converged).toBe(true);
    expect(result.winnerValue).toBeGreaterThan(0.6);

    const allNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    expect(allNodes.length).toBe(7);

    // Prose sharing an expansion with code is capped at the fail ceiling.
    const children = allNodes.filter((n) => n.parent_id !== null);
    const codeBranches = children.filter((n) => n.code_used);
    const proseBranches = children.filter((n) => !n.code_used);
    expect(codeBranches.length).toBeGreaterThan(0);
    expect(proseBranches.length).toBeGreaterThan(0);
    expect(codeBranches.every((node) => node.code_language === 'javascript')).toBe(true);
    expect(proseBranches.every((node) => node.code_language === null)).toBe(true);
    const minPassing = Math.min(...codeBranches.map((n) => n.value));
    const maxProse = Math.max(...proseBranches.map((n) => n.value));
    expect(maxProse).toBeLessThanOrEqual(0.3);
    expect(minPassing).toBeGreaterThan(maxProse);

    const root = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE parent_id IS NULL`[0];
    expect(root.visits).toBeGreaterThan(0);

    // Convergence closes the tree so nothing open leaks into the next task's selection.
    const openNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE status = 'open'`;
    expect(openNodes.length).toBe(0);
    const terminal = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE status = 'terminal'`;
    expect(terminal.length).toBe(1);
    expect(terminal[0].id).toBe(result.winnerId);
  });

  test('a branch whose code FAILS execution scores below a branch whose code PASSES, despite a judge that loves both', async () => {
    let branchCounter = 0;

    const { rt } = createTestRuntime({
      // Judges score everything alike; only execution separates the branches.
      llmResponses: { 'scoring ONE candidate': '{"score": 0.95}' },
    });

    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      return { explore: async () => ({
        text: i === 0
          ? 'approach 0\n```js\nconst broken = FAIL_MARKER;\n```'
          : `approach ${i}\n\`\`\`js\nconst ok = 1;\n\`\`\``,
      }), generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    initTables(rt);

    const result = await runMCTS(rt, createMockSession(), 'implement the widget', {
      budget: 1,
      branches: 2,
    });

    const children = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL ORDER BY action`;

    const failing = present(children.find((n) => n.code_used?.includes('FAIL_MARKER')), 'the failing child');
    const passing = present(children.find((n) => !n.code_used?.includes('FAIL_MARKER')), 'the passing child');
    expect(failing.value).toBeLessThanOrEqual(0.3);
    expect(passing.value).toBeGreaterThanOrEqual(0.6);
    expect(result.winnerId).toBe(passing.id);
  });

  // LATS §5.2: the environment's verdict is added to the context as an observation.
  test("a failed branch's execution verdict reaches the trajectory its children inherit", async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'scoring ONE candidate': '{"score": 0.5}' },
    });

    rt.executor = markerExecutor();
    rt.spawnBranch = async () => scriptedBranch('approach\n```js\nconst broken = FAIL_MARKER;\n```');

    initTables(rt);
    const session = createMockSession();
    await runMCTS(rt, session, 'implement the widget', { budget: 1, branches: 1 });

    const child = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL`[0];

    if (child.msg_id === null) throw new Error('the expanded branch recorded no message to inherit from');

    // The read the next expansion makes (engine.ts: priorHistory).
    const inherited = (await session.getHistory(child.msg_id)).map((m) => m.content).join('\n');
    expect(inherited).toContain('FAILED');
    expect(inherited).toContain('marker assertion failed');
    expect(inherited).toContain('const broken = FAIL_MARKER;');
    // search_nodes keeps the proposal text, which mcts/takes.ts compares.
    expect(child.observation).not.toContain('marker assertion failed');
  });

  test('the post-mortem is asked about the verdict, and a branch that never executed carries none', async () => {
    const outcomes: Array<string | undefined> = [];

    const { rt } = createTestRuntime({
      llmResponses: { 'scoring ONE candidate': '{"score": 0.1}' },
    });

    rt.executor = markerExecutor();
    let branchCounter = 0;
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      return { explore: async () => ({
        text: i === 0
          ? 'approach 0\n```js\nconst broken = FAIL_MARKER;\n```'
          : 'approach 1, prose only — no implementation offered',
      }), generateReflection: async (_task: string, outcome?: string) => {
        outcomes.push(outcome);

        return { text: 'n/a' };
      }, release: async () => {} };
    };

    initTables(rt);
    const session = createMockSession();
    await runMCTS(rt, session, 'implement the widget', { budget: 1, branches: 2 });

    // Judge 0.1 is under reflectionThreshold, so both branches reflect.
    expect(outcomes.length).toBe(2);
    expect(outcomes.filter((o) => o?.includes('marker assertion failed')).length).toBe(1);
    expect(outcomes.filter((o) => o === undefined).length).toBe(1);

    const prose = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL AND code_used IS NULL`[0];

    if (prose.msg_id === null) throw new Error('the prose branch recorded no message to read back');

    expect((await session.getHistory(prose.msg_id)).map((m) => m.content).join('\n'))
      .not.toContain('Observation:');
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
    rt.spawnBranch = async () => scriptedBranch('prose approach');

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'no gate task', { budget: 1, branches: 2, judgeSamples: 1 });

    expect(candidateCalls).toBe(2);
  });

  test('judgeSamples / maxEvalLLMCalls config knobs are respected at the engine seam', async () => {
    const llm = countingLLM('{"score": 0.5}');
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    rt.spawnBranch = async () => scriptedBranch('prose approach');

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'one-sample task', {
      budget: 1,
      branches: 2,
      judgeSamples: 1,
    });
    expect(llm.judgeCalls()).toBe(2);
  });

  // The realised ensemble size is reported, keyed on the stable dotted name.
  const isClampLine = (line: string): boolean =>
    line.includes('"event":"mcts.judge_ensemble_clamped"');

  test('a judge request the call budget cannot fund is realised at the ceiling AND disclosed', async () => {
    const llm = countingLLM('{"score": 0.5}');
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    // One of a code branch's evaluation calls buys the check suite.
    rt.spawnBranch = async () => scriptedBranch('approach\n```js\nconst x = 42;\n```');

    initTables(rt);

    const { stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), 'twenty judges please', {
        budget: 1, branches: 1, judgeSamples: 20,
      }),
    );

    expect(llm.judgeCalls()).toBe(3);

    const lines = stderr.filter(isClampLine);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).fields).toMatchObject({
      mode: 'build',
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 3,
      maxEvalLLMCalls: 4,
    });
  });

  test('a judge request the budget funds is not reported as clamped', async () => {
    const llm = countingLLM('{"score": 0.5}');
    const { rt } = createTestRuntime();
    rt.llm = llm;
    rt.judgeModel = llm;
    rt.spawnBranch = async () => scriptedBranch('approach\n```js\nconst x = 42;\n```');

    initTables(rt);

    const { stdout, stderr } = await captureConsole(() =>
      runMCTS(rt, createMockSession(), 'two judges is fine', {
        budget: 1, branches: 1, judgeSamples: 2,
      }),
    );

    expect(llm.judgeCalls()).toBe(2);
    expect([...stdout, ...stderr].filter(isClampLine)).toHaveLength(0);
  });

  test('sequential tasks on one DB do not contaminate each other (fresh root per task)', async () => {
    // Selection is scoped to the current `root_id`; a global argmax would expand a previous task's node.
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => scriptedBranch('explored');

    initTables(rt);
    const first = await runMCTS(rt, createMockSession(), 'first task', { budget: 1, branches: 2 });
    expect(first.converged).toBe(true);

    const second = await runMCTS(rt, createMockSession(), 'second task', { budget: 1, branches: 2 });
    expect(second.converged).toBe(true);

    const secondNodes = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE task = 'second task'`;

    expect(secondNodes.length).toBe(3);
    const secondRoot = present(secondNodes.find((n) => n.parent_id === null), 'the second root');

    for (const n of secondNodes) {
      if (n.id === secondRoot.id) continue;
      expect(n.parent_id).toBe(secondRoot.id);
    }

    expect(secondNodes.some((n) => n.id === second.winnerId)).toBe(true);
  });

  test('reflections stored in memory on low scores', async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'bad approach': '{"score": 0.1}' },
    });

    rt.spawnBranch = async () => scriptedBranch('bad approach', 'approach failed because auth layer is tightly coupled');

    initTables(rt);
    const session = createMockSession();
    await runMCTS(rt, session, 'Improve test coverage', {
      budget: 1,
      branches: 1,
      minAcceptableScore: 0.01,
    });

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

  test('cost guard names the model and the basis of its estimate', async () => {
    const { rt } = createTestRuntime();
    initTables(rt);

    await expect(
      runMCTS(rt, createMockSession(), 'huge task', {
        budget: 1000, branches: 10, maxCostUSD: 0.01,
        costModel: () => ({
          spec: 'anthropic/claude-fable-5',
          pricing: { input: 10, output: 50 },
        }),
      }),
    ).rejects.toThrow(/anthropic\/claude-fable-5.*\$10\/1M in/);

    await expect(
      runMCTS(rt, createMockSession(), 'huge task', {
        budget: 1000, branches: 10, maxCostUSD: 0.01,
        costModel: () => ({ spec: 'ollama-cloud/kimi-k3', pricing: null }),
      }),
    ).rejects.toThrow(/ollama-cloud\/kimi-k3 is unpriced in the catalog/);
  });

  test('cost guard does NOT refuse a search the catalog prices at nothing', async () => {
    const { rt } = createTestRuntime();
    initTables(rt);
    rt.spawnBranch = async () => scriptedBranch('a candidate', 'no lesson');

    // The catalog prices the model at zero, so a $0 ceiling must pass.
    const result = await runMCTS(rt, createMockSession(), 'free work', {
      budget: 2, branches: 2, maxCostUSD: 0,
      judgeSamples: 1, maxEvalLLMCalls: 1,
      costModel: () => ({ spec: 'free/model', pricing: { input: 0, output: 0 } }),
    });

    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    expect(nodes.length).toBe(5);
    expect(nodes.some((node) => node.id === result.winnerId)).toBe(true);
  });

  test('BUG-4: all-low-score convergence returns converged=false', async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'hopeless attempt': '{"score": 0.05}' },
    });

    rt.spawnBranch = async () => scriptedBranch('hopeless attempt', 'everything failed');

    initTables(rt);
    const session = createMockSession();

    const result = await runMCTS(rt, session, 'impossible task', {
      budget: 1,
      branches: 1,
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
    rt.spawnBranch = async () => scriptedBranch('provider produced rollout', 'judge failure should penalize the branch');

    initTables(rt);
    const session = createMockSession();

    const result = await runMCTS(rt, session, 'Audit a failing task', {
      budget: 1,
      branches: 1,
    });

    expect(result.converged).toBe(false);

    const child = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE parent_id IS NOT NULL LIMIT 1
    `[0];

    expect(child.visits).toBe(1);
    expect(child.value).toBe(0);
  });
});

describe('MCTS branch lifetime', () => {
  /** Only release reclaims a branch's storage; an abort is not proof of teardown. */
  function trackedBranches(rt: ReturnType<typeof createTestRuntime>['rt']) {
    const spawned: string[] = [];
    const aborted: string[] = [];
    const released: string[] = [];
    rt.spawnBranch = async (id) => {
      spawned.push(id);

      return { explore: async () => ({ text: 'a solid approach' }), generateReflection: async () => ({ text: 'lesson' }), release: async () => { released.push(id); } };
    };

    rt.abortBranch = async (id) => { aborted.push(id); };

    return { spawned, aborted, released };
  }

  test('every branch an expansion spawns is released when the iteration ends', async () => {
    const { rt } = createTestRuntime();
    const { spawned, released } = trackedBranches(rt);

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'plan the work', { budget: 2, branches: 2 });

    expect(spawned.length).toBe(4);
    expect(new Set(released)).toEqual(new Set(spawned));
  });

  test('a branch is released even when the iteration throws', async () => {
    const { rt } = createTestRuntime();
    const { spawned, released } = trackedBranches(rt);
    rt.memory.append = async () => { throw new Error('memory offline'); };

    initTables(rt);
    await expect(runMCTS(rt, createMockSession(), 'plan the work', {
      budget: 1, branches: 2,
    })).rejects.toThrow('memory offline');

    expect(spawned.length).toBe(2);
    expect(new Set(released)).toEqual(new Set(spawned));
  });
});

describe('MCTS progress reporting', () => {
  test('phases are announced per iteration, in order', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => scriptedBranch('a solid approach');

    initTables(rt);
    const events: MCTSProgressEvent[] = [];
    await runMCTS(rt, createMockSession(), 'plan the work', {
      budget: 2, branches: 2,
      onProgress: (event) => events.push(event),
    });

    expect(events.filter(e => e.type === 'phase' && e.phase === 'explore').length).toBe(2);
    expect(events.filter(e => e.type === 'phase' && e.phase === 'evaluate').length).toBe(2);
    const iterations = events.flatMap(e => e.type === 'iteration-complete' ? [e] : []);
    expect(iterations.map(e => e.iteration)).toEqual([1, 2]);
    expect(iterations[0].remainingBudget).toBe(1);
    expect(iterations[0].scores.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'phase', phase: 'explore', iteration: 1, branches: 2 });
  });

  test('reports an unsupported proposal language once per search', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => scriptedBranch('```python\nprint(42)\n```');
    initTables(rt);
    const events: MCTSProgressEvent[] = [];
    await runMCTS(rt, createMockSession(), 'write a script', {
      budget: 2,
      branches: 2,
      onProgress: (event) => events.push(event),
    });
    const grounding = events.filter(({ type }) => type === 'grounding-unavailable');
    expect(grounding).toHaveLength(1);
    expect(grounding[0]).toMatchObject({
      type: 'grounding-unavailable',
      language: 'python',
      canRun: ['javascript'],
      iteration: 1,
      remainingBudget: 2,
    });
    // Lets a consumer route each event to the right tree when two searches are live.
    const rootId = grounding[0]?.rootId;

    if (rootId === undefined || rootId.length === 0) throw new Error('grounding event names no search');
    expect(events.every((event) => event.rootId === rootId)).toBe(true);
  });

  test('a failed exploration is reported with its provider error, and the search continues', async () => {
    const { rt } = createTestRuntime();
    let branch = 0;
    rt.spawnBranch = async () => {
      const failing = branch++ === 0;

      return { explore: async () => {
        if (failing) throw new Error('Failed after 3 attempts. Last error: 429 rate limited');

        return { text: 'a solid approach' };
      }, generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    initTables(rt);
    const events: MCTSProgressEvent[] = [];
    await runMCTS(rt, createMockSession(), 'plan the work', {
      budget: 1, branches: 2,
      onProgress: (event) => events.push(event),
    });

    const failures = events.flatMap(e => e.type === 'branch-failed' && e.stage === 'explore' ? [e] : []);
    expect(failures.length).toBe(1);
    expect(failures[0].iteration).toBe(1);
    expect(failures[0].error).toBe('Failed after 3 attempts. Last error: 429 rate limited');
    expect(failures[0].branchId.length).toBeGreaterThan(0);
  });

  test('a failed reflection is reported and does not abort a search that already scored its branches', async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'weak attempt': '{"score": 0.05}' },
    });

    rt.spawnBranch = async () => ({ explore: async () => ({ text: 'weak attempt' }), generateReflection: async () => { throw new Error('reflection provider down'); }, release: async () => {} });

    initTables(rt);
    const events: MCTSProgressEvent[] = [];

    const result = await runMCTS(rt, createMockSession(), 'improve myself', {
      budget: 1, branches: 1,
      onProgress: (event) => events.push(event),
    });

    expect(result.converged).toBe(false);
    expect(rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE parent_id IS NOT NULL`.length).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'branch-failed', stage: 'reflect', iteration: 1, error: 'reflection provider down',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'phase', phase: 'reflect', branches: 1,
    }));
  });
});

describe('MCTS — the operator\'s stored knobs reach the tree', () => {
  // Stored knobs apply when no explicit budget is given (`evolution/engine.ts` passes them).
  test('budget and branches decide how much tree gets written', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => scriptedBranch('explored');
    initTables(rt);

    await runMCTS(rt, createMockSession(), 'tuned task', {
      mode: 'build', budget: 2, branches: 1,
    });

    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE task = 'tuned task'`;
    expect(nodes.length).toBe(3);
  });
});

const StoredBranchEvaluationSchema = v.object({
  grounding: v.picklist(['execution', 'judge', 'unrunnable']),
  score: v.number(),
  judgeSamplesAttempted: v.number(),
  judgeSamplesUsed: v.number(),
  execution: v.optional(v.object({
    passed: v.boolean(),
    passedChecks: v.optional(v.number()),
    totalChecks: v.optional(v.number()),
    assertionsGenerated: v.boolean(),
  })),
  unrunnableLanguage: v.optional(v.string()),
});

type StoredBranchEvaluation = v.InferOutput<typeof StoredBranchEvaluationSchema>;

function parseStoredBranchEvaluation(raw: string | null): StoredBranchEvaluation {
  if (raw === null) throw new Error('expected stored branch evaluation');
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error('stored branch evaluation is not JSON', { cause: error });
  }

  return v.parse(StoredBranchEvaluationSchema, json);
}

describe('MCTS branch evaluation diagnostics', () => {
  test('every evaluated branch persists grounding, judge attempted/used, and score components', async () => {
    let branchCounter = 0;

    const { rt } = createTestRuntime({
      llmResponses: {
        'verification harness': '```js\ntrue;\n```\n```js\nFAIL_MARKER;\n```',
        'scoring ONE candidate': '{"score": 0.5}',
      },
    });

    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      return { explore: async () => ({
        text: i % 2 === 0
          ? `branch ${i} explored\n\`\`\`js\nconst ok = 1;\n\`\`\``
          : `prose branch ${i} explored`,
      }), generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    initTables(rt);
    await runMCTS(rt, createMockSession(), 'diagnostics task', { budget: 1, branches: 2 });

    const rows = rt.storage.sql<{
      parent_id: string | null;
      evaluation_json: string | null;
    }>`SELECT parent_id, evaluation_json FROM search_nodes`;

    expect(rows.filter((r) => r.parent_id === null).map((r) => r.evaluation_json)).toEqual([null]);

    const children = rows.filter((r) => r.parent_id !== null)
      .map((row) => parseStoredBranchEvaluation(row.evaluation_json));

    expect(children).toHaveLength(2);

    const executed = present(children.find((d) => d.grounding === 'execution'), 'the executed child');
    // The exact key set is the bound: no proposal or error text.
    expect(Object.keys(executed).sort())
      .toEqual(['execution', 'grounding', 'judgeSamplesAttempted', 'judgeSamplesUsed', 'score']);
    expect(Object.keys(present(executed.execution, 'the execution detail')).sort())
      .toEqual(['assertionsGenerated', 'passed', 'passedChecks', 'totalChecks']);
    expect(executed.execution).toMatchObject({
      passed: false,
      passedChecks: 1,
      totalChecks: 2,
      assertionsGenerated: true,
    });
    expect(executed.judgeSamplesAttempted).toBe(3);
    expect(executed.judgeSamplesUsed).toBe(3);
    // FAIL_FLOOR + FAIL_SPAN × (1 / 2) = 0.175.
    expect(executed.score).toBeCloseTo(0.175, 10);

    const judged = present(children.find((d) => d.grounding === 'judge'), 'the judged child');
    expect(Object.keys(judged).sort())
      .toEqual(['grounding', 'judgeSamplesAttempted', 'judgeSamplesUsed', 'score']);
    expect(judged.judgeSamplesAttempted).toBe(3);
    expect(judged.judgeSamplesUsed).toBe(3);
    expect(judged.score).toBeCloseTo(0.15, 10);
  });
});

describe('MCTS below-floor outcome classification', () => {
  function runtimeWithLedger() {
    const bundle = createTestRuntime({
      llmResponses: { alpha: '{"score": 0.1}', beta: '{"score": 0.2}' },
    });

    initTables(bundle.rt);
    initMctsSearchTable(bundle.rt.storage.execRaw);

    return { ...bundle, store: new MctsSearchStore(makeSql(bundle.db), bundle.rt.actor) };
  }

  test('a search whose every branch sits below the floor classifies its settle', async () => {
    let branchCounter = 0;
    const { rt, store } = runtimeWithLedger();
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      // Unequal scores exercise the floor rather than the exact-tie guard.
      if (i === 0) return malformedBranch();

      return { explore: async () => ({ text: 'approach beta' }), generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    const result = await runMCTS(rt, createMockSession(), 'unreachable floor task', {
      budget: 1, branches: 2, search: store,
    });

    expect(result.converged).toBe(false);
    expect(result.reason).toBe('no_acceptable_candidate');

    // "Never asked" (0/0) and three usable samples are different failures.
    const diagnostics = rt.storage.sql<{ evaluation_json: string }>`
      SELECT evaluation_json FROM search_nodes
      WHERE parent_id IS NOT NULL AND evaluation_json IS NOT NULL`
      .map((row) => parseStoredBranchEvaluation(row.evaluation_json));

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      grounding: 'judge',
      score: 0,
      judgeSamplesAttempted: 0,
      judgeSamplesUsed: 0,
    }));

    const sampled = present(
      diagnostics.find((diagnostic) => diagnostic.judgeSamplesAttempted === 3),
      'the three-sample diagnostic',
    );

    expect(sampled).toMatchObject({
      grounding: 'judge',
      judgeSamplesAttempted: 3,
      judgeSamplesUsed: 3,
    });
    expect(sampled.score).toBeCloseTo(0.15, 10);

    expect(rt.storage.sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE status = 'terminal'`).toHaveLength(0);
    expect(rt.storage.sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE status = 'open'`).toHaveLength(0);

    expect(store.list(10)).toHaveLength(1);
    expect(store.list(10)[0]).toMatchObject({
      engine: 'mcts',
      status: 'no_acceptable_candidate',
    });
    expect(store.findResumable('unreachable floor task')).toBeNull();
  });

  test('an above-floor winner still settles the ledger as converged', async () => {
    let branchCounter = 0;
    const { rt, store } = runtimeWithLedger();
    rt.executor = markerExecutor();
    rt.spawnBranch = async () => {
      const i = branchCounter++;

      return { explore: async () => ({
        text: i === 0
          ? 'approach alpha\n```js\nconst ok = 1;\n```'
          : 'approach beta',
      }), generateReflection: async () => ({ text: 'n/a' }), release: async () => {} };
    };

    const result = await runMCTS(rt, createMockSession(), 'reachable task', {
      budget: 1, branches: 2, search: store,
    });

    expect(result.converged).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(rt.storage.sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE status = 'terminal'`)
      .toEqual([{ id: result.winnerId }]);
    expect(store.list(10)[0]).toMatchObject({ engine: 'mcts', status: 'converged' });
  });
});

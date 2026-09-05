import { describe, expect, test } from 'bun:test';
import { createMockSession, createTestRuntime } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initMctsSearchTable, MctsSearchStore } from '../src/mcts/search-store';
import type { WorkMode } from '../src/prompting/surface';

function initTables(runtime: ReturnType<typeof createTestRuntime>['rt']): void {
  initSearchTables(runtime.storage.execRaw);
  initScaffoldTables(runtime.storage.execRaw);
  initMctsSearchTable(runtime.storage.execRaw);
}

describe('MCTS in Plan mode', () => {
  test('keeps exploration read-only even when a branch proposes runnable code', async () => {
    const { rt } = createTestRuntime({ llmResponses: { 'Score this candidate': '{"score":0.9,"rationale":"strong"}' } });
    initTables(rt);

    let executorCalls = 0;
    let memoryWrites = 0;
    let craftWrites = 0;
    const branchModes: WorkMode[] = [];
    const execute = rt.executor.execute.bind(rt.executor);
    rt.executor.execute = async (...args) => {
      executorCalls++;
      return execute(...args);
    };
    rt.memory.append = async () => { memoryWrites++; };
    rt.memory.index = async () => { memoryWrites++; };
    rt.craftStore.create = () => { craftWrites++; };
    rt.craftStore.update = () => { craftWrites++; };
    rt.spawnBranch = async () => ({
      explore: async (_history, _tools, _languages, mode) => {
        branchModes.push(mode);
        return { text: '```javascript\nexport const answer = 42;\n```' };
      },
      generateReflection: async () => ({ text: 'would mutate memory in Build mode' }),
    });

    const result = await runMCTS(rt, createMockSession(), 'plan a safe implementation', {
      mode: 'plan', budget: 1, branches: 1,
    });

    expect(result.converged).toBe(true);
    expect(branchModes).toEqual(['plan']);
    expect(executorCalls).toBe(0);
    expect(memoryWrites).toBe(0);
    expect(craftWrites).toBe(0);
    expect(rt.storage.sql<{ count: number }>`SELECT COUNT(*) AS count FROM task_history`[0]?.count).toBe(0);
    expect(rt.storage.sql<{ code: string | null }>`
      SELECT code_used AS code FROM search_nodes WHERE parent_id IS NOT NULL
    `[0]?.code).toBeNull();
  });

  test('Build mode retains grounded execution', async () => {
    const { rt } = createTestRuntime({ llmResponses: { 'Score this candidate': '{"score":0.9,"rationale":"strong"}' } });
    initTables(rt);
    let executorCalls = 0;
    const execute = rt.executor.execute.bind(rt.executor);
    rt.executor.execute = async (...args) => {
      executorCalls++;
      return execute(...args);
    };
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: '```javascript\nexport const answer = 42;\n```' }),
      generateReflection: async () => ({ text: '' }),
    });

    await runMCTS(rt, createMockSession(), 'implement the answer', {
      mode: 'build', budget: 1, branches: 1,
    });
    expect(executorCalls).toBeGreaterThan(0);
  });

  test('never resumes a same-task search from the other work mode', async () => {
    const { rt } = createTestRuntime();
    initTables(rt);
    const search = new MctsSearchStore(rt.storage.sql);
    const abort = new AbortController();
    await expect(runMCTS(rt, createMockSession(), 'same task', {
      mode: 'build', budget: 2, branches: 1, search, signal: abort.signal,
      onProgress(event) {
        if (event.type === 'iteration-complete') abort.abort(new Error('evicted'));
      },
    })).rejects.toThrow('evicted');

    const buildRoot = search.findResumable('same task', 'build')?.rootId;
    expect(buildRoot).toBeDefined();
    expect(search.findResumable('same task', 'plan')).toBeNull();

    await runMCTS(rt, createMockSession(), 'same task', {
      mode: 'plan', budget: 1, branches: 1, search,
    });
    expect(search.findResumable('same task', 'build')?.rootId).toBe(buildRoot);
  });
});

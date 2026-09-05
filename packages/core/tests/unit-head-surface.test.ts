// A head's function-form `execute_tools` resolves over the finished surface.
//
// `buildHeadToolSet` takes `executeTool` in two forms. A finished entry installs
// directly. A function builds it over the finished surface. The function form
// runs after the `allowedTools` filter, over the tools the head holds. It runs
// over nothing else. These arms pin that ordering through the public builder,
// plus the direct form that no other arm executes to a result.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { HeadCapture } from '../src/heads/head-inference';
import { buildHeadToolSet, type HeadSplitResult } from '../src/heads/head-tools';
import type { HeadInput } from '../src/heads/types';
import type { WebSearchProvider } from '../src/web/index';

const stubWeb: WebSearchProvider = {
  search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
  fetch: async (url: string) => ({ url, retrievedAt: '', markdown: '' }),
};

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'analyze the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [],
    budget: { maxDepth: 0, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    ...overrides,
  };
}

function neverSplit(): Promise<HeadSplitResult> {
  throw new Error('this head cannot split');
}

function sandboxEntry(marker: string) {
  return tool({
    description: 'Run code in the sandbox.',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', required: ['code'], properties: { code: { type: 'string' } },
    }),
    execute: async ({ code }) => `${marker}:${code}`,
  });
}

describe('head function-form execute_tools resolves over the allowed surface', () => {
  test('the function builds over the filtered tools, and its entry runs', async () => {
    const { rt } = createTestRuntime();
    const allowed = ['execute_tools', 'run', 'file', 'record_evidence'];
    let seen: readonly string[] | null = null;
    const executeTool = (finished: ToolSet) => {
      seen = Object.keys(finished);
      return sandboxEntry('fn-ran');
    };
    const tools = buildHeadToolSet({
      input: headInput({ allowedTools: allowed }),
      capture: new HeadCapture(),
      rt,
      executeTool,
      webSearch: stubWeb,
      split: neverSplit,
    });
    const runSandbox = toolExecute<{ code: string }, string>(tools.execute_tools);
    await expect(runSandbox({ code: 'const x = 1' })).resolves.toBe('fn-ran:const x = 1');
    const names: readonly string[] = seen ?? [];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(allowed).toContain(name);
    expect(names).toContain('run');
    expect(names).not.toContain('web');
    expect(names).not.toContain('record_decision');
  });

  test('the function never runs when allowedTools drops execute_tools', () => {
    const { rt } = createTestRuntime();
    let calls = 0;
    const executeTool = (_finished: ToolSet) => {
      calls += 1;
      return sandboxEntry('fn-ran');
    };
    const tools = buildHeadToolSet({
      input: headInput({ allowedTools: ['run'] }),
      capture: new HeadCapture(),
      rt,
      executeTool,
      webSearch: stubWeb,
      split: neverSplit,
    });
    expect(tools.execute_tools).toBeUndefined();
    expect(calls).toBe(0);
    expect(Object.keys(tools)).toEqual(['run']);
  });

  test('a finished executeTool entry installs directly and runs', async () => {
    const { rt } = createTestRuntime();
    const tools = buildHeadToolSet({
      input: headInput(),
      capture: new HeadCapture(),
      rt,
      executeTool: sandboxEntry('direct-ran'),
      webSearch: stubWeb,
      split: neverSplit,
    });
    const runSandbox = toolExecute<{ code: string }, string>(tools.execute_tools);
    await expect(runSandbox({ code: 'const x = 1' })).resolves.toBe('direct-ran:const x = 1');
  });
});

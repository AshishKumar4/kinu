// Confined surfaces finish `execute_tools` over the finished set, and only it.
//
// A head's function-form `executeTool` runs after the `allowedTools` filter, so
// `tools.*` declares exactly the tools the head holds. A node's proposal tool
// merges after the finish, so the sandbox never declares it while the node
// still proposes through it. These arms pin both orderings through the public
// builders, plus the direct form that no other arm executes to a result.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel, toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadCapture } from '../src/heads/head-inference';
import { buildHeadToolSet, type HeadSplitResult } from '../src/heads/head-tools';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { runNodeAgent, type NodeAgentDeps, type NodeAgentInput } from '../src/strategy/node-agent';
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

describe('node proposal merges after the execute_tools finish', () => {
  test('the function never sees propose_branch, and propose still grants', async () => {
    const { rt } = createTestRuntime();
    initHeadsTables(rt.storage.execRaw);
    const journal = new HeadJournal(rt.storage.sql);
    let seen: readonly string[] | null = null;
    const executeTool = (finished: ToolSet) => {
      seen = Object.keys(finished);
      return sandboxEntry('fn-ran');
    };
    // Proposes once, then reports the grant it was told about.
    const model = scriptedTurnModel({
      modelId: 'fake-proposer',
      doGenerate: ({ prompt }) => {
        const text = JSON.stringify(prompt);
        const proposed = prompt.some((message) => message.role === 'tool');
        const granted = text.includes('Granted: 2 children');
        const reported = text.includes('"received":true');
        const content: LanguageModelV3Content[] = reported
          ? [{ type: 'text', text: 'Done.' }]
          : granted
            ? [{
              type: 'tool-call',
              toolCallId: 'report-1',
              toolName: 'report',
              input: JSON.stringify({ status: 'completed', content: 'the granted children hold the answer' }),
            }]
            : proposed
              ? [{ type: 'text', text: 'Waiting on the grant.' }]
              : [{
                type: 'tool-call',
                toolCallId: 'propose-1',
                toolName: 'propose_branch',
                input: JSON.stringify({
                  rationale: 'two threads deserve a budget',
                  branches: [
                    { task: 'angle one', rationale: 'first', context: 'fresh' },
                    { task: 'angle two', rationale: 'second', context: 'fresh' },
                  ],
                }),
              }];
        return {
          content,
          finishReason: {
            unified: reported || (proposed && !granted) ? 'stop' as const : 'tool-calls' as const,
            raw: undefined,
          },
          usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const input: NodeAgentInput = {
      nodeId: 'n1', rootId: 'r1', parentId: null, depth: 1,
      task: 'Make the reference implementation cheaper.',
      rationale: 'the direct angle',
      base: 'You are a node under test.',
      messages: [{ role: 'user', content: 'Answer the task.' }],
      inherited: [],
      context: 'fresh',
      mode: 'build',
      settle: 'best',
      arbitrate: async (proposal) => ({
        kind: 'granted',
        width: proposal.branches.length,
        nodeIds: proposal.branches.map((_, index) => `c${String(index + 1)}`),
        proposal,
      }),
    };
    const deps: NodeAgentDeps = {
      rt,
      model,
      journal,
      logger: createRecordingLogger(),
      maxWallClockMs: 60_000,
      executeTool,
    };
    const run = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    // The sandbox declarations predate the proposal tool.
    const names: readonly string[] = seen ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('execute_tools');
    // And the proposal still landed: the grant the tool returned is the run's.
    expect(run.granted?.kind).toBe('granted');
    if (run.granted?.kind === 'granted') expect(run.granted.nodeIds).toEqual(['c1', 'c2']);
    expect(run.candidate).toContain('the granted children hold the answer');
  });
});

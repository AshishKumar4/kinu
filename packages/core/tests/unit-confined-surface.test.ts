// Confined surfaces finish `eval` over the finished set only: a head's function-form `codemodeTool`
// runs after the `allowedTools` filter; a node's proposal tool merges after the finish.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { scriptedTurnModel, toolExecute, unobservedSpend } from '@kinu.run/test-utils';
import { createTestRuntime, storesFor } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadCapture } from '../src/heads/head-inference';
import { buildHeadToolSet, type HeadSplitResult } from '../src/heads/head-tools';
import { HeadJournal } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { runNodeAgent, type NodeAgentDeps, type NodeAgentInput } from '../src/strategy/node-agent';
import type { HeadInput } from '../src/heads/types';
import type { WebSearchProvider } from '../src/web/index';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

interface SurfaceStep {
  reported: boolean;
  granted: boolean;
  proposed: boolean;
}

function contentFor(step: SurfaceStep): LanguageModelV3Content[] {
  if (step.reported) return [{ type: 'text', text: 'Done.' }];

  if (step.granted) {
    return [{
      type: 'tool-call',
      toolCallId: 'report-1',
      toolName: 'report',
      input: JSON.stringify({ status: 'completed', content: 'the granted children hold the answer' }),
    }];
  }

  if (step.proposed) return [{ type: 'text', text: 'Waiting on the grant.' }];

  return [{
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
}

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
    loop: defaultLoopOrigin('head'),
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

describe('head function-form eval resolves over the allowed surface', () => {
  test('the function builds over the filtered tools, and its entry runs', async () => {
    const { rt } = createTestRuntime();
    const allowed = ['eval', 'shell', 'file', 'record_evidence'];
    let seen: readonly string[] | null = null;

    const codemodeTool = (finished: ToolSet) => {
      seen = Object.keys(finished);

      return sandboxEntry('fn-ran');
    };

    const tools = buildHeadToolSet({
      history: storesFor(rt).history,
      input: headInput({ allowedTools: allowed }),
      capture: new HeadCapture(),
      rt,
      codemodeTool,
      webSearch: stubWeb,
      split: neverSplit,
    });

    const runSandbox = toolExecute<{ code: string }, string>(tools.eval);
    await expect(runSandbox({ code: 'const x = 1' })).resolves.toBe('fn-ran:const x = 1');
    const names: readonly string[] = seen ?? [];
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) expect(allowed).toContain(name);
    expect(names).toContain('shell');
    expect(names).not.toContain('web');
    expect(names).not.toContain('record_decision');
  });

  test('the function never runs when allowedTools drops eval', () => {
    const { rt } = createTestRuntime();
    let calls = 0;

    const codemodeTool = (_finished: ToolSet) => {
      calls += 1;

      return sandboxEntry('fn-ran');
    };

    const tools = buildHeadToolSet({
      history: storesFor(rt).history,
      input: headInput({ allowedTools: ['shell'] }),
      capture: new HeadCapture(),
      rt,
      codemodeTool,
      webSearch: stubWeb,
      split: neverSplit,
    });

    expect(tools.eval).toBeUndefined();
    expect(calls).toBe(0);
    expect(Object.keys(tools)).toEqual(['shell']);
  });

  test('a finished codemodeTool entry installs directly and runs', async () => {
    const { rt } = createTestRuntime();

    const tools = buildHeadToolSet({
      history: storesFor(rt).history,
      input: headInput(),
      capture: new HeadCapture(),
      rt,
      codemodeTool: sandboxEntry('direct-ran'),
      webSearch: stubWeb,
      split: neverSplit,
    });

    const runSandbox = toolExecute<{ code: string }, string>(tools.eval);
    await expect(runSandbox({ code: 'const x = 1' })).resolves.toBe('direct-ran:const x = 1');
  });
});

describe('node proposal merges after the eval finish', () => {
  test('the function never sees propose_branch, and propose still grants', async () => {
    const { rt, db } = createTestRuntime();
    initHeadsTables(rt.storage.execRaw);
    const journal = new HeadJournal(rt.storage.sql, rt.actor);
    let seen: readonly string[] | null = null;

    const codemodeTool = (finished: ToolSet) => {
      seen = Object.keys(finished);

      return sandboxEntry('fn-ran');
    };

    const model = scriptedTurnModel({
      modelId: 'fake-proposer',
      doGenerate: ({ prompt }) => {
        const text = JSON.stringify(prompt);
        const proposed = prompt.some((message) => message.role === 'tool');
        const granted = text.includes('Granted: 2 children');
        const reported = text.includes('"received":true');

        const content = contentFor({ reported, granted, proposed });

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
      reportModelCall: unobservedSpend,
      // One seat per node: a shared `rt` would give every node of a wave one actor.
      hostNode: hostedSeatsOver({ rt, db }).hostNode,
      model,
      journal,
      logger: createRecordingLogger(),
      nodeCodemode: () => codemodeTool,
    };

    const run = await runNodeAgent(input, deps);
    expect(run.report.status).toBe('completed');
    const names: readonly string[] = seen ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('eval');
    expect(run.granted?.kind).toBe('granted');

    if (run.granted?.kind === 'granted') expect(run.granted.nodeIds).toEqual(['c1', 'c2']);
    expect(run.candidate).toContain('the granted children hold the answer');
  });
});

// Confined surfaces finish `eval` over the finished set only: a head's function-form `codemodeTool`
// runs after the `allowedTools` filter; a node's proposal tool merges after the finish.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { handClock, scriptedTurnModel, toolExecute, unobservedSpend } from '@kinu.run/test-utils';
import { actorJobsFor, createTestRuntime, conversationsFor } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadCapture } from '../src/heads/head-inference';
import { buildHeadToolSet, type HeadSplitResult } from '../src/heads/head-tools';
import { spawnSeatedHead } from '../src/heads/seated-head';
import type { JobOutputFrame } from '../src/jobs/live-output';
import { readCallJob } from '../src/tools/call-job';
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
  render: async (url: string) => ({ url, retrievedAt: '', markdown: '' }),
  screenshot: async (url: string) => ({ url, retrievedAt: '', bytes: new Uint8Array() }),
};

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'analyze the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [],
    budget: { maxDepth: 0, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('swarm'),
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
      conversations: conversationsFor(rt),
      input: headInput({ allowedTools: allowed }),
      capture: new HeadCapture(),
      rt,
      jobs: actorJobsFor(rt),
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
      conversations: conversationsFor(rt),
      input: headInput({ allowedTools: ['shell'] }),
      capture: new HeadCapture(),
      rt,
      jobs: actorJobsFor(rt),
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
      conversations: conversationsFor(rt),
      input: headInput(),
      capture: new HeadCapture(),
      rt,
      jobs: actorJobsFor(rt),
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

// The head runner's own eval, outrunning its window: it detaches into the head's job, and the head is woken to finish.
describe("a seated head's long call becomes its own job, and the settle wakes it", () => {
  test('the call answers with a handle, its output streams, and the head reads the settled result', async () => {
    const { rt, db } = createTestRuntime();
    const seats = hostedSeatsOver({ rt, db });
    const clock = handClock(Date.now());
    const frames: JobOutputFrame[] = [];
    const prompts: string[] = [];
    /** How long the build runs, on the workspace's clock: past the 30 s window. */
    const BUILD_MS = 60_000;

    const build = tool({
      description: 'Run code in the sandbox.',
      inputSchema: jsonSchema<{ code: string }>({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }),
      execute: async ({ code }, options) => {
        await new Promise<void>((resolve) => { clock.after(BUILD_MS, resolve); });
        readCallJob(options)?.output.write('stdout', 'built\n');

        return `ran ${code}: exit 0`;
      },
    });

    // Calls eval; read back its answer, ends its turn; woken by the settle, answers.
    const model = scriptedTurnModel({
      doGenerate: ({ prompt }) => {
        const text = JSON.stringify(prompt);
        prompts.push(text);
        const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } };
        const answer = (said: string) => ({ content: [{ type: 'text' as const, text: said }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });

        if (text.includes('Background eval job')) return answer('The build finished.');

        if (prompt.some((message) => message.role === 'tool')) return answer('Started it.');

        return {
          content: [{ type: 'tool-call', toolCallId: 'eval-1', toolName: 'eval', input: JSON.stringify({ code: 'await build()' }) }],
          finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
        };
      },
    });

    const head = spawnSeatedHead(headInput({ id: 'head-detach' }), {
      seat: async () => {
        const seat = await seats.seat('head-detach', 'swarm');

        // The workspace's clock, which the call's window and the build run on.
        return { ...seat, release: async () => {}, jobs: { jobOutput: (frame) => { frames.push(frame); }, clock } };
      },
      model: async () => ({ model, spec: null }),
      codemodeTool: () => build,
      webSearch: stubWeb,
      split: () => neverSplit,
      mission: () => null,
      reportStep: () => {},
      reportDelta: () => {},
    });

    const running = head.run();
    // The first wait to arm is the call's window; fired, the call outruns it.
    await clock.whenArmed(1);
    clock.tick();

    // Its build still runs, as the head's job: the run ends only after the build does.
    const first = await Promise.race([
      running.then(() => 'the head finished'), clock.whenArmed(2).then(() => 'the build still runs'),
    ]);

    expect(first).toBe('the build still runs');
    clock.advance(BUILD_MS);
    const report = await running;

    expect(prompts.some((text) => text.includes('backgrounded'))).toBe(true);
    // Woken with what it would have read: it has no `agent.jobResult`.
    expect(prompts.at(-1)).toContain('ran await build(): exit 0');
    expect(report.status).toBe('completed');
    expect(report.summary).toContain('The build finished.');
    // What it printed went out through the workspace's port.
    expect(frames.flatMap((frame) => frame.chunks.map((chunk) => chunk.text)).join('')).toBe('built\n');
  });
});

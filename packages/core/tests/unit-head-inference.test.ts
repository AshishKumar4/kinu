// runHeadInference — the backend-agnostic head loop (re-arch P6b). Drives the
// real generateText loop with a fake v2 model so the status/summary/usage/steps
// assembly that used to live inside the cf Facet is locked behind a test both
// backends rely on.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import {
  runHeadInference, HeadCapture, buildHeadAccumulatorTools, buildHeadSandboxTools,
  buildHeadSystemPrompt, buildHeadMessages,
} from '../src/heads/head-inference.js';
import type { HeadInput } from '../src/heads/types.js';
import { createMemoryVFS } from './helpers.js';

/** A v2 generateText-driving stub. Returns `answer` as one text step + usage;
 *  finishReason 'stop' so the head ends in a single step (no tool calls). */
function fakeHeadModel(answer: string, opts?: { throwError?: string; usage?: { inputTokens: number; outputTokens: number } }): LanguageModel {
  const usage = opts?.usage ?? { inputTokens: 10, outputTokens: 20 };
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake-head', supportedUrls: {},
    doGenerate: async () => {
      if (opts?.throwError) throw new Error(opts.throwError);
      return {
        content: answer ? [{ type: 'text', text: answer }] : [],
        finishReason: 'stop' as const,
        usage,
        response: { id: 'r', modelId: 'fake-head', timestamp: new Date(0) },
        warnings: [],
      };
    },
  } as unknown as LanguageModel;
}

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'analyze the parser', rationale: 'cover the lexer angle',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'the prior user message', createdAt: 1 }],
    budget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 60_000, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    ...overrides,
  };
}

const deps = (model: LanguageModel, over?: Partial<Parameters<typeof runHeadInference>[1]>) => ({
  model, tools: {}, capture: new HeadCapture(), isAborted: () => false, ...over,
});

describe('runHeadInference — report assembly', () => {
  test('a completed head: final text → summary, usage summed, steps captured', async () => {
    const report = await runHeadInference(headInput(), deps(fakeHeadModel('The lexer handles UTF-8 correctly.')));
    expect(report.status).toBe('completed');
    expect(report.summary).toBe('The lexer handles UTF-8 correctly.');
    expect(report.tokenUsage).toEqual({ input: 10, output: 20, total: 30 });
    expect(report.steps.length).toBeGreaterThanOrEqual(1);
    expect(report.id).toBe('h1');
  });

  test('budget already exhausted → status budget_exceeded', async () => {
    const input = headInput({ budget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 1, spawnedAt: 1 } });
    const report = await runHeadInference(input, deps(fakeHeadModel('partial')));
    expect(report.status).toBe('budget_exceeded');
  });

  test('aborted → status aborted + errorMessage from abortReason', async () => {
    const report = await runHeadInference(
      headInput(),
      deps(fakeHeadModel('text'), { isAborted: () => true, abortReason: () => 'operator cancelled' }),
    );
    expect(report.status).toBe('aborted');
    expect(report.errorMessage).toBe('operator cancelled');
  });

  test('model throw → status errored, no steps, message preserved', async () => {
    const report = await runHeadInference(headInput(), deps(fakeHeadModel('', { throwError: 'model exploded' })));
    expect(report.status).toBe('errored');
    expect(report.errorMessage).toContain('model exploded');
    expect(report.steps).toEqual([]);
  });

  test('no prose + recorded evidence → summary synthesized from findings', async () => {
    const capture = new HeadCapture();
    capture.recordEvidence({ id: 'e1', kind: 'fact', body: 'Postgres has mature JSONB' });
    capture.recordDecision({ question: 'Which DB?', choice: 'Postgres', rationale: 'JSONB' });
    const report = await runHeadInference(headInput(), deps(fakeHeadModel(''), { capture }));
    expect(report.status).toBe('completed');
    expect(report.summary).toContain('Postgres');     // synthesizeHeadSummary fallback
    expect(report.evidence).toHaveLength(1);
    expect(report.decisions).toHaveLength(1);
  });
});

describe('buildHeadAccumulatorTools', () => {
  test('record_evidence / record_decision push into the shared capture', async () => {
    const capture = new HeadCapture();
    const tools = buildHeadAccumulatorTools(capture) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;
    const opt = { toolCallId: 't', messages: [] };
    await tools.record_evidence!.execute({ kind: 'fact', body: 'X holds' }, opt);
    await tools.record_decision!.execute({ question: 'q', choice: 'c', rationale: 'r' }, opt);
    expect(capture.evidence[0]!.body).toBe('X holds');
    expect(capture.evidence[0]!.id).toMatch(/^ev-/);
    expect(capture.decisions[0]!.choice).toBe('c');
    // Each tool also logs a tool call for telemetry.
    expect(capture.toolCalls.map((t) => t.name)).toEqual(['record_evidence', 'record_decision']);
  });
});

describe('buildHeadSandboxTools', () => {
  test('write → read round-trips in the private VFS + records a file artifact; exec runs the shell', async () => {
    const capture = new HeadCapture();
    const vfs = createMemoryVFS(new Database(':memory:'));
    const shell = { exec: async (cmd: string) => ({ stdout: `ran: ${cmd}`, stderr: '', exitCode: 0 }) };
    const tools = buildHeadSandboxTools(shell, vfs, capture) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;
    const opt = { toolCallId: 't', messages: [] };

    await tools.sandbox_write!.execute({ path: '/scratch/a.txt', content: 'hello head' }, opt);
    expect(capture.artifacts[0]!.ref).toBe('/scratch/a.txt');
    expect(await tools.sandbox_read!.execute({ path: '/scratch/a.txt' }, opt)).toBe('hello head');
    expect(await tools.sandbox_exec!.execute({ command: 'echo hi' }, opt)).toContain('ran: echo hi');
    expect(capture.toolCalls.map((t) => t.name)).toEqual(['sandbox_write', 'sandbox_read', 'sandbox_exec']);
  });
});

describe('head prompt + messages', () => {
  test('system prompt carries task/rationale/budget; messages carry inherited context', () => {
    const input = headInput();
    const sys = buildHeadSystemPrompt(input);
    expect(sys).toContain('analyze the parser');
    expect(sys).toContain('record_evidence');
    const msgs = buildHeadMessages(input);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain('the prior user message');
    expect(msgs[0]!.content).toContain('analyze the parser');
  });
});

// The ChatEvent seam is a projection of what the ai-SDK stream hands runChat,
// and every field it drops is a signal nothing downstream can rebuild: the tool
// success/error discriminator feeds the CLI's evolution signal (hadError,
// outcome review), cached-prefix tokens are the whole of its cache telemetry,
// and a usage flattened into three numbers gated on `> 0` turns a
// provider-reported zero into "unreported" — which makes a cold prefix
// indistinguishable from a provider that says nothing. These tests pin all of
// it through the public runChat interface.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, collectStepText, ExtensionHost, createAgentsTool, createAgentsCodemodeProvider, type ChatEvent, type KinuExtension, type Usage } from '../src/index';
import { synthesizeToolFallback } from '../src/prompts/evidence-window';
import { isFailingToolResult } from '../src/orchestrator/turn-steering';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';

type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function finishPart(reason: 'stop' | 'tool-calls', usage: FinishPart['usage'] = USAGE): FinishPart {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage };
}

/** A model whose first step calls one tool, then answers with text. The first
 *  step's finish part carries the caller-supplied usage so a test can assert
 *  what the ChatEvent seam surfaces. */
function toolThenTextModel(opts: {
  toolName: string;
  input?: string;
  firstUsage?: FinishPart['usage'];
}): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      step += 1;
      const stream = step === 1
        ? new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-call', toolCallId: 'tc1', toolName: opts.toolName, input: opts.input ?? '{}' });
              c.enqueue(finishPart('tool-calls', opts.firstUsage));
              c.close();
            },
          })
        : new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: 't1' });
              c.enqueue({ type: 'text-delta', id: 't1', delta: 'recovered' });
              c.enqueue({ type: 'text-end', id: 't1' });
              c.enqueue(finishPart('stop'));
              c.close();
            },
          });
      return { stream, response: { headers: {} } };
    },
  });
}

async function collect(model: LanguageModel, tools: ToolSet, extensions?: ExtensionHost): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const request = {
    model,
    system: 'sys',
    history: [{ role: 'user', content: 'go' }] satisfies ModelMessage[],
    tools,
    stopWhen: stepCountIs(3),
  };
  const stream = extensions === undefined
    ? runChat(request)
    : runChat({ ...request, extensions });
  for await (const ev of stream) {
    events.push(ev);
  }
  return events;
}

describe('ChatEvent tool success/error fidelity', () => {
  test('successful JSON-looking command data does not fail the invocation', async () => {
    const stdout = JSON.stringify({ reason: 'denied', error: 'historical incident' });
    const failures: boolean[] = [];
    const extension: KinuExtension = {
      name: 'outcome-probe',
      onToolResult: (ctx) => { failures.push(isFailingToolResult(ctx)); },
    };
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt: { ...rt, shell: { exec: async () => ({ stdout, stderr: '', exitCode: 0 }) } } });
    const model = toolThenTextModel({ toolName: 'run', input: JSON.stringify({ command: 'cat incident.json' }) });
    const events = await collect(model, tools, new ExtensionHost().register(extension));
    expect(failures).toEqual([false]);
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ result: stdout, success: true });
  });

  test('native command failure retains observed exit provenance through the SDK', async () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt: { ...rt, shell: {
      exec: async () => ({ stdout: 'tests failed', stderr: 'detail', exitCode: 7 }),
    } } });
    const model = toolThenTextModel({ toolName: 'run', input: JSON.stringify({ command: 'test' }) });
    const events = await collect(model, tools);
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({
      success: false, reason: 'io', execution: { exitCode: 7 }, result: expect.stringContaining('tests failed'),
    });
    expect(model.doStreamCalls[1]?.prompt).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'tool', content: expect.arrayContaining([expect.objectContaining({
        type: 'tool-result', toolCallId: 'tc1', output: {
          type: 'error-json', value: { reason: 'io', error: expect.stringContaining('tests failed'), execution: { exitCode: 7 } },
        },
      })]),
    })]));
  });
  test.each([
    { stage: 'resolution', input: { action: 'swarm', preset: 'custom', task: 'inspect', label: 'custom-case' }, reason: 'bad_input', detail: 'config' },
    { stage: 'validity', input: { action: 'swarm', preset: 'ideate', task: 'inspect', depth: 2 }, reason: 'bad_input', detail: 'depth' },
    { stage: 'runtime', input: { action: 'swarm', preset: 'ideate', task: 'inspect', models: ['fake/missing'] }, reason: 'unsupported', detail: 'resolver' },
  ])('native swarm $stage refusal fails the SDK invocation and remains branchable in codemode', async ({ input, reason, detail }) => {
    const { rt, db } = createTestRuntime();
    // A real seat per node: each refusal below is raised BEFORE any node runs,
    // but the seam has to be the production one or the refusal would be the
    // fixture's rather than the run's.
    const deps = {
      mode: 'build',
      swarm: { rt, hostNode: hostedSeatsOver({ rt, db }).hostNode, model: new MockLanguageModelV3() },
    } satisfies Parameters<typeof createAgentsTool>[0];
    const events = await collect(toolThenTextModel({ toolName: 'agents', input: JSON.stringify(input) }), { agents: createAgentsTool(deps) });
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ success: false, reason, result: expect.stringContaining(detail) });
    const namespace = createAgentsCodemodeProvider(() => deps);
    expect(await namespace.tools.swarm?.execute(input)).toMatchObject({ reason, error: expect.stringContaining(detail) });
  });

  test('a throwing tool yields a tool-result with success:false and the error text', async () => {
    const seenByExtension: string[] = [];
    const ext: KinuExtension = {
      name: 'recorder',
      onToolResult: ({ result }) => { seenByExtension.push(result); },
    };
    const model = toolThenTextModel({ toolName: 'boom' });
    const tools = {
      boom: tool({
        description: 'always fails',
        inputSchema: z.object({}),
        execute: async (): Promise<string> => { throw new Error('kaboom'); },
      }),
    };

    const events = await collect(model, tools, new ExtensionHost().register(ext));
    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ type: 'tool-result', toolName: 'boom', success: false });
    expect(result?.type === 'tool-result' && result.error).toContain('kaboom');
    // The extension seam still observes the round-trip — with the error text.
    expect(seenByExtension.some((r) => r.includes('kaboom'))).toBe(true);
  });

  test('a structured (object) tool result renders as JSON content, not "[object Object]"', async () => {
    const model = toolThenTextModel({ toolName: 'structured' });
    const tools = {
      structured: tool({
        description: 'returns an object',
        inputSchema: z.object({}),
        execute: async () => ({ result: 42, logs: ['printed'] }),
      }),
    };
    const events = await collect(model, tools);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.type === 'tool-result' && result.result).toBe('{"result":42,"logs":["printed"]}');
    expect(result?.type === 'tool-result' && result.result).not.toContain('[object Object]');
  });

  test('a succeeding tool yields success:true and no error', async () => {
    const model = toolThenTextModel({ toolName: 'ok' });
    const tools = {
      ok: tool({ description: 'works', inputSchema: z.object({}), execute: async () => 'fine' }),
    };
    const events = await collect(model, tools);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toMatchObject({ type: 'tool-result', toolName: 'ok', result: 'fine', success: true });
    expect(result?.type === 'tool-result' && result.error).toBeUndefined();
  });

  test('the call and its result both carry the provider toolCallId', async () => {
    const model = toolThenTextModel({ toolName: 'ok' });
    const tools = {
      ok: tool({ description: 'works', inputSchema: z.object({}), execute: async () => 'fine' }),
    };
    const events = await collect(model, tools);
    // 'tc1' is what the fake model's stream part declares — surfaces that
    // report calls out of band (ACP tool_call/tool_call_update) pair on it.
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ toolCallId: 'tc1' });
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ toolCallId: 'tc1' });
  });
});

describe('ChatEvent tool-result completeness', () => {
  // The result string is the call's durable record AND the turn steering's
  // identity for it. A head slice made two different outputs sharing a long
  // preamble hash identical (so the harness told the model "repeating cannot
  // tell you anything new" about a call whose output had changed) and hid the
  // tail of every large failure.
  const preamble = 'x'.repeat(4_000);

  test('a result far past the old 1000-char bound reaches the seam whole', async () => {
    const seen: string[] = [];
    const ext: KinuExtension = { name: 'recorder', onToolResult: ({ result }) => { seen.push(result); } };
    const body = `${preamble}THE-TAIL`;
    const model = toolThenTextModel({ toolName: 'big' });
    const tools = {
      big: tool({ description: 'verbose', inputSchema: z.object({}), execute: async () => body }),
    };
    const events = await collect(model, tools, new ExtensionHost().register(ext));
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.type === 'tool-result' && result.result).toBe(body);
    expect(seen).toEqual([body]);
  });

  test('a long error keeps its tail, so the failure text survives', async () => {
    const seen: string[] = [];
    const ext: KinuExtension = { name: 'recorder', onToolResult: ({ result }) => { seen.push(result); } };
    const model = toolThenTextModel({ toolName: 'boom' });
    const tools = {
      boom: tool({
        description: 'fails verbosely',
        inputSchema: z.object({}),
        execute: async (): Promise<string> => { throw new Error(`${preamble}kaboom`); },
      }),
    };
    const events = await collect(model, tools, new ExtensionHost().register(ext));
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.type === 'tool-result' && result.result.endsWith('kaboom')).toBe(true);
    expect(seen[0]?.endsWith('kaboom')).toBe(true);
  });
});

describe('ChatEvent usage fidelity', () => {
  const okTool = {
    ok: tool({ description: 'works', inputSchema: z.object({}), execute: async () => 'fine' }),
  };

  /** The first step's normalized usage, or the fact that the seam omitted it. */
  async function firstStepUsage(firstUsage: FinishPart['usage']): Promise<Usage | undefined> {
    const model = toolThenTextModel({ toolName: 'ok', firstUsage });
    const events = await collect(model, okTool);
    const step = events.find((e) => e.type === 'step-finish');
    if (step?.type !== 'step-finish') throw new Error('the turn produced no step-finish');
    return step.usage;
  }

  test('step-finish reports the step request, cache read included, under the normalized names', async () => {
    const usage = await firstStepUsage({
      inputTokens: { total: 20, noCache: 8, cacheRead: 12, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: 2 },
    });
    expect(usage).toEqual({ input: 20, output: 5, cacheRead: 12, reasoning: 2 });
  });

  test('a provider-reported zero cache read stays 0, while an unreported reasoning split stays absent', async () => {
    // The distinction this ticket exists for: a cold prefix on a working cache
    // plan reports 0, and `0` must not read as "this provider never mentions
    // cache reads" — which is what the old `> 0` gate made of it.
    const usage = await firstStepUsage({
      inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    });
    expect(usage?.cacheRead).toBe(0);
    expect(Object.keys(usage ?? {}).sort()).toEqual(['cacheRead', 'input', 'output']);
  });

  test('a step whose provider reports nothing at all carries no usage', async () => {
    const usage = await firstStepUsage({
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    });
    expect(usage).toBeUndefined();
  });
});

describe('tool-only no-text fallback', () => {
  test('identical tool-only steps read the same through both paths', () => {
    const steps = [{ text: '', toolResults: [{ toolName: 'read', output: 'x'.repeat(2000) }] }];
    const viaCollector = collectStepText({ text: '', steps });
    expect(viaCollector).toBe(synthesizeToolFallback(steps));
  });

  test('a long tool result keeps its tail, and a missing output stays empty', () => {
    const body = `OPENING${'-'.repeat(2000)}CLOSING`;
    const steps = [{ text: '', toolResults: [{ toolName: 'read', output: body }] }];
    const text = collectStepText({ text: '', steps });
    expect(text.startsWith('[read] OPENING')).toBe(true);
    expect(text.endsWith('CLOSING')).toBe(true);
    expect(text).toContain('chars omitted from the middle');
    const missing = collectStepText({ text: '', steps: [{ text: '', toolResults: [{ toolName: 't', output: null }] }] });
    expect(missing).toBe('[t] ');
  });
});

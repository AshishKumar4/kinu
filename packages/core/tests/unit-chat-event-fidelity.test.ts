// Every field the ChatEvent seam drops is unrecoverable downstream; a reported zero must stay distinct from unreported.
import { unobservedSearchSeams } from '@kinu.run/test-utils';
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, collectStepText, ExtensionHost, createAgentsTool, createAgentsCodemodeProvider, type ChatEvent, type KinuExtension, type Usage } from '../src/index';
import { synthesizeToolFallback } from '../src/prompts/evidence-window';
import { isFailingToolResult } from '../src/orchestrator/turn-steering';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime, storesFor } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';

type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function finishPart(reason: 'stop' | 'tool-calls', usage: FinishPart['usage'] = USAGE): FinishPart {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage };
}

/** Calls one tool, then answers; the first step's finish carries the caller-supplied usage. */
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
    const tools = buildBuiltinTools({ rt: { ...rt, shell: { exec: async () => ({ stdout, stderr: '', exitCode: 0 }) } }, history: storesFor(rt).history });
    const model = toolThenTextModel({ toolName: 'shell', input: JSON.stringify({ command: 'cat incident.json' }) });
    const events = await collect(model, tools, new ExtensionHost().register(extension));
    expect(failures).toEqual([false]);
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ result: stdout, success: true });
  });

  test('native command failure retains observed exit provenance through the SDK', async () => {
    const { rt } = createTestRuntime();

    const tools = buildBuiltinTools({ rt: { ...rt, shell: {
      exec: async () => ({ stdout: 'tests failed', stderr: 'detail', exitCode: 7 }),
    } }, history: storesFor(rt).history });

    const model = toolThenTextModel({ toolName: 'shell', input: JSON.stringify({ command: 'test' }) });
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

  test('a model call lacking a field its tool requires returns bad_input naming the field, and the tool never runs', async () => {
    let runs = 0;
    const { rt } = createTestRuntime();

    // Counted, not recorded: `toEqual([])` would pass on `[undefined]`, the command a call without one passes.
    const shell = {
      exec: async () => {
        runs += 1;

        return { stdout: 'ran', stderr: '', exitCode: 0 };
      },
    };

    const model = toolThenTextModel({ toolName: 'shell', input: '{}' });
    const events = await collect(model, buildBuiltinTools({ rt: { ...rt, shell }, history: storesFor(rt).history }));
    expect(runs).toBe(0);
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ success: false, reason: 'bad_input', result: expect.stringContaining('command') });

    // The model reads the refusal as data it can branch on.
    expect(model.doStreamCalls[1]?.prompt).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'tool', content: expect.arrayContaining([expect.objectContaining({
        type: 'tool-result', toolCallId: 'tc1', output: { type: 'error-json', value: { reason: 'bad_input', error: expect.stringContaining('command') } },
      })]),
    })]));
  });
  test.each([
    { stage: 'resolution', input: { action: 'swarm', preset: 'custom', task: 'inspect', label: 'custom-case' }, reason: 'bad_input', detail: 'config' },
    { stage: 'validity', input: { action: 'swarm', preset: 'ideate', task: 'inspect', depth: 2 }, reason: 'bad_input', detail: 'depth' },
    { stage: 'runtime', input: { action: 'swarm', preset: 'ideate', task: 'inspect', models: ['fake/missing'] }, reason: 'unsupported', detail: 'resolver' },
  ])('native swarm $stage refusal fails the SDK invocation and remains branchable in codemode', async ({ input, reason, detail }) => {
    const { rt, db } = createTestRuntime();

    // A production seat per node, so the refusal is the run's and not the fixture's.
    const deps = {
      mode: 'build',
      swarm: { rt, hostNode: hostedSeatsOver({ rt, db }).hostNode, model: new MockLanguageModelV3(), ...unobservedSearchSeams() },
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
    // Out-of-band surfaces (ACP tool_call/tool_call_update) pair on this id.
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ toolCallId: 'tc1' });
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ toolCallId: 'tc1' });
  });
});

describe('the loop repairs a malformed tool call before it lands', () => {
  // Per-rewrite behaviour is pinned in unit-repair-tool-call; this pins that the loop asks for it.
  function readFileTool(received: unknown[]) {
    return {
      readFile: tool({
        description: 'reads',
        inputSchema: z.object({ path: z.string() }),
        execute: async (input) => {
          received.push(input);

          return 'contents';
        },
      }),
    };
  }

  test('a case-drifted name executes as the one tool it names', async () => {
    const received: unknown[] = [];
    const events = await collect(toolThenTextModel({ toolName: 'ReadFile', input: JSON.stringify({ path: 'a.txt' }) }), readFileTool(received));
    expect(received).toEqual([{ path: 'a.txt' }]);
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ toolName: 'readFile', args: { path: 'a.txt' } });
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ toolName: 'readFile', result: 'contents', success: true });
  });

  test('double-encoded arguments are decoded and the call executes', async () => {
    const received: unknown[] = [];
    const events = await collect(toolThenTextModel({ toolName: 'readFile', input: JSON.stringify(JSON.stringify({ path: 'b.txt' })) }), readFileTool(received));
    expect(received).toEqual([{ path: 'b.txt' }]);
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ toolName: 'readFile', result: 'contents', success: true });
  });
});

describe('ChatEvent tool-result completeness', () => {
  // The result string is the call's identity for steering: a head slice would make distinct outputs hash equal.
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

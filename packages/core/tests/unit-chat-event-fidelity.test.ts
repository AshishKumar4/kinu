// The ChatEvent seam is a projection of what the ai-SDK stream hands runChat.
// It used to drop the tool success/error discriminator (poisoning the CLI's
// evolution signal — hadError, outcome review) and cached-prefix tokens (cache
// telemetry read 0 on the CLI path). These tests pin both fidelities through
// the public runChat interface.
import { describe, test, expect } from 'bun:test';
import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, ExtensionHost, type ChatEvent, type ProteusExtension } from '../src/index.ts';

type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;
type FinishOverrides = Partial<Pick<FinishPart, 'usage' | 'providerMetadata'>>;

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function finishPart(
  reason: 'stop' | 'tool-calls',
  overrides: FinishOverrides = {},
): FinishPart {
  const base: FinishPart = {
    type: 'finish',
    finishReason: { unified: reason, raw: undefined },
    usage: overrides.usage ?? USAGE,
  };
  return overrides.providerMetadata === undefined
    ? base
    : { ...base, providerMetadata: overrides.providerMetadata };
}

/** A model whose first step calls one tool, then answers with text. The
 *  finish parts carry the caller-supplied usage/providerMetadata so a test can
 *  assert what the ChatEvent seam surfaces. */
function toolThenTextModel(opts: {
  toolName: string;
  firstFinish?: FinishOverrides;
}): LanguageModel {
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
              c.enqueue({ type: 'tool-call', toolCallId: 'tc1', toolName: opts.toolName, input: '{}' });
              c.enqueue(finishPart('tool-calls', opts.firstFinish));
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
    maxSteps: 3,
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
  test('a throwing tool yields a tool-result with success:false and the error text', async () => {
    const seenByExtension: string[] = [];
    const ext: ProteusExtension = {
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
    const ext: ProteusExtension = { name: 'recorder', onToolResult: ({ result }) => { seen.push(result); } };
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
    const ext: ProteusExtension = { name: 'recorder', onToolResult: ({ result }) => { seen.push(result); } };
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

describe('ChatEvent cached-token fidelity', () => {
  test('step-finish carries usage.cachedInputTokens plus the Anthropic providerMetadata read', async () => {
    const model = toolThenTextModel({
      toolName: 'ok',
      firstFinish: {
        usage: {
          inputTokens: { total: 20, noCache: 8, cacheRead: 12, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        providerMetadata: { anthropic: { cacheReadInputTokens: 3 } },
      },
    });
    const tools = {
      ok: tool({ description: 'works', inputSchema: z.object({}), execute: async () => 'fine' }),
    };
    const events = await collect(model, tools);
    const firstStep = events.find((e) => e.type === 'step-finish');
    expect(firstStep).toBeDefined();
    // 12 (usage) + 3 (anthropic providerMetadata) combined into the one flat field.
    expect(firstStep?.type === 'step-finish' && firstStep.cachedInputTokens).toBe(15);
    expect(firstStep?.type === 'step-finish' && firstStep.inputTokens).toBe(20);
  });

  test('step-finish omits cachedInputTokens when the provider reports none', async () => {
    const model = toolThenTextModel({ toolName: 'ok' });
    const tools = {
      ok: tool({ description: 'works', inputSchema: z.object({}), execute: async () => 'fine' }),
    };
    const events = await collect(model, tools);
    const step = events.find((e) => e.type === 'step-finish');
    expect(step?.type === 'step-finish' && step.cachedInputTokens).toBeUndefined();
  });
});

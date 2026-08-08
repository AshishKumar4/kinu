// The ChatEvent seam is a projection of what the ai-SDK stream hands runChat.
// It used to drop the tool success/error discriminator (poisoning the CLI's
// evolution signal — hadError, outcome review) and cached-prefix tokens (cache
// telemetry read 0 on the CLI path). These tests pin both fidelities through
// the public runChat interface.
import { describe, test, expect } from 'bun:test';
import { tool, type LanguageModelV2StreamPart } from 'ai';
import { z } from 'zod';
import { runChat, ExtensionHost, type ChatEvent, type ProteusExtension } from '../src/index.ts';

const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

/** A v2 model whose first step calls one tool, then answers with text. The
 *  finish parts carry the caller-supplied usage/providerMetadata so a test can
 *  assert what the ChatEvent seam surfaces. */
function toolThenTextModel(opts: {
  toolName: string;
  firstFinish?: Partial<LanguageModelV2StreamPart & { type: 'finish' }>;
}) {
  let step = 0;
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async () => {
      step += 1;
      const stream = step === 1
        ? new ReadableStream<LanguageModelV2StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-call', toolCallId: 'tc1', toolName: opts.toolName, input: '{}' });
              c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE, ...opts.firstFinish } as LanguageModelV2StreamPart);
              c.close();
            },
          })
        : new ReadableStream<LanguageModelV2StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: 't1' });
              c.enqueue({ type: 'text-delta', id: 't1', delta: 'recovered' });
              c.enqueue({ type: 'text-end', id: 't1' });
              c.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
              c.close();
            },
          });
      return { stream, response: { headers: {} } };
    },
  };
  return model;
}

async function collect(model: unknown, tools: Record<string, unknown>, extensions?: ExtensionHost): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of runChat({
    model: model as never,
    system: 'sys',
    history: [{ role: 'user', content: 'go' }],
    tools: tools as never,
    maxSteps: 3,
    ...(extensions ? { extensions } : {}),
  })) {
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
        execute: async () => { throw new Error('kaboom'); },
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

describe('ChatEvent cached-token fidelity', () => {
  test('step-finish carries usage.cachedInputTokens plus the Anthropic providerMetadata read', async () => {
    const model = toolThenTextModel({
      toolName: 'ok',
      firstFinish: {
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 12 },
        providerMetadata: { anthropic: { cacheReadInputTokens: 3 } },
      } as Partial<LanguageModelV2StreamPart & { type: 'finish' }>,
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

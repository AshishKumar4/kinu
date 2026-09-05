// The ChatEvent seam is a projection of what the ai-SDK stream hands runChat.
// It used to drop the tool success/error discriminator (poisoning the CLI's
// evolution signal — hadError, outcome review) and cached-prefix tokens (cache
// telemetry read 0 on the CLI path). It then flattened usage into three numbers
// gated on `> 0`, which turned a provider-reported zero into "unreported" and
// made a cold prefix indistinguishable from a provider that says nothing. These
// tests pin all of it through the public runChat interface.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, collectStepText, ExtensionHost, type ChatEvent, type KinuExtension, type Usage } from '../src/index';
import { synthesizeToolFallback } from '../src/prompts/evidence-window';

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
  firstUsage?: FinishPart['usage'];
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

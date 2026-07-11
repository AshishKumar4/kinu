// Behavior tests for the public extension seam (extension.ts + its wiring into
// runChat). Two levels:
//   1. Through a real runChat turn: registered hooks fire in order around the
//      turn (start → tool-call → tool-result → end) and a registerTools tool is
//      folded into the ToolSet the model actually sees.
//   2. Direct ExtensionHost unit: tool merge + collision, prepareStep chaining,
//      and emit ordering across multiple extensions.
import { describe, test, expect } from 'bun:test';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import {
  ExtensionHost,
  runChat,
  composePrepareStep,
  type ProteusExtension,
  type ChatEvent,
} from '../src/index.ts';

/** A v2 language-model stub that requests the `ping` tool on step 1, then
 *  answers with text on step 2. Captures the tool names it was handed so a test
 *  can assert an extension-contributed tool reached the model. */
function toolThenTextModel() {
  let step = 0;
  let toolNames: string[] = [];
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (options: { tools?: Array<{ name: string }> }) => {
      step += 1;
      if (step === 1) toolNames = (options.tools ?? []).map((t) => t.name);
      const stream = step === 1
        ? new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-call', toolCallId: 'tc1', toolName: 'ping', input: '{}' });
              c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              c.close();
            },
          })
        : new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: 't1' });
              c.enqueue({ type: 'text-delta', id: 't1', delta: 'all done' });
              c.enqueue({ type: 'text-end', id: 't1' });
              c.enqueue({ type: 'finish', finishReason: 'stop', usage });
              c.close();
            },
          });
      return { stream, response: { headers: {} } };
    },
  };
  return { model, toolNames: () => toolNames };
}

describe('extension seam through runChat', () => {
  test('hooks fire in order around a turn, and registerTools reaches the model', async () => {
    const { model, toolNames } = toolThenTextModel();
    const order: string[] = [];
    let endText = '';
    let startedSteps = 0;

    const ext: ProteusExtension = {
      name: 'recorder',
      onTurnStart: () => { order.push('turn-start'); },
      onToolCall: ({ toolName }) => { order.push(`tool-call:${toolName}`); },
      onToolResult: ({ toolName }) => { order.push(`tool-result:${toolName}`); },
      onTurnEnd: ({ text }) => { order.push('turn-end'); endText = text; },
      prepareStep: ({ stepNumber }) => { startedSteps = Math.max(startedSteps, stepNumber + 1); return undefined; },
      registerTools: () => ({
        ping: tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' }),
      }),
    };

    const events: ChatEvent[] = [];
    for await (const ev of runChat({
      model: model as never,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: {},
      maxSteps: 3,
      extensions: new ExtensionHost().register(ext),
    })) {
      events.push(ev);
    }

    // The contributed tool was handed to the model.
    expect(toolNames()).toContain('ping');
    // Ordered lifecycle: start first, the tool round-trip in the middle, end last.
    expect(order[0]).toBe('turn-start');
    expect(order[order.length - 1]).toBe('turn-end');
    expect(order).toEqual(['turn-start', 'tool-call:ping', 'tool-result:ping', 'turn-end']);
    // onTurnEnd saw the final text; the generator's done event agrees.
    expect(endText).toBe('all done');
    expect(startedSteps).toBeGreaterThan(0);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.text).toBe('all done');
  });

  test('a turn with no extensions still streams (seam is optional)', async () => {
    const { model } = toolThenTextModel();
    const texts: string[] = [];
    for await (const ev of runChat({
      model: model as never,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: { ping: tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' }) },
      maxSteps: 3,
    })) {
      if (ev.type === 'text-delta') texts.push(ev.delta);
    }
    expect(texts.join('')).toBe('all done');
  });
});

/** A one-step text model that captures the prompt it was handed. */
function promptCapturingModel() {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  let prompt: Array<{ role: string; content: unknown }> = [];
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      prompt = options.prompt;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't1' });
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 't1' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage });
            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  };
  return { model, prompt: () => prompt };
}

function userTexts(prompt: Array<{ role: string; content: unknown }>): string[] {
  return prompt
    .filter((m) => m.role === 'user')
    .map((m) => (m.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text').map((p) => p.text ?? '').join(''));
}

describe('transformContext through runChat', () => {
  test('rewrites the durable history; ephemeral context is spliced AFTER (never seen by the transform)', async () => {
    const { model, prompt } = promptCapturingModel();
    let transformSaw: string[] = [];

    const compactor: ProteusExtension = {
      name: 'compactor',
      transformContext: async ({ messages }) => {
        transformSaw = messages.map((m) => String(m.content));
        return [{ role: 'user', content: 'summary-of-history' }];
      },
    };

    for await (const _ of runChat({
      model: model as never,
      system: 'sys',
      history: [
        { role: 'user', content: 'old-1' },
        { role: 'assistant', content: 'old-2' },
        { role: 'user', content: 'old-3' },
      ],
      turnLocal: [{ role: 'user', content: 'volatile-tail' }],
      tools: {},
      maxSteps: 1,
      extensions: new ExtensionHost().register(compactor),
    })) { /* drain */ }

    // The transform saw ONLY the durable history — not the ephemeral tail.
    expect(transformSaw).toEqual(['old-1', 'old-2', 'old-3']);
    // The model saw the rewritten history with the ephemeral tail after it.
    expect(userTexts(prompt())).toEqual(['summary-of-history', 'volatile-tail']);
  });

  test('a throwing transform never breaks the turn (fail-open)', async () => {
    const { model, prompt } = promptCapturingModel();
    let doneText = '';
    for await (const ev of runChat({
      model: model as never,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: {},
      maxSteps: 1,
      extensions: new ExtensionHost().register({
        name: 'broken',
        transformContext: async () => { throw new Error('boom'); },
      }),
    })) {
      if (ev.type === 'done') doneText = ev.text;
    }
    expect(doneText).toBe('ok');
    expect(userTexts(prompt())).toEqual(['go']);
  });
});

describe('composePrepareStep (the shared step pipeline)', () => {
  const base: ModelMessage[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];

  test('extension rewrites first, cache tail markers land LAST on the final array', () => {
    const host = new ExtensionHost().register({
      name: 'steer',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 'steered' }],
    });
    const out = composePrepareStep(host, { stepNumber: 0, messages: base }, { strategy: { kind: 'anthropic' } });
    expect(out?.messages.map((m) => m.content)).toEqual(['a', 'b', 'steered']);
    // The marker rides the injected tail message — proof the markers were
    // applied AFTER the extension rewrite.
    const tail = out!.messages[out!.messages.length - 1] as ModelMessage & {
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    };
    expect(tail.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  test('per-step system override rides the plan (Think TurnConfig is string-only)', () => {
    const out = composePrepareStep(undefined, { stepNumber: 0, messages: base }, {
      strategy: { kind: 'anthropic' },
      system: { role: 'system', content: 'cached-sys' },
    });
    expect(out?.system).toEqual({ role: 'system', content: 'cached-sys' });
    expect(out?.messages).toHaveLength(2);
  });

  test('no plan → steered messages only; nothing at all → undefined', () => {
    const host = new ExtensionHost().register({
      name: 'steer',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 's' }],
    });
    expect(composePrepareStep(host, { stepNumber: 1, messages: base }, null)?.messages).toHaveLength(3);
    expect(composePrepareStep(undefined, { stepNumber: 1, messages: base }, null)).toBeUndefined();
    expect(composePrepareStep(new ExtensionHost(), { stepNumber: 1, messages: base }, null)).toBeUndefined();
  });
});

describe('ExtensionHost', () => {
  test('tools() merges every extension\'s contributed tools', () => {
    const host = new ExtensionHost()
      .register({ name: 'a', registerTools: () => ({ alpha: tool({ description: 'a', inputSchema: z.object({}) }) }) })
      .register({ name: 'b', registerTools: () => ({ beta: tool({ description: 'b', inputSchema: z.object({}) }) }) });
    expect(Object.keys(host.tools()).sort()).toEqual(['alpha', 'beta']);
    expect(host.size).toBe(2);
  });

  test('tools() throws on a name collision so one plugin cannot shadow another', () => {
    const host = new ExtensionHost()
      .register({ name: 'a', registerTools: () => ({ dup: tool({ description: 'a', inputSchema: z.object({}) }) }) })
      .register({ name: 'b', registerTools: () => ({ dup: tool({ description: 'b', inputSchema: z.object({}) }) }) });
    expect(() => host.tools()).toThrow(/already registered by "a"/);
  });

  test('emit* hooks run every extension in registration order', async () => {
    const order: string[] = [];
    const host = new ExtensionHost()
      .register({ name: 'first', onTurnStart: () => { order.push('first'); } })
      .register({ name: 'second', onTurnStart: () => { order.push('second'); } });
    await host.emitTurnStart({ system: 's', history: [] });
    expect(order).toEqual(['first', 'second']);
  });

  test('runTransformContext is awaited, chained, and fail-open', async () => {
    const seen: string[][] = [];
    const host = new ExtensionHost()
      .register({
        name: 'appender',
        transformContext: async ({ messages }) => {
          seen.push(messages.map((m) => String(m.content)));
          await Promise.resolve(); // genuinely async
          return [...messages, { role: 'user', content: 'from-appender' }];
        },
      })
      .register({
        name: 'thrower',
        transformContext: async () => { throw new Error('plugin exploded'); },
      })
      .register({
        name: 'chained',
        transformContext: async ({ messages }) => {
          seen.push(messages.map((m) => String(m.content)));
          return [...messages, { role: 'user', content: 'from-chained' }];
        },
      });

    const out = await host.runTransformContext({
      sessionKey: 's', messages: [{ role: 'user', content: 'base' }],
      system: 'sys', contextWindow: 1000, trigger: 'auto',
    });
    // The thrower is skipped (fail-open); the chain still completes.
    expect(out?.map((m) => m.content)).toEqual(['base', 'from-appender', 'from-chained']);
    // Extension N sees extension N-1's output (thrower contributed nothing).
    expect(seen).toEqual([['base'], ['base', 'from-appender']]);
  });

  test('runTransformContext returns undefined when nothing changed (or only failures)', async () => {
    const ctx = {
      sessionKey: 's', messages: [{ role: 'user', content: 'base' }] as const,
      system: 'sys', contextWindow: 1000, trigger: 'auto' as const,
    };
    const noop = new ExtensionHost().register({ name: 'p', transformContext: async () => undefined });
    expect(await noop.runTransformContext({ ...ctx, messages: [...ctx.messages] })).toBeUndefined();
    const failing = new ExtensionHost().register({ name: 'f', transformContext: async () => { throw new Error('x'); } });
    expect(await failing.runTransformContext({ ...ctx, messages: [...ctx.messages] })).toBeUndefined();
  });

  test('runPrepareStep chains outputs and reports no-change as undefined', () => {
    const base: ModelMessage[] = [{ role: 'user', content: 'a' }];
    const appendB: ProteusExtension = {
      name: 'b',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 'b' }],
    };
    const passthrough: ProteusExtension = { name: 'p', prepareStep: () => undefined };

    const host = new ExtensionHost().register(passthrough).register(appendB);
    const out = host.runPrepareStep({ stepNumber: 0, messages: base });
    expect(out?.map((m) => m.content)).toEqual(['a', 'b']);

    // No extension rewrites → undefined (leave the step untouched).
    const noop = new ExtensionHost().register(passthrough);
    expect(noop.runPrepareStep({ stepNumber: 0, messages: base })).toBeUndefined();
  });
});

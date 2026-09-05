// Behavior tests for the public extension seam (extension.ts + its wiring into
// runChat). Two levels:
//   1. Through a real runChat turn: registered hooks fire in order around the
//      turn (start → tool-call → tool-result → end) and a registerTools tool is
//      folded into the ToolSet the model actually sees.
//   2. Direct ExtensionHost unit: tool merge + collision, prepareStep chaining,
//      and emit ordering across multiple extensions.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import * as v from 'valibot';
import { z } from 'zod';
import {
  ExtensionHost,
  runChat,
  composePrepareStep,
  type KinuExtension,
  type ChatEvent,
  type Usage,
} from '../src/index';
import { createRecordingLogger, setDiagnosticsSink, KinuError } from '../src/obs/index';

/** A v2 language-model stub that requests the `ping` tool on step 1, then
 *  answers with text on step 2. Captures the tool names it was handed so a test
 *  can assert an extension-contributed tool reached the model. */
function toolThenTextModel() {
  let step = 0;
  let toolNames: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      step += 1;
      if (step === 1) toolNames = (options.tools ?? []).map((t) => t.name);
      const stream = step === 1
        ? new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'tool-call', toolCallId: 'tc1', toolName: 'ping', input: '{}' });
              c.enqueue({
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
              c.close();
            },
          })
        : new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: 't1' });
              c.enqueue({ type: 'text-delta', id: 't1', delta: 'all done' });
              c.enqueue({ type: 'text-end', id: 't1' });
              c.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
              c.close();
            },
          });
      return { stream, response: { headers: {} } };
    },
  });
  return { model, toolNames: () => toolNames };
}

describe('extension seam through runChat', () => {
  test('hooks fire in order around a turn, and registerTools reaches the model', async () => {
    const { model, toolNames } = toolThenTextModel();
    const order: string[] = [];
    let endText = '';
    let startedSteps = 0;

    const ext: KinuExtension = {
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
      model,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: {},
      stopWhen: stepCountIs(3),
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
      model,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: { ping: tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' }) },
      stopWhen: stepCountIs(3),
    })) {
      if (ev.type === 'text-delta') texts.push(ev.delta);
    }
    expect(texts.join('')).toBe('all done');
  });
});

/** A one-step text model that captures the prompt it was handed. */
function promptCapturingModel() {
  let prompt: PromptMessage[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompt = parsePrompt({ value: options.prompt });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't1' });
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 't1' });
            c.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            });
            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
  return { model, prompt: () => prompt };
}

const ContentPartsSchema = v.array(v.object({
  type: v.string(),
  text: v.optional(v.string()),
}));
const PromptSchema = v.array(v.object({
  role: v.string(),
  content: v.union([v.string(), ContentPartsSchema]),
}));
type PromptMessage = v.InferOutput<typeof PromptSchema>[number];

function parsePrompt(input: { value: unknown }): PromptMessage[] {
  return v.parse(PromptSchema, input.value);
}

function userTexts(prompt: PromptMessage[]): string[] {
  return prompt
    .filter((m) => m.role === 'user')
    .map((m) => {
      const text = v.safeParse(v.string(), m.content);
      return text.success
        ? text.output
        : v.parse(ContentPartsSchema, m.content)
          .filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
    });
}

describe('transformContext through runChat', () => {
  test('rewrites the durable history; ephemeral context is spliced AFTER (never seen by the transform)', async () => {
    const { model, prompt } = promptCapturingModel();
    let transformSaw: string[] = [];

    const compactor: KinuExtension = {
      name: 'compactor',
      transformContext: async ({ messages }) => {
        transformSaw = messages.map((m) => String(m.content));
        return [{ role: 'user', content: 'summary-of-history' }];
      },
    };

    for await (const _ of runChat({
      model,
      system: 'sys',
      history: [
        { role: 'user', content: 'old-1' },
        { role: 'assistant', content: 'old-2' },
        { role: 'user', content: 'old-3' },
      ],
      turnLocal: [{ role: 'user', content: 'volatile-tail' }],
      tools: {},
      stopWhen: stepCountIs(1),
      extensions: new ExtensionHost().register(compactor),
    })) { /* drain */ }

    // The transform saw ONLY the durable history — not the ephemeral tail.
    expect(transformSaw).toEqual(['old-1', 'old-2', 'old-3']);
    // The model saw the rewritten history with the ephemeral tail after it.
    expect(userTexts(prompt())).toEqual(['summary-of-history', 'volatile-tail']);
  });

  test('providerReportedTokens threads into the transform context, and step-finish reports the priced prompt', async () => {
    const { model } = promptCapturingModel();
    let sawTokens: number | undefined;
    const stepUsage: Array<Usage | undefined> = [];
    for await (const ev of runChat({
      model,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: {},
      stopWhen: stepCountIs(1),
      providerReportedTokens: 123_456,
      extensions: new ExtensionHost().register({
        name: 'observer',
        transformContext: async (ctx) => {
          sawTokens = ctx.providerReportedTokens;
          return undefined;
        },
      }),
    })) {
      if (ev.type === 'step-finish') stepUsage.push(ev.usage);
    }
    expect(sawTokens).toBe(123_456);
    // promptCapturingModel reports a 1-token prompt and a 1-token completion and
    // no cache or reasoning split, so those fields stay absent rather than 0.
    expect(stepUsage).toEqual([{ input: 1, output: 1 }]);
    expect(Object.keys(stepUsage[0] ?? {}).sort()).toEqual(['input', 'output']);
  });

  test("transformTrigger threads into the transform context ('force' on overflow recovery, 'auto' default)", async () => {
    const triggers: string[] = [];
    const observer: KinuExtension = {
      name: 'observer',
      transformContext: async (ctx) => { triggers.push(ctx.trigger); return undefined; },
    };
    for (const transformTrigger of [undefined, 'force' as const]) {
      const { model } = promptCapturingModel();
      for await (const _ of runChat({
        model,
        system: 'sys',
        history: [{ role: 'user', content: 'go' }],
        tools: {},
        stopWhen: stepCountIs(1),
        transformTrigger,
        extensions: new ExtensionHost().register(observer),
      })) { /* drain */ }
    }
    expect(triggers).toEqual(['auto', 'force']);
  });

  test('a throwing transform never breaks the turn (fail-open)', async () => {
    const { model, prompt } = promptCapturingModel();
    let doneText = '';
    for await (const ev of runChat({
      model,
      system: 'sys',
      history: [{ role: 'user', content: 'go' }],
      tools: {},
      stopWhen: stepCountIs(1),
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

  test('extension rewrites first, cache tail markers land LAST on the final array', async () => {
    const host = new ExtensionHost().register({
      name: 'steer',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 'steered' }],
    });
    const out = await composePrepareStep({ extensions: host, cache: { strategy: { kind: 'anthropic' } } }, { stepNumber: 0, messages: base });
    expect(out?.messages.map((m) => m.content)).toEqual(['a', 'b', 'steered']);
    // The marker rides the injected tail message — proof the markers were
    // applied AFTER the extension rewrite.
    const tail = v.parse(v.object({
      providerOptions: v.object({
        anthropic: v.object({ cacheControl: v.object({ type: v.literal('ephemeral') }) }),
      }),
    }), out?.messages.at(-1));
    expect(tail.providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' });
  });

  test('per-step system override rides the plan (Think TurnConfig is string-only)', async () => {
    const out = await composePrepareStep({
      cache: { strategy: { kind: 'anthropic' }, system: { role: 'system', content: 'cached-sys' } },
    }, { stepNumber: 0, messages: base });
    expect(out?.system).toEqual({ role: 'system', content: 'cached-sys' });
    expect(out?.messages).toHaveLength(2);
  });

  test('no plan → steered messages only; nothing at all → undefined', async () => {
    const host = new ExtensionHost().register({
      name: 'steer',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 's' }],
    });
    expect((await composePrepareStep({ extensions: host }, { stepNumber: 1, messages: base }))?.messages).toHaveLength(3);
    expect(await composePrepareStep({}, { stepNumber: 1, messages: base })).toBeUndefined();
    expect(await composePrepareStep({ extensions: new ExtensionHost() }, { stepNumber: 1, messages: base })).toBeUndefined();
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
  test('a throwing emit hook never breaks the turn: it resolves and records the failure', async () => {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);
    try {
      const order: string[] = [];
      const host = new ExtensionHost()
        .register({
          name: 'thrower',
          onTurnStart: () => { throw new Error('start exploded'); },
          onToolCall: async () => { throw new Error('call exploded'); },
          onToolResult: async () => { throw new Error('result exploded'); },
          onTurnEnd: async () => { throw new Error('end exploded'); },
        })
        .register({ name: 'witness', onTurnStart: () => { order.push('witness-start'); } })
        .register({ name: 'witness', onToolCall: () => { order.push('witness-call'); } })
        .register({ name: 'witness', onToolResult: () => { order.push('witness-result'); } })
        .register({ name: 'witness', onTurnEnd: () => { order.push('witness-end'); } });
      await host.emitTurnStart({ system: 's', history: [] });
      await host.emitToolCall({ toolName: 'ping', args: {} });
      await host.emitToolResult({ toolName: 'ping', args: {}, result: 'pong', success: true });
      await host.emitTurnEnd({ text: 'done', responseMessages: [] });
      // The loop continued past the thrower: every later extension still ran.
      expect(order).toEqual(['witness-start', 'witness-call', 'witness-result', 'witness-end']);
      const failures = log.emitted.filter((row) => row.event === 'extension.hook_failed');
      expect(failures.map((row) => row.fields)).toEqual([
        { extension: 'thrower', hook: 'onTurnStart' },
        { extension: 'thrower', hook: 'onToolCall' },
        { extension: 'thrower', hook: 'onToolResult' },
        { extension: 'thrower', hook: 'onTurnEnd' },
      ]);
    } finally {
      restore();
    }
  });
  test('an aborted or out-of-memory hook propagates instead of reading as silent', async () => {
    const aborted = new ExtensionHost().register({
      name: 'aborted',
      onTurnStart: () => { throw new KinuError('cancelled', 'injected abort'); },
    });
    // The caller's own abort is not the plugin's failure: it must propagate
    // with its class intact, never read as a silent skip. (The message names
    // the seam's `doing`; the class rides on `code`, the detail on `cause`.)
    let abortPropagated = false;
    try {
      await aborted.emitTurnStart({ system: 's', history: [] });
    } catch (error) {
      if (!(error instanceof KinuError)) throw error;
      expect(error.code).toBe('cancelled');
      expect(error.message).toBe('run an extension onTurnStart hook');
      abortPropagated = true;
    }
    expect(abortPropagated).toBe(true);
    const starved = new ExtensionHost().register({
      name: 'starved',
      onTurnStart: () => { throw new KinuError('oom', 'injected oom'); },
    });
    let oomPropagated = false;
    try {
      await starved.emitTurnStart({ system: 's', history: [] });
    } catch (error) {
      if (!(error instanceof KinuError)) throw error;
      expect(error.code).toBe('oom');
      oomPropagated = true;
    }
    expect(oomPropagated).toBe(true);
    // A plain Error stays fail-open: an unclassified plugin failure is the
    // plugin's fault, and the turn continues past it.
    const clumsy = new ExtensionHost().register({
      name: 'clumsy',
      onTurnStart: () => { throw new Error('clumsy exploded'); },
    });
    await expect(clumsy.emitTurnStart({ system: 's', history: [] })).resolves.toBeUndefined();
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

  test('runPrepareStep chains outputs and reports no-change as undefined', async () => {
    const base: ModelMessage[] = [{ role: 'user', content: 'a' }];
    const appendB: KinuExtension = {
      name: 'b',
      prepareStep: ({ messages }) => [...messages, { role: 'user', content: 'b' }],
    };
    const passthrough: KinuExtension = { name: 'p', prepareStep: () => undefined };

    const host = new ExtensionHost().register(passthrough).register(appendB);
    const out = await host.runPrepareStep({ stepNumber: 0, messages: base });
    expect(out?.map((m) => m.content)).toEqual(['a', 'b']);

    // No extension rewrites → undefined (leave the step untouched).
    const noop = new ExtensionHost().register(passthrough);
    expect(await noop.runPrepareStep({ stepNumber: 0, messages: base })).toBeUndefined();
  });

  test('runPrepareStep awaits an async rewrite before the next extension sees it', async () => {
    const admitted = Promise.withResolvers<void>();
    const seen: string[][] = [];
    const host = new ExtensionHost()
      .register({
        name: 'durable',
        prepareStep: async ({ messages }) => {
          await admitted.promise;
          return [...messages, { role: 'user', content: 'persisted' }];
        },
      })
      .register({
        name: 'observer',
        prepareStep: ({ messages }) => {
          seen.push(messages.map((message) => String(message.content)));
          return undefined;
        },
      });

    const running = host.runPrepareStep({
      stepNumber: 0,
      messages: [{ role: 'user', content: 'base' }],
    });
    await Promise.resolve();
    expect(seen).toEqual([]);

    admitted.resolve();
    expect((await running)?.map((message) => message.content)).toEqual(['base', 'persisted']);
    expect(seen).toEqual([['base', 'persisted']]);
  });
});

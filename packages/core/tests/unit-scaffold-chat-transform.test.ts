/**
 * The evolved scaffold on the LOCAL turn seam — scaffold/chat-transform.ts.
 *
 * The peer of unit-scaffold-inference-transform.test.ts. Same contract, the
 * other stream vocabulary (`runChat`'s ChatEvent):
 *   - un-evolved agent (version <= 0): the default turn passes through
 *     UNTOUCHED (same object — zero overhead, no wrapper).
 *   - promoted scaffold: it DRIVES the turn — a custom scaffold's output
 *     replaces the default turn's, and the default turn is never started
 *     (runChat is lazy, so no model request is made).
 *   - delegating scaffold: the default turn's events pass through verbatim,
 *     and its responseMessages survive onto this seam's single `done`.
 */
import { describe, test, expect } from 'bun:test';
import { scaffoldChatTransform, type ChatEvent } from '../src/index.js';
import type { ScaffoldRunOptions } from '../src/scaffold/executor.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { Executor, ResolvedProvider } from '../src/types/primitives.js';
import { decodeJsonValue, type JsonObject, type JsonValue } from '../src/utils/json.js';
import { createTestRuntime } from './helpers.js';

/** Sandbox semantics: provider namespaces visible as globals. */
function evalExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code, providers) {
      const arr: ResolvedProvider[] = Array.isArray(providers)
        ? providers
        : [{ name: 'workspace', fns: providers }];
      try {
        const fn = new Function(...arr.map((p) => p.name), `return (async () => {\n${code}\n})();`);
        const result = await fn(...arr.map((p) => p.fns));
        return {
          result: result === undefined ? undefined : decodeJsonValue({ value: result }),
        };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const DELEGATING_SCAFFOLD = `async function run(rt, task) {
  await host.defaultInference();
}`;

const CUSTOM_SCAFFOLD = `async function run({ task }) {
  await host.emit({ type: 'text_delta', text: 'scaffold answer for: ' + task });
}`;

const TOOL_SCAFFOLD = `async function run({ task }) {
  await host.callTool('search', { q: task });
  await host.emit({ type: 'text_delta', text: 'done searching' });
}`;

function runtime(): AgentRuntime {
  const { rt } = createTestRuntime();
  rt.executor = evalExecutor();
  return rt;
}

function runOpts(
  rt: AgentRuntime,
  scaffoldCode: string,
  callTool?: (n: string, a: JsonObject) => Promise<JsonValue | undefined>,
): Omit<ScaffoldRunOptions, 'emit' | 'defaultInference'> {
  const options: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference'> = {
    rt,
    task: 'the task',
    llmStream: async function* () { yield ''; },
    scaffoldCodeOverride: scaffoldCode,
    timeoutMs: 10_000,
  };
  if (callTool) options.callTool = callTool;
  return options;
}

/** A default turn, plus a flag recording whether anything ever started it. */
function defaultTurn(events: ChatEvent[]) {
  let started = false;
  return {
    chat: (async function* () {
      started = true;
      for (const ev of events) yield ev;
    })(),
    started: () => started,
  };
}

const DEFAULT_EVENTS: ChatEvent[] = [
  { type: 'text-delta', delta: 'default ' },
  { type: 'text-delta', delta: 'answer' },
  { type: 'step-finish', stepIndex: 0, inputTokens: 12 },
  { type: 'done', text: 'default answer', responseMessages: [{ role: 'assistant', content: 'default answer' }] },
];

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('scaffoldChatTransform', () => {
  test('version <= 0 → the default turn passes through untouched (same object)', () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    expect(scaffoldChatTransform({ currentVersion: 0, chat, run: runOpts(runtime(), CUSTOM_SCAFFOLD) }))
      .toBe(chat);
  });

  test('a promoted scaffold DRIVES the turn: its output replaces the default', async () => {
    const { chat, started } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({
      currentVersion: 3, chat, run: runOpts(runtime(), CUSTOM_SCAFFOLD),
    }));

    const text = events.flatMap((event) => event.type === 'text-delta' ? [event.delta] : []).join('');
    expect(text).toBe('scaffold answer for: the task');
    expect(text).not.toContain('default answer');
    // runChat is lazy — a scaffold that never delegates never fires a request.
    expect(started()).toBe(false);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('unreachable');
    expect(done.text).toBe('scaffold answer for: the task');
    // The reply the user saw must survive into the durable history.
    expect(done.responseMessages).toEqual([
      { role: 'assistant', content: 'scaffold answer for: the task' },
    ]);
  });

  test('delegating scaffold is faithful: the default events pass through verbatim', async () => {
    const { chat, started } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({
      currentVersion: 2, chat, run: runOpts(runtime(), DELEGATING_SCAFFOLD),
    }));

    expect(started()).toBe(true);
    // Every non-done default event, verbatim and in order; exactly one done.
    expect(events.slice(0, 3)).toEqual(DEFAULT_EVENTS.slice(0, 3));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected a trailing done');
    expect(done.text).toBe('default answer');
    // The delegated turn's response messages are what the caller persists.
    expect(done.responseMessages).toEqual([{ role: 'assistant', content: 'default answer' }]);
  });

  test('delegating scaffold accepts optional SDK fields that are explicitly undefined', async () => {
    const responseMessage = {
      role: 'assistant' as const,
      content: 'default answer',
      providerOptions: undefined,
    };
    const { chat } = defaultTurn([
      {
        type: 'step-finish',
        stepIndex: 1,
        inputTokens: undefined,
        outputTokens: undefined,
        cachedInputTokens: undefined,
      },
      { type: 'done', text: 'default answer', responseMessages: [responseMessage] },
    ]);

    const events = await collect(scaffoldChatTransform({
      currentVersion: 2,
      chat,
      run: runOpts(runtime(), DELEGATING_SCAFFOLD),
    }));

    expect(events).toEqual([
      { type: 'step-finish', stepIndex: 1 },
      {
        type: 'done',
        text: 'default answer',
        responseMessages: [{ role: 'assistant', content: 'default answer' }],
      },
    ]);
  });

  test('scaffold tool calls surface as tool-call / tool-result pairs', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({
      currentVersion: 1,
      chat,
      run: runOpts(runtime(), TOOL_SCAFFOLD, async () => ({ hits: 2 })),
    }));

    const call = events.find(
      (event): event is Extract<ChatEvent, { type: 'tool-call' }> => event.type === 'tool-call',
    );
    const result = events.find(
      (event): event is Extract<ChatEvent, { type: 'tool-result' }> => event.type === 'tool-result',
    );
    expect(call).toEqual({
      type: 'tool-call', toolName: 'search', toolCallId: expect.any(String), args: { q: 'the task' },
    });
    expect(result).toEqual({
      type: 'tool-result', toolName: 'search', toolCallId: expect.any(String),
      result: '{"hits":2}', success: true,
    });
    // The pair carries the dispatch's own call id, so a surface reporting the
    // call out of band can settle the right one.
    expect(result?.toolCallId).toBe(call?.toolCallId);
  });

  test('a failing tool dispatch is reported as an unsuccessful tool-result', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({
      currentVersion: 1,
      chat,
      run: runOpts(runtime(), TOOL_SCAFFOLD, async () => { throw new Error('boom'); }),
    }));

    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toMatchObject({ type: 'tool-result', toolName: 'search', success: false, error: 'boom' });
  });

  test('an unrunnable scaffold surfaces one error event and still closes the turn', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({
      currentVersion: 1, chat, run: runOpts(runtime(), 'this is not javascript {'),
    }));

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
});

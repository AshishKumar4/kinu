/** Local-seam peer of unit-scaffold-inference-transform.test.ts, over `runChat`'s ChatEvent vocabulary. */
import { describe, test, expect } from 'bun:test';
import { scaffoldChatTransform, prepareActorProgram, type ChatEvent } from '../src/index';
import type { ScaffoldRunOptions } from '../src/scaffold/executor';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Executor, ResolvedProvider } from '../src/types/primitives';
import { decodeJsonValue, type JsonObject, type JsonValue } from '../src/utils/json';
import { createTestRuntime } from './helpers';

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

async function selected(version: number, scaffoldCode: string,
  callTool?: (name: string, args: JsonObject) => Promise<JsonValue | undefined>) {
  const rt = runtime();
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v' + version, scaffoldCode);
  const program = await prepareActorProgram({ runtime: rt, mode: 'build', version });

  const run: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference' | 'scaffoldCodeOverride'> = {
    rt, task: 'the task',
    llmStream: () => { throw new Error('this fixture must not start a model'); },
  };

  if (callTool) run.callTool = callTool;

  return { program, run };
}

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
  { type: 'step-finish', stepIndex: 0, responseMessages: [{ role: 'assistant', content: 'default answer' }], usage: { input: 12 } },
  { type: 'done', text: 'default answer', responseMessages: [{ role: 'assistant', content: 'default answer' }] },
];

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];

  for await (const ev of stream) out.push(ev);

  return out;
}

describe('scaffoldChatTransform', () => {
  test('version <= 0 → the default turn passes through untouched (same object)', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    expect(scaffoldChatTransform({ chat, ...await selected(0, CUSTOM_SCAFFOLD) }))
      .toBe(chat);
  });

  test('a promoted scaffold DRIVES the turn: its output replaces the default', async () => {
    const { chat, started } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(3, CUSTOM_SCAFFOLD) }));

    const text = events.flatMap((event) => event.type === 'text-delta' ? [event.delta] : []).join('');
    expect(text).toBe('scaffold answer for: the task');
    expect(text).not.toContain('default answer');
    // runChat is lazy, so a scaffold that never delegates never fires a request.
    expect(started()).toBe(false);

    const done = events.at(-1);
    expect(done?.type).toBe('done');

    if (done?.type !== 'done') throw new Error('unreachable');
    expect(done.text).toBe('scaffold answer for: the task');
    expect(done.responseMessages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'scaffold answer for: the task' }] },
    ]);
  });

  test('delegating scaffold is faithful: the default events pass through verbatim', async () => {
    const { chat, started } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(2, DELEGATING_SCAFFOLD) }));

    expect(started()).toBe(true);
    expect(events.slice(0, 3)).toEqual(DEFAULT_EVENTS.slice(0, 3));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const done = events.at(-1);

    if (done?.type !== 'done') throw new Error('expected a trailing done');
    expect(done.text).toBe('default answer');
    expect(done.responseMessages).toEqual([{ role: 'assistant', content: 'default answer' }]);
  });

  test('a delegated narrated turn answers with the answer its done carries, not every delta', async () => {
    // The runner's `done` already applies the one-answer rule; preferring relayed deltas would re-concatenate narration.
    const narrated: ChatEvent[] = [
      { type: 'text-delta', delta: 'Looking at the workspace first.' },
      { type: 'tool-call', toolName: 'search', toolCallId: 'call-1', args: { q: 'x' } },
      { type: 'tool-result', toolName: 'search', toolCallId: 'call-1', result: '{"hits":2}', output: { hits: 2 }, success: true },
      { type: 'step-finish', stepIndex: 0, responseMessages: [] },
      { type: 'text-delta', delta: 'FAIL' },
      { type: 'step-finish', stepIndex: 1, responseMessages: [] },
      { type: 'done', text: 'FAIL', responseMessages: [{ role: 'assistant', content: 'FAIL' }] },
    ];

    const { chat } = defaultTurn(narrated);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(2, DELEGATING_SCAFFOLD) }));
    const done = events.at(-1);

    if (done?.type !== 'done') throw new Error('expected a trailing done');
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.type === 'text-delta' ? e.delta : ''))
      .toEqual(['Looking at the workspace first.', 'FAIL']);
    expect(done.text).toBe('FAIL');
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
        responseMessages: [responseMessage],
        usage: undefined,
      },
      { type: 'done', text: 'default answer', responseMessages: [responseMessage] },
    ]);

    const events = await collect(scaffoldChatTransform({ chat, ...await selected(2, DELEGATING_SCAFFOLD) }));

    expect(events).toEqual([
      { type: 'step-finish', stepIndex: 1, responseMessages: [{ role: 'assistant', content: 'default answer' }] },
      {
        type: 'done',
        text: 'default answer',
        responseMessages: [{ role: 'assistant', content: 'default answer' }],
      },
    ]);
  });

  test('scaffold tool calls surface as tool-call / tool-result pairs', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(1, TOOL_SCAFFOLD, async () => ({ hits: 2 })) }));

    const call = events.find(
      (event): event is Extract<ChatEvent, { type: 'tool-call' }> => event.type === 'tool-call',
    );

    const result = events.find(
      (event): event is Extract<ChatEvent, { type: 'tool-result' }> => event.type === 'tool-result',
    );

    expect(call).toEqual({
      type: 'tool-call', toolName: 'search', toolCallId: expect.any(String), args: { q: 'the task' },
    });
    // The ledger row records the returned value, not its rendering, as the builtin loop does.
    expect(result).toEqual({
      type: 'tool-result', toolName: 'search', toolCallId: expect.any(String),
      result: '{"hits":2}', output: { hits: 2 }, success: true,
    });
    expect(result?.toolCallId).toBe(call?.toolCallId);
  });

  test('a tool result relayed as an authored chunk keeps its value and its duration', async () => {
    const relaying = `async function run() {
      await host.emit({ type: 'ui_chunk', chunk: { type: 'tool-result', toolName: 'search', toolCallId: 'c1',
        result: '{"hits":2}', output: { hits: 2 }, durationMs: 7, success: true } });
      await host.emit({ type: 'text_delta', text: 'done' });
    }`;

    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(1, relaying) }));
    const result = events.find((e) => e.type === 'tool-result');

    expect(result).toEqual({
      type: 'tool-result', toolName: 'search', toolCallId: 'c1', result: '{"hits":2}', output: { hits: 2 }, durationMs: 7, success: true,
    });
  });

  test('a failing tool dispatch is reported as an unsuccessful tool-result', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(1, TOOL_SCAFFOLD, async () => { throw new Error('boom'); }) }));

    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toMatchObject({ type: 'tool-result', toolName: 'search', success: false, error: 'boom' });
  });

  test('an unrunnable scaffold surfaces one error event and still closes the turn', async () => {
    const { chat } = defaultTurn(DEFAULT_EVENTS);
    const events = await collect(scaffoldChatTransform({ chat, ...await selected(1, 'this is not javascript {') }));

    // The run reports its own failure; the transform must not add a second one.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});

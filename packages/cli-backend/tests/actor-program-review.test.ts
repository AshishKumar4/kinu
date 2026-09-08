import { expect, test } from 'bun:test';
import { jsonSchema, tool, uiMessageChunkSchema } from 'ai';
import type { ModelMessage, UIMessageChunk } from 'ai';
import { createTestRuntime, scriptedTurnModel } from '@kinu.run/test-utils';
import {
  prepareActorTurn, prepareActorProgram, scaffoldChatTransform, scaffoldInferenceTransform,
  createScaffoldLLMStream, runHeadInference, HeadCapture, withHeadCaptureRecording,
} from '@kinu.run/core';
import type { ChatEvent, HeadInput, InferenceStreamResult } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { createSandboxedExecutor } from '../src/executor';
import { initScaffoldTables } from '../../core/src/scaffold/schemas';

async function collectUI(result: InferenceStreamResult, sendReasoning = true): Promise<UIMessageChunk[]> {
  const schema = uiMessageChunkSchema();
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of result.toUIMessageStream({ sendReasoning })) {
    const parsed = await schema.validate?.(chunk);
    if (!parsed?.success) throw new Error('the program emitted an invalid SDK UI chunk');
    chunks.push(parsed.value);
  }
  return chunks;
}

const inputSchema = jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false });
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function headInput(): HeadInput {
  return { id: 'review-head', rootId: 'review-root', parentId: null, depth: 0,
    task: 'go', rationale: 'exercise real program boundaries', mode: 'build', inheritedContext: [],
    budget: { maxDepth: 0, spawnedAt: Date.now() }, mergeStrategy: 'synthesize' };
}
async function runtime(source: string, version = 1) {
  const { rt } = createTestRuntime();
  rt.executor = createSandboxedExecutor();
  rt.identity.scaffold.version = async () => version;
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v' + version, source);
  return { rt, files };
}
function unusedModel() {
  return scriptedTurnModel({ doGenerate: () => { throw new Error('this program must not start the default model'); } });
}
async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const result: ChatEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test('abort after preparation refuses program entry before memory or text effects', async () => {
  const { rt } = await runtime('async function run() { await host.appendMemory("probe", "effect"); await host.emit({ type: "text_delta", text: "after abort" }); }');
  let effects = 0;
  rt.memory.append = async () => { effects++; };
  const abort = new AbortController();
  const prepared = await prepareActorTurn({ runtime: rt, mode: 'build', loopVersion: 1, task: 'go',
    chat: { model: unusedModel(), system: 'sys', history: [], tools: {}, signal: abort.signal } });
  const reason = new Error('cancelled before first next');
  abort.abort(reason);
  await expect(collect(prepared.events)).rejects.toBe(reason);
  expect(effects).toBe(0);
});

test('cancellation retains an admitted memory effect but refuses subsequent effects', async () => {
  const { rt } = await runtime('async function run() { await host.appendMemory("probe", "first"); await host.appendMemory("probe", "second"); await host.emit({ type: "text_delta", text: "late" }); }');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  rt.memory.append = async (_path, content) => { effects.push(content); started.resolve(); await release.promise; };
  const abort = new AbortController();
  const prepared = await prepareActorTurn({ runtime: rt, mode: 'build', loopVersion: 1, task: 'go',
    chat: { model: unusedModel(), system: 'sys', history: [], tools: {}, signal: abort.signal } });
  const running = collect(prepared.events);
  await started.promise;
  abort.abort(new Error('stop further effects'));
  release.resolve();
  const events = await running;
  expect(effects).toEqual(['first']);
  expect(events.filter(event => event.type === 'text-delta')).toEqual([]);
});

test('hosted polled cancellation refuses a promoted direct effect without a signal', async () => {
  const { rt } = await runtime('async function run() { await host.callTool("mutate", {}); }');
  let effects = 0;
  const model = unusedModel();
  const report = await runHeadInference(headInput(), {
    runtime: rt, model, capture: new HeadCapture(), workspaceLayout: 'private-scratch',
    isAborted: () => true, abortReason: () => 'already cancelled',
    tools: { mutate: tool({ inputSchema, execute: async () => ++effects }) },
  });
  expect(report.status).toBe('aborted');
  expect(effects).toBe(0);
  expect(model.doStreamCalls).toHaveLength(0);
});

test('a native refusal keeps the same failed outcome at capture and scaffold boundaries', async () => {
  const { rt } = await runtime('async function run() { await host.callTool("fail", {}); await host.emit({ type: "text_delta", text: "finished" }); }');
  const capture = new HeadCapture();
  const tools = withHeadCaptureRecording({ fail: tool({ inputSchema, execute: async (): Promise<string> => {
    throw new KinuError('denied', 'fixture permission refused');
  } }) }, capture);
  const prepared = await prepareActorTurn({ runtime: rt, mode: 'build', loopVersion: 1, task: 'go',
    chat: { model: unusedModel(), system: 'sys', history: [], tools } });
  const events = await collect(prepared.events);
  expect(events.find(event => event.type === 'tool-result')).toMatchObject({ success: false, reason: 'denied' });
  expect(capture.toolCalls).toMatchObject([{ outcome: { success: false, reason: 'denied' } }]);
});

const CUSTOM_STREAM_SOURCE = 'async function run() { await host.llmStream({ system: "sys", messages: [{ role: "user", content: "go" }] }); }';
const programs = [
  { name: 'builtin', version: 0, source: '' },
  { name: 'defaultInference', version: 1, source: 'async function run() { await host.defaultInference(); }' },
  { name: 'llmStream', version: 2, source: CUSTOM_STREAM_SOURCE },
];
for (const program of programs) test(`${program.name} preserves reasoning and actual tool conversation for the next owner`, async () => {
  const { rt } = await runtime(program.source, program.version);
  let step = 0;
  const model = scriptedTurnModel({ doGenerate: () => {
    const first = step++ === 0;
    return { content: first
      ? [{ type: 'reasoning', text: 'thinking marker' }, { type: 'tool-call', toolCallId: 'probe-call', toolName: 'probe', input: '{}' }]
      : [{ type: 'text', text: 'finished' }],
    finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });
  const capture = new HeadCapture();
  const tools = withHeadCaptureRecording({ probe: tool({ inputSchema, execute: async () => 'private result nonce1842' }) }, capture);
  const messages: ModelMessage[] = [];
  const deltas: Array<{ kind: string; text: string }> = [];
  const report = await runHeadInference(headInput(), {
    runtime: rt, model, tools, capture, workspaceLayout: 'private-scratch', isAborted: () => false,
    reportMessages: produced => { messages.push(...produced); },
    reportDelta: (kind, text) => { deltas.push({ kind, text }); },
  });
  expect(report.status).toBe('completed');
  expect(report.stepCount).toBe(2);
  expect(report.usage).toMatchObject({ input: 2, output: 2 });
  expect(capture.toolCalls).toHaveLength(1);
  expect(deltas).toContainEqual({ kind: 'reasoning', text: 'thinking marker' });
  expect(messages.flatMap(message => message.role === 'tool' ? message.content : []))
    .toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'probe-call', output: { type: 'text', value: 'private result nonce1842' } }));
});

test('both existing transforms execute their pinned version even if live and version files later change', async () => {
  const old = 'async function run() { await host.emit({ type: "text_delta", text: "version one" }); }';
  const changed = 'async function run() { await host.emit({ type: "text_delta", text: "version two" }); }';
  const { rt, files } = await runtime(old);
  const program = await prepareActorProgram({ runtime: rt, mode: 'build', version: 1 });
  const run = { rt, task: 'go', llmStream: () => { throw new Error('unexpected model'); } };
  const chat = scaffoldChatTransform({ program, chat: (async function* () {})(), run });
  const hosted = scaffoldInferenceTransform({ program, run,
    result: { toUIMessageStream: () => (async function* () {})() } });
  rt.identity.scaffold.read = async () => changed;
  await files.writeFile(rt.identity.scaffold.path + '.v1', changed);
  expect((await collect(chat)).flatMap(event => event.type === 'text-delta' ? [event.delta] : []).join('')).toBe('version one');
  const chunks = await collectUI(hosted);
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'version one' }));
});

test('the hosted UI stream receives actual successful SDK output data, not rendered JSON text', async () => {
  const { rt } = await runtime(CUSTOM_STREAM_SOURCE);
  let step = 0;
  const value = { error: 'business data', nonce: 'raw-output' };
  const model = scriptedTurnModel({ doGenerate: () => {
    const first = step++ === 0;
    return { content: first ? [{ type: 'reasoning', text: 'hidden by UI option' }, { type: 'tool-call', toolCallId: 'raw-call', toolName: 'probe', input: '{}' }]
      : [{ type: 'text', text: 'finished' }],
    finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });
  const tools = { probe: tool({ inputSchema, execute: async () => value,
    toModelOutput: () => ({ type: 'text', value: 'model-only representation' }),
  }) };
  const result = scaffoldInferenceTransform({
    program: await prepareActorProgram({ runtime: rt, mode: 'build', version: 1 }),
    result: { toUIMessageStream: () => (async function* () {})() },
    run: { rt, task: 'go', llmStream: createScaffoldLLMStream({ model, tools: () => tools }) },
  });
  const chunks = await collectUI(result, false);
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', output: value }));
  expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'reasoning-delta' }));
});

test('a custom model call preserves completed tool messages when its next request is cancelled', async () => {
  const { rt } = await runtime(CUSTOM_STREAM_SOURCE);
  const pending = Promise.withResolvers<never>();
  const started = Promise.withResolvers<void>();
  const abort = new AbortController();
  const messages: ModelMessage[] = [];
  const value = { nonce: 'retained-on-stop' };
  let step = 0;
  const model = scriptedTurnModel({ doGenerate: options => {
    if (step++ === 0) return {
      content: [{ type: 'tool-call', toolCallId: 'partial-call', toolName: 'probe', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
    };
    const signal = options.abortSignal;
    if (signal !== undefined) signal.addEventListener('abort', () => { pending.reject(signal.reason); }, { once: true });
    started.resolve();
    return pending.promise;
  } });
  const running = runHeadInference(headInput(), {
    runtime: rt, model, capture: new HeadCapture(), workspaceLayout: 'private-scratch',
    signal: abort.signal, isAborted: () => abort.signal.aborted,
    tools: { probe: tool({ inputSchema, execute: async () => value }) },
    reportMessages: produced => { messages.push(...produced); },
  });
  await started.promise;
  abort.abort(new Error('stop after the completed tool step'));
  try {
    expect((await running).status).toBe('aborted');
    expect(messages.flatMap(message => message.role === 'tool' ? message.content : []))
      .toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'partial-call', output: { type: 'json', value } }));
  } finally {
    pending.reject(new Error('release the test provider'));
    await running;
  }
});

test('a missing selected version never falls back to the current live alias', async () => {
  const { rt } = await runtime('async function run() {}');
  initScaffoldTables(rt.storage.execRaw);
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status) VALUES (2, 1, 'missing selected source', 'current')`;
  let liveReads = 0;
  rt.identity.scaffold.read = async () => { liveReads++; return 'async function run() {}'; };
  await expect(prepareActorProgram({ runtime: rt, mode: 'build', version: 2 })).rejects.toMatchObject({ code: 'missing' });
  expect(liveReads).toBe(0);
});

test('invalid native argument containers cannot become an empty successful call', async () => {
  const { rt } = await runtime('async function run() { await host.callTool("mutate", []); }');
  let effects = 0;
  const prepared = await prepareActorTurn({ runtime: rt, mode: 'build', loopVersion: 1, task: 'go',
    chat: { model: unusedModel(), system: 'sys', history: [],
      tools: { mutate: tool({ inputSchema, execute: async () => ++effects }) },
    },
  });
  const events = await collect(prepared.events);
  expect(effects).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('arguments must be a JSON object') }));
});

test('router namespace effects use the same lifetime admission as host effects', async () => {
  const { rt } = await runtime('async function run() { await workspace.writeFile(); await workspace.writeFile(); }');
  if (rt.executionRouter === undefined) throw new Error('the runtime fixture has no execution router');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let effects = 0;
  rt.executionRouter.getProviders = () => [{ name: 'workspace', tools: { writeFile: {
    description: 'record an admitted effect', execute: async () => {
      effects++;
      started.resolve();
      await release.promise;
      return 'completed';
    },
  } } }];
  const abort = new AbortController();
  const prepared = await prepareActorTurn({ runtime: rt, mode: 'build', loopVersion: 1, task: 'go',
    chat: { model: unusedModel(), system: 'sys', history: [], tools: {}, signal: abort.signal } });
  const running = collect(prepared.events);
  await started.promise;
  abort.abort(new Error('stop namespace work'));
  release.resolve();
  const events = await running;
  expect(effects).toBe(1);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('stop namespace work') }));
});

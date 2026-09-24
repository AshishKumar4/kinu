/**
 * The transient half of head liveness: `head_stream` frames, one per provider delta, forwarded in
 * order with their kind and superseded by the durable step.
 */
import { REAL_CLOCK } from '../src/types/clock';
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, scriptedTurnModel, type ModelStreamPart } from '@kinu.run/test-utils';
import type { LanguageModel, ModelMessage } from 'ai';
import { jsonSchema, tool } from 'ai';
import { runHeadInference, HeadCapture, type HeadInferenceDeps } from '../src/heads/head-inference';
import type { HeadStreamKind } from '../src/heads/head-stream';
import { makeSql, makeExecRaw, createTestActor } from './helpers';
import { LiveHeadJournal } from '../src/heads/live-journal';
import { initHeadsTables } from '../src/heads/schema';
import type { HeadInput, HeadStep } from '../src/heads/types';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';
import { hostedSeatsOver } from './helpers-actor-host';

interface Frame { readonly kind: HeadStreamKind; readonly delta: string }

/** One step emitting the given reasoning and prose as one delta each, through the real `runChat` fullStream. */
function streamingHead(parts: { reasoning?: string; text: string }): LanguageModel {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-head',
    doGenerate: async () => ({
      content: [
        ...(parts.reasoning === undefined
          ? []
          : [{ type: 'reasoning' as const, text: parts.reasoning }]),
        { type: 'text' as const, text: parts.text },
      ],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** Prose as many small deltas (hand-built: `scriptedTurnModel` collapses each item into one delta). */
function chunkedHead(chunks: readonly string[]): LanguageModel {
  const model = scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-head-chunked',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: chunks.join('') }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  model.doStream = async () => {
    const parts: ModelStreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't0' },
      ...chunks.map((delta): ModelStreamPart => ({ type: 'text-delta', id: 't0', delta })),
      { type: 'text-end', id: 't0' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
      },
    ];

    return {
      stream: new ReadableStream<ModelStreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  };

  return model;
}

function headInput(): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'analyze the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [],
    budget: { maxDepth: 2, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

/** A head's deps over a real hosted actor, so the frames come from a claimed turn on its `ActorSession`. */
async function deps(model: LanguageModel, over?: Partial<HeadInferenceDeps>): Promise<HeadInferenceDeps> {
  const { rt, testSql } = createTestRuntime();
  const seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('head-stream', 'head');

  return {
    ...seat,
    model, tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false,
    workspaceLayout: 'shared-workspace', ...over,
  };
}

describe('a running head publishes what it is producing', () => {
  test('both halves of a step reach the channel, each tagged with its own kind', async () => {
    const frames: Frame[] = [];

    const report = await runHeadInference(headInput(), await deps(
      streamingHead({ reasoning: 'weighing the two lexers', text: 'the lexer handles UTF-8' }),
      { reportDelta: (kind, delta) => { frames.push({ kind, delta }); } },
    ));

    expect(report.status).toBe('completed');
    // Both kinds in provider order: a prose-only channel paints a thinking model as idle.
    expect(frames).toEqual([
      { kind: 'reasoning', delta: 'weighing the two lexers' },
      { kind: 'text', delta: 'the lexer handles UTF-8' },
    ]);
  });

  test('every delta is forwarded verbatim and in order, however small', async () => {
    // Preservation: no frame merged, dropped, reordered or reshaped.
    const chunks = ['The ', 'lexer ', 'handles ', 'UTF', '-8 ', 'correctly.'];
    const frames: Frame[] = [];
    await runHeadInference(headInput(), await deps(chunkedHead(chunks), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
    }));

    expect(frames.map((frame) => frame.delta)).toEqual(chunks);
    expect(frames.every((frame) => frame.kind === 'text')).toBe(true);
    expect(frames.map((frame) => frame.delta).join('')).toBe(chunks.join(''));
  });

  test('an empty delta is not a frame', async () => {
    // Empty text deltas are dropped, so keep-alive chunks repaint nothing.
    const frames: Frame[] = [];
    await runHeadInference(headInput(), await deps(chunkedHead(['', 'answer', '']), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
    }));
    expect(frames).toEqual([{ kind: 'text', delta: 'answer' }]);
  });

  test('the durable step REPLACES what the frames painted, byte for byte', async () => {
    // Nothing is held across the step boundary, so the durable row states exactly what the frames said.
    const chunks = ['the lexer ', 'handles ', 'UTF-8'];
    const frames: Frame[] = [];
    const steps: HeadStep[] = [];

    const report = await runHeadInference(headInput(), await deps(chunkedHead(chunks), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
      reportStep: (_seq, step) => { steps.push(step); },
    }));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.text).toBe(chunks.join(''));
    expect(frames.map((frame) => frame.delta).join('')).toBe(steps[0]?.text);
    expect(report.summary).toBe(chunks.join(''));
  });

  test('the durable channel is untouched: the journal still announces its own write', async () => {
    // `head_activity` stays a separate channel: it retires a painted frame.
    const database = new Database(':memory:');
    const sql = makeSql(database);
    const execRaw = makeExecRaw(database);
    initHeadsTables(execRaw);
    const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'head-stream-test');
    const announced: string[] = [];
    const journal = new LiveHeadJournal(sql, actor, (headId) => { announced.push(headId); });
    const frames: Frame[] = [];

    const input = headInput();
    journal.insertSpawn(input);
    announced.length = 0;
    await runHeadInference(input, await deps(chunkedHead(['a ', 'settled ', 'answer']), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
      reportStep: (seq, step) => { journal.appendStep(input.id, seq, step); },
    }));

    expect(frames).toHaveLength(3);
    expect(announced).toEqual([input.id]);
    expect(journal.readSteps(input.id).map((step) => step.text)).toEqual(['a settled answer']);
    database.close();
  });

  test('no sink wired changes nothing about the run', async () => {
    // Frames are best effort: their absence is unobservable in anything durable.
    const withSink = await runHeadInference(headInput(), await deps(
      streamingHead({ reasoning: 'thinking', text: 'answer' }),
      { reportDelta: () => { /* published nowhere */ } },
    ));

    const without = await runHeadInference(headInput(), await deps(
      streamingHead({ reasoning: 'thinking', text: 'answer' }),
    ));

    expect(without.status).toBe(withSink.status);
    expect(without.summary).toBe(withSink.summary);
    expect(without.stepCount).toBe(withSink.stepCount);
  });
});

test('a cancelled head retains its already-settled SDK tool conversation', async () => {
  const pending = Promise.withResolvers<never>();
  const secondStarted = Promise.withResolvers<void>();
  const abort = new AbortController();
  const produced: ModelMessage[] = [];
  const value = { retained: 'structured payload' };
  let calls = 0;

  const model = scriptedTurnModel({ doGenerate: options => {
    if (calls++ === 0) return {
      content: [{ type: 'tool-call', toolCallId: 'kept-call', toolName: 'probe', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
    const signal = options.abortSignal;

    if (signal !== undefined) signal.addEventListener('abort', () => { pending.reject(signal.reason); }, { once: true });
    secondStarted.resolve();

    return pending.promise;
  } });

  const running = runHeadInference(headInput(), await deps(model, {
    signal: abort.signal, clock: REAL_CLOCK, isAborted: () => abort.signal.aborted,
    tools: { probe: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => value,
    }) },
    reportMessages: messages => { produced.push(...messages); },
  }));

  await secondStarted.promise;
  abort.abort(new Error('stopped after the evidence step'));

  try {
    expect((await running).status).toBe('aborted');
    expect(produced.flatMap(message => message.role === 'tool' ? message.content : []))
      .toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'kept-call', output: { type: 'json', value } }));
  } finally {
    pending.reject(new Error('release the test provider'));
    await running;
  }
});

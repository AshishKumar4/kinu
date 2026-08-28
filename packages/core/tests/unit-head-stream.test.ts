/**
 * The transient half of head liveness: `head_stream` frames.
 *
 * `head_activity` fires on the DURABLE write, so it says nothing for the tens of
 * seconds a step is being produced — an open transcript sat still while its
 * branch was working, which reads exactly like a branch that has stopped. These
 * frames fill that interval and are superseded by the step itself.
 *
 * ONE FRAME IS ONE PROVIDER DELTA. So what is pinned here is preservation, not
 * batching: every delta is forwarded, in the provider's order, with its own kind,
 * and a consumer that concatenates holds the bytes the model emitted. Nothing is
 * held, so nothing can cross a step boundary — the durable row simply replaces
 * what was painted.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scriptedTurnModel, type ModelStreamPart } from '@kinu.run/test-utils';
import type { LanguageModel } from 'ai';
import { runHeadInference, HeadCapture, type HeadInferenceDeps } from '../src/heads/head-inference';
import type { HeadStreamKind } from '../src/heads/head-stream';
import { makeSql, makeExecRaw } from './helpers';
import { LiveHeadJournal } from '../src/heads/live-journal';
import { initHeadsTables } from '../src/heads/schema';
import type { HeadInput, HeadStep } from '../src/heads/types';

/** One published frame, as a transport would see it. */
interface Frame { readonly kind: HeadStreamKind; readonly delta: string }

/**
 * A model whose one step emits the given reasoning and prose as ONE delta each.
 *
 * `scriptedTurnModel` replays each content item as start/delta/end stream parts,
 * so this exercises the real `runChat` fullStream path — including the
 * `reasoning-delta` arm, which is the only place a head's thinking is observable
 * before the step lands.
 */
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

/**
 * A model that emits prose as MANY small deltas, the way a real provider does.
 *
 * Hand-built rather than scripted: `scriptedTurnModel` collapses each content
 * item into a single delta, and the property under test is exactly that a
 * many-delta stream survives with its bytes and its order intact.
 */
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
    budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
  };
}

function deps(model: LanguageModel, over?: Partial<HeadInferenceDeps>): HeadInferenceDeps {
  return {
    model, tools: {}, capture: new HeadCapture(), isAborted: () => false,
    workspaceLayout: 'shared-workspace', ...over,
  };
}

describe('a running head publishes what it is producing', () => {
  test('both halves of a step reach the channel, each tagged with its own kind', async () => {
    const frames: Frame[] = [];
    const report = await runHeadInference(headInput(), deps(
      streamingHead({ reasoning: 'weighing the two lexers', text: 'the lexer handles UTF-8' }),
      { reportDelta: (kind, delta) => { frames.push({ kind, delta }); } },
    ));

    expect(report.status).toBe('completed');
    // TWO kinds, in the order the provider produced them. A channel that carried
    // only prose would paint a thinking model as idle for its whole first step,
    // which is the case the reasoning arm exists for.
    expect(frames).toEqual([
      { kind: 'reasoning', delta: 'weighing the two lexers' },
      { kind: 'text', delta: 'the lexer handles UTF-8' },
    ]);
  });

  test('every delta is forwarded verbatim and in order, however small', async () => {
    // PRESERVATION is the contract. The frame boundary is the provider's own, so
    // a consumer that concatenates holds the bytes the model emitted — no frame
    // is merged with its neighbour, dropped, reordered or reshaped on the way.
    const chunks = ['The ', 'lexer ', 'handles ', 'UTF', '-8 ', 'correctly.'];
    const frames: Frame[] = [];
    await runHeadInference(headInput(), deps(chunkedHead(chunks), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
    }));

    expect(frames.map((frame) => frame.delta)).toEqual(chunks);
    expect(frames.every((frame) => frame.kind === 'text')).toBe(true);
    expect(frames.map((frame) => frame.delta).join('')).toBe(chunks.join(''));
  });

  test('an empty delta is not a frame', async () => {
    // The turn body drops empty text deltas before they are yielded, so a
    // provider that emits keep-alive chunks cannot make a reader repaint nothing.
    const frames: Frame[] = [];
    await runHeadInference(headInput(), deps(chunkedHead(['', 'answer', '']), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
    }));
    expect(frames).toEqual([{ kind: 'text', delta: 'answer' }]);
  });

  test('the durable step REPLACES what the frames painted, byte for byte', async () => {
    // The repair, and it needs no channel of its own. Nothing is held across the
    // step boundary, so there is no tail to reconcile: the row states exactly
    // what the frames already said, and the client swaps one for the other when
    // `head_activity` arrives.
    const chunks = ['the lexer ', 'handles ', 'UTF-8'];
    const frames: Frame[] = [];
    const steps: HeadStep[] = [];

    const report = await runHeadInference(headInput(), deps(chunkedHead(chunks), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
      reportStep: (_seq, step) => { steps.push(step); },
    }));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.text).toBe(chunks.join(''));
    // The two channels agree exactly, which is what makes the swap invisible.
    expect(frames.map((frame) => frame.delta).join('')).toBe(steps[0]?.text);
    expect(report.summary).toBe(chunks.join(''));
  });

  test('the durable channel is untouched: the journal still announces its own write', async () => {
    // The two channels are separate and stay separate. `head_activity` rides the
    // journal write (LiveHeadJournal) and is what retires a painted frame, so a
    // transient channel that had somehow replaced it would leave the frame on
    // screen forever.
    const database = new Database(':memory:');
    const sql = makeSql(database);
    initHeadsTables(makeExecRaw(database), sql);
    const announced: string[] = [];
    const journal = new LiveHeadJournal(sql, (headId) => { announced.push(headId); });
    const frames: Frame[] = [];

    const input = headInput();
    journal.insertSpawn(input);
    announced.length = 0;
    await runHeadInference(input, deps(chunkedHead(['a ', 'settled ', 'answer']), {
      reportDelta: (kind, delta) => { frames.push({ kind, delta }); },
      reportStep: (seq, step) => { journal.appendStep(input.id, seq, step); },
    }));

    expect(frames).toHaveLength(3);
    // One announcement per durable write, keyed by the branch whose ledger moved.
    expect(announced).toEqual([input.id]);
    expect(journal.readSteps(input.id).map((step) => step.text)).toEqual(['a settled answer']);
    database.close();
  });

  test('no sink wired changes nothing about the run', async () => {
    // The frames are best effort and subordinate, so their absence must be
    // unobservable in everything durable — which is what lets a backend with
    // nothing watching wire none.
    const withSink = await runHeadInference(headInput(), deps(
      streamingHead({ reasoning: 'thinking', text: 'answer' }),
      { reportDelta: () => { /* published nowhere */ } },
    ));
    const without = await runHeadInference(headInput(), deps(
      streamingHead({ reasoning: 'thinking', text: 'answer' }),
    ));
    expect(without.status).toBe(withSink.status);
    expect(without.summary).toBe(withSink.summary);
    expect(without.stepCount).toBe(withSink.stepCount);
  });
});

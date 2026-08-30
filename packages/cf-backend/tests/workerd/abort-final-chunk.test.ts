/**
 * KINU-084 — an abort that lands at the final chunk, under real workerd
 * scheduling.
 *
 * THE MECHANISM. The pinned AI SDK reads its provider stream in a loop and
 * checks `abortSignal.aborted` AFTER `await reader.read()` resolves
 * (ai@6.0.196). So an abort and the final `finish` part racing in the same
 * region have two different terminal outcomes, and which one happens is
 * decided by whether the flag is already set when that read resolves:
 *
 *   - flag set while the finish read is still pending → the check sees it →
 *     the SDK emits its abort part and hands the turn to the interrupt path;
 *   - finish part already read and the step settled → the next read is
 *     `done` → the turn closes on a natural finish, whatever the flag says.
 *
 * Both are therefore test-controlled state rather than a wall-clock race, and
 * this suite drives each one from the caller's side only.
 *
 * WHY WORKERD. `packages/core/tests/unit-chat-stream-integrity.test.ts` already
 * covers an abort landing mid-stream, with a chunk pending. Neither ordering
 * here is that case, and the finalization they exercise runs in the runtime
 * production actually finalizes in, over the same pinned `ai` bytes the Worker
 * ships.
 *
 * HOW IT DRIVES. `runChat` runs directly in the test worker over a model whose
 * stream the test owns: parts are enqueued by the test and the stream PARKS on
 * a promise until the test releases it. There is no timer anywhere, and every
 * step waits on an observed event rather than on elapsed time. The subject is
 * the finalization contract, not an actor's bookkeeping, so no Durable Object
 * is involved.
 *
 * THE CONTRACT. Exactly ONE terminal outcome per turn, and `done` is always
 * yielded before any throw:
 *   (a) FINISH-FIRST — the finish part is delivered, `done` carries the whole
 *       answer, and an abort raised at that moment cannot retro-abort the turn:
 *       nothing throws.
 *   (b) ABORT-FIRST — the flag is set while the finish part is still parked, so
 *       the turn is cut: `done` still carries the text streamed so far, and the
 *       generator then throws INTERRUPTED_TURN. The partial answer is not lost
 *       because the throw came after it.
 */
import { describe, expect, it } from 'vitest';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { INTERRUPTED_TURN, runChat, type ChatEvent } from '@kinu.run/core';

/** What the scripted step reports for its one request. Small and fixed: the
 *  subject is ordering, and a usage nobody asserts would be vocabulary with no
 *  reader. */
const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const FINISH_PART: LanguageModelV3StreamPart = {
  type: 'finish',
  usage: USAGE,
  finishReason: { unified: 'stop', raw: undefined },
};

/**
 * A stream the test drives. `queued` holds parts the stream may emit now;
 * when it runs dry the stream awaits `released` instead of closing, which is
 * what lets a test hold the finish part back and decide what happens first.
 */
interface StreamGate {
  readonly queued: LanguageModelV3StreamPart[];
  /** Resolves when the test releases the parked stream. */
  readonly released: Promise<void>;
  /** Enqueue the remaining parts and let the parked stream run to close. */
  release(parts: readonly LanguageModelV3StreamPart[]): void;
  /** Resolves once the stream has actually parked — the point at which
   *  everything queued before it has been consumed by the SDK. */
  readonly parked: Promise<void>;
  /** Called by the stream the first time it runs dry, which is what resolves
   *  {@link parked}. The stream announces its own state; the test never
   *  guesses when the SDK got there. */
  announceParked(): void;
}

function openGate(initial: readonly LanguageModelV3StreamPart[]): StreamGate {
  const release = Promise.withResolvers<void>();
  const parked = Promise.withResolvers<void>();
  const queued = [...initial];
  return {
    queued,
    released: release.promise,
    parked: parked.promise,
    release(parts) {
      queued.push(...parts);
      release.resolve();
    },
    announceParked() {
      parked.resolve();
    },
  };
}

/**
 * The scripted model. `doStream` is invoked exactly once per turn — the turn is
 * one step, so a second invocation would mean the finalization re-issued a
 * request, which is a different terminal outcome than either test asserts, and
 * failing loudly is better than measuring the second call by accident.
 */
function gatedModel(gate: StreamGate): LanguageModelV3 {
  let calls = 0;
  return {
    specificationVersion: 'v3',
    provider: 'kinu-probe',
    modelId: 'abort-final-chunk',
    // Nothing in this probe is fetched by URL; the scripted stream is the only
    // source of parts.
    supportedUrls: {},
    async doGenerate() {
      throw new Error('this probe streams; doGenerate is never the path under test');
    },
    async doStream() {
      calls += 1;
      if (calls > 1) {
        throw new Error('the scripted model was invoked twice: the finalization re-issued a request');
      }
      let announced = false;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          const part = gate.queued.shift();
          if (part !== undefined) {
            controller.enqueue(part);
            return;
          }
          // Dry: PARK rather than close, and say so, so the test can act at
          // exactly this point instead of guessing when the SDK got here.
          if (!announced) {
            announced = true;
            gate.announceParked();
          }
          await gate.released;
          const next = gate.queued.shift();
          if (next !== undefined) {
            controller.enqueue(next);
            return;
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}

/** The parts before the finish: one text part carrying the whole answer. What
 *  the two orderings disagree about is the finish part, not text plumbing. */
function textParts(answer: string): readonly LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'p0' },
    { type: 'text-delta', id: 'p0', delta: answer },
    { type: 'text-end', id: 'p0' },
  ];
}

function doneEvents(events: readonly ChatEvent[]): ReadonlyArray<Extract<ChatEvent, { type: 'done' }>> {
  return events.filter((event): event is Extract<ChatEvent, { type: 'done' }> => event.type === 'done');
}

describe('KINU-084 — the abort-at-final-chunk boundary', () => {
  it('(a) finish-first: the completed turn stays complete when the abort lands on `done`', async () => {
    const answer = 'final-chunk-complete';
    const gate = openGate(textParts(answer));
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    let threw: string | null = null;

    // The finish part is delivered the moment the stream parks, so the step
    // settles normally. The abort is then raised AT the `done` event — the
    // latest point the caller can reach while the turn is still finalizing.
    const releaseFinalPart = gate.parked.then(() => { gate.release([FINISH_PART]); });

    try {
      for await (const event of runChat({
        model: gatedModel(gate),
        system: 'sys',
        history: [{ role: 'user', content: 'go' }],
        tools: {},
        signal: abort.signal,
      })) {
        events.push(event);
        if (event.type === 'done') abort.abort();
      }
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }

    await releaseFinalPart;

    const done = doneEvents(events);
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toContain(answer);
    // A post-commit abort must not turn a finished turn into an interrupted
    // one, and must not produce a second terminal.
    expect(threw).toBeNull();
  });

  it('(b) abort-first: the cut turn keeps its partial answer, then throws the interrupt marker', async () => {
    const partial = 'final-chunk-partial';
    const gate = openGate(textParts(partial));
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    let threw: string | null = null;

    // The cut is taken once the CALLER has actually seen streamed text, which
    // is the only ordering that can answer the question: does a turn cut at
    // the finish boundary keep the answer it already delivered? Aborting when
    // the stream merely parks is too early — the provider has queued its parts
    // but the caller has been handed nothing, so nothing could survive.
    //
    // The finish part is released in the same step, after the flag is set, so
    // the SDK's aborted check runs on a read that resolves after the abort.
    let cut = false;

    try {
      for await (const event of runChat({
        model: gatedModel(gate),
        system: 'sys',
        history: [{ role: 'user', content: 'go' }],
        tools: {},
        signal: abort.signal,
      })) {
        events.push(event);
        if (event.type === 'text-delta' && !cut) {
          cut = true;
          abort.abort();
          gate.release([FINISH_PART]);
        }
      }
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }

    // The premise of the assertions below: text really did reach the caller
    // before the cut. Without this the test could pass vacuously on a turn
    // that streamed nothing at all.
    expect(events.some((event) => event.type === 'text-delta')).toBe(true);
    const done = doneEvents(events);
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toContain(partial);
    // `done` before the throw is the whole point: the marker says the turn was
    // cut, and the text says what survived the cut.
    expect(threw).toBe(INTERRUPTED_TURN);
  });
});

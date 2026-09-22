/**
 * KINU-084: an abort at the final chunk, under real workerd. ai@6.0.214 checks `abortSignal.aborted`
 * after `await reader.read()`, so exactly one terminal outcome per turn and `done` always precedes a throw:
 * finish-first never retro-aborts; abort-first yields the partial `done`, then INTERRUPTED_TURN.
 */
import { describe, expect, it } from 'vitest';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { INTERRUPTED_TURN, runChat, type ChatEvent } from '@kinu.run/core';

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const FINISH_PART: LanguageModelV3StreamPart = {
  type: 'finish',
  usage: USAGE,
  finishReason: { unified: 'stop', raw: undefined },
};

/** When `queued` runs dry the stream parks on `released` instead of closing. */
interface StreamGate {
  readonly queued: LanguageModelV3StreamPart[];
  readonly released: Promise<void>;
  release(parts: readonly LanguageModelV3StreamPart[]): void;
  /** Resolves once the stream parked: everything queued before it was consumed. */
  readonly parked: Promise<void>;
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

/** `doStream` runs exactly once per turn; a second call would mean finalization re-issued a request. */
function gatedModel(gate: StreamGate): LanguageModelV3 {
  let calls = 0;

  return {
    specificationVersion: 'v3',
    provider: 'kinu-probe',
    modelId: 'abort-final-chunk',
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

          // Dry: park rather than close, and announce it.
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

    // Abort raised at the `done` event: the latest point while the turn still finalizes.
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
    expect(threw).toBeNull();
  });

  it('(b) abort-first: the cut turn keeps its partial answer, then throws the interrupt marker', async () => {
    const partial = 'final-chunk-partial';
    const gate = openGate(textParts(partial));
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    let threw: string | null = null;

    // Cut only after the caller has seen text (earlier, nothing could survive); the finish is released
    // after the flag is set, so the SDK's check runs on a read resolving after the abort.
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

    // Guards against a vacuous pass on a turn that streamed nothing.
    expect(events.some((event) => event.type === 'text-delta')).toBe(true);
    const done = doneEvents(events);
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toContain(partial);
    expect(threw).toBe(INTERRUPTED_TURN);
  });
});

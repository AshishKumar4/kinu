/**
 * The evolved scaffold on the LIVE inference seam (Think 0.8's protected
 * `_transformInferenceResult`) — scaffold/inference-transform.ts.
 *
 * Pins the re-wired contract that used to live on the dead `runStreamText`
 * override (zero callers on think@0.8.2):
 *   - un-evolved agent (version <= 0): the default result passes through
 *     UNTOUCHED (same object — zero overhead, no wrapper).
 *   - delegating scaffold: `host.defaultInference()` streams the EXACT
 *     chunks Think prepared — byte-faithful (same chunk objects).
 *   - custom scaffold that never delegates: its own output replaces the
 *     default, and the orphaned default stream (streamText fires eagerly)
 *     is cancelled when the scaffold settles.
 */
import { describe, test, expect } from 'bun:test';
import { scaffoldInferenceTransform, type InferenceStreamResult } from '../src/index.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { Executor } from '../src/types/primitives.js';
import { createTestRuntime } from './helpers.js';

/** DynamicWorkerExecutor semantics: providers visible as globals. */
function evalExecutor(): Executor {
  return {
    async execute(code, providers) {
      const arr = providers as Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>> }>;
      try {
        const fn = new Function(...arr.map((p) => p.name), `return (async () => {\n${code}\n})();`);
        const result = await fn(...arr.map((p) => p.fns));
        return { result };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const DELEGATING_SCAFFOLD = `async function run(rt, task) {
  await host.defaultInference();
}`;

const CUSTOM_SCAFFOLD = `async function run(rt, task) {
  await host.emit({ type: 'text_delta', text: 'custom answer' });
}`;

function runtime(): AgentRuntime {
  const { rt } = createTestRuntime();
  (rt as { executor: Executor }).executor = evalExecutor();
  return rt;
}

function runOpts(rt: AgentRuntime, scaffoldCode: string) {
  return {
    rt,
    task: 'the task',
    llmStream: async function* () { yield ''; },
    scaffoldCodeOverride: scaffoldCode,
    timeoutMs: 10_000,
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<Array<{ type: string }>> {
  const out: Array<{ type: string }> = [];
  for await (const c of stream) out.push(c as { type: string });
  return out;
}

describe('scaffoldInferenceTransform', () => {
  test('version <= 0 → the default result passes through untouched (same object)', () => {
    const result: InferenceStreamResult = {
      toUIMessageStream: () => (async function* () { yield { type: 'finish' }; })(),
    };
    expect(scaffoldInferenceTransform({ currentVersion: 0, result, run: runOpts(runtime(), DELEGATING_SCAFFOLD) }))
      .toBe(result);
  });

  test('delegating scaffold is byte-faithful: the prepared chunks pass through verbatim', async () => {
    const innerContent = [
      { type: 'text-start', id: 'x' },
      { type: 'text-delta', id: 'x', delta: 'hello ' },
      { type: 'text-delta', id: 'x', delta: 'world' },
      { type: 'text-end', id: 'x' },
    ];
    let streams = 0;
    const result: InferenceStreamResult = {
      toUIMessageStream: () => {
        streams++;
        return (async function* () {
          yield { type: 'start', messageId: 'inner' };
          for (const c of innerContent) yield c;
          yield { type: 'finish' };
        })();
      },
    };

    const out = scaffoldInferenceTransform({
      currentVersion: 3, result, run: runOpts(runtime(), DELEGATING_SCAFFOLD),
    });
    expect(out).not.toBe(result);
    const chunks = await collect(out.toUIMessageStream());

    // Outer envelope owned by the scaffold stream; inner start/finish stripped.
    expect(chunks[0]?.type).toBe('start');
    expect(chunks[chunks.length - 1]?.type).toBe('finish');
    // The prepared content chunks arrive verbatim — the SAME objects, not
    // re-encoded copies. That is the byte-faithfulness of a delegating
    // scaffold on this seam: host.defaultInference() IS the default stream.
    const content = chunks.filter((c) => c.type.startsWith('text-'));
    expect(content).toHaveLength(innerContent.length);
    content.forEach((c, i) => expect(c).toBe(innerContent[i] as { type: string }));
    // Exactly one consumption of the prepared stream (no re-run of inference).
    expect(streams).toBe(1);
  });

  test('custom scaffold replaces the default; the orphaned eager stream is cancelled', async () => {
    let closed = false;
    const result: InferenceStreamResult = {
      toUIMessageStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: { type: 'text-delta', id: 'd', delta: 'default' }, done: false }),
          return: async () => {
            closed = true;
            return { value: undefined, done: true };
          },
        }),
      }),
    };

    const out = scaffoldInferenceTransform({
      currentVersion: 2, result, run: runOpts(runtime(), CUSTOM_SCAFFOLD),
    });
    const chunks = await collect(out.toUIMessageStream());

    const text = chunks
      .filter((c): c is { type: string; delta: string } => c.type === 'text-delta')
      .map((c) => c.delta).join('');
    expect(text).toBe('custom answer');
    // The scaffold never delegated → the eagerly-fired default stream was
    // cancelled instead of running unconsumed to completion.
    expect(closed).toBe(true);
  });
});

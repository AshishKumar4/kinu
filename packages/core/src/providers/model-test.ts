import type { LanguageModel } from 'ai';
import { describeProviderError, providerFailureFacts, toProviderError } from './util';
import { abortCause } from '../utils/abort';
import { Effect, Result } from 'effect';
import { renderThrownChain, settle } from '../obs/index';
import { callRetries } from './middleware/retry';
import { streamTextReported } from './model-invocation';
import { actorAffinity } from './workers-ai';
import type { ModelAffinity } from './types';
import type { ModelCallSink } from '../events/model-call';
import type { ModelTestResult } from './model-test-result';

/** Unretried; output uncapped by rule. Each test is a conversation of its own. */
export function testModel(input: {
  readonly spec: string;
  readonly resolve: (spec: string, affinity: ModelAffinity) => LanguageModel;
  readonly report?: ModelCallSink;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<ModelTestResult> {
  return settle(Effect.gen(function* () {
    const now = input.now ?? performance.now.bind(performance);

    const resolved = yield* Effect.result(Effect.try({
      try: () => input.resolve(input.spec, actorAffinity({ name: `model-test-${crypto.randomUUID()}`, workspaceId: crypto.randomUUID() })),
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(resolved)) return { ok: false, failure: 'unknown-model', message: renderThrownChain(resolved.failure) };
    const model = resolved.success;
    const started = now();
    let firstTokenMs: number | null = null;
    const spend = { source: 'test', report: input.report ?? ((): void => {}) } as const;
    // The stream then throws a generic "no output" in place of this.
    const streamed: Array<{ readonly error: unknown }> = [];

    const drained = yield* Effect.result(Effect.tryPromise({
      try: async () => {
        const stream = streamTextReported({
          model,
          prompt: 'Reply with the word OK.',
          // A test names each refusal once: the stack retries nothing for it.
          maxRetries: 0,
          providerOptions: callRetries(0),
          ...(input.signal !== undefined && { abortSignal: input.signal }),
          onError: (event) => { streamed.push(event); },
        }, { spend, spec: input.spec }, (part) => {
          if (firstTokenMs === null && (part.type === 'text-delta' || part.type === 'reasoning-delta')) firstTokenMs = now() - started;
        });

        for await (const chunk of stream) void chunk;
      },
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(drained)) {
      if (input.signal?.aborted) return yield* Effect.die(abortCause(input.signal));

      return failed({ cause: streamed[0]?.error ?? drained.failure.cause });
    }

    if (streamed[0] !== undefined) return failed({ cause: streamed[0].error });

    const totalMs = now() - started;

    return { ok: true, firstTokenMs: firstTokenMs ?? totalMs, totalMs };
  }));
}

function failed({ cause }: { readonly cause: unknown }): ModelTestResult {
  const classified = toProviderError({ doing: 'testing the model', cause });
  const facts = providerFailureFacts({ cause });
  const { status } = facts;
  const message = describeProviderError({ cause });

  const credits = status === 402 || /insufficient_(?:quota|credits)|credit_balance/u.test(facts.providerCode ?? '');

  if (classified.code === 'budget' || credits) {
    const until = /until (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/u.exec(message)?.[1];

    return { ok: false, failure: 'spent', message, ...(until !== undefined && { until: Date.parse(`${until.replace(' ', 'T')}Z`) }) };
  }

  if (status === 401 || status === 403 || classified.code === 'denied') return { ok: false, failure: 'signed-out', message };

  if (status === 404 || classified.code === 'missing') return { ok: false, failure: 'unknown-model', message };

  if (classified.code === 'unavailable' || classified.code === 'timeout') return { ok: false, failure: 'unreachable', message };

  return { ok: false, failure: 'refused', message };
}

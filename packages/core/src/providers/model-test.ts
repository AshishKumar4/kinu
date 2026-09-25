import { streamText, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { PROVIDER_SDK_RETRIES } from './rate-limit-retry';
import { describeProviderError, providerFailureFacts, toProviderError } from './util';
import { abortCause } from '../utils/abort';

export type ModelTestFailure = 'signed-out' | 'spent' | 'unknown-model' | 'unreachable' | 'refused';

export type ModelTestResult =
  | { readonly ok: true; readonly firstTokenMs: number; readonly totalMs: number }
  | { readonly ok: false; readonly failure: ModelTestFailure; readonly message: string };

export const ModelTestResultSchema: v.GenericSchema<ModelTestResult> = v.union([
  v.object({ ok: v.literal(true), firstTokenMs: v.number(), totalMs: v.number() }),
  v.object({
    ok: v.literal(false),
    failure: v.picklist(['signed-out', 'spent', 'unknown-model', 'unreachable', 'refused']),
    message: v.string(),
  }),
]);

/** Output is uncapped by rule; the prompt keeps it to a word. */
export async function testModel(input: {
  readonly model: LanguageModel;
  readonly providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<ModelTestResult> {
  const now = input.now ?? performance.now.bind(performance);
  const started = now();
  let firstTokenMs: number | null = null;
  const failures: Array<{ readonly error: unknown }> = [];

  const result = streamText({
    model: input.model,
    prompt: 'Reply with the word OK.',
    maxRetries: PROVIDER_SDK_RETRIES,
    ...(input.providerOptions !== undefined && { providerOptions: input.providerOptions }),
    ...(input.signal !== undefined && { abortSignal: input.signal }),
    onError: (event) => { failures.push(event); },
  });

  for await (const part of result.fullStream) {
    if (firstTokenMs === null && (part.type === 'text-delta' || part.type === 'reasoning-delta')) firstTokenMs = now() - started;
  }

  if (input.signal?.aborted) throw abortCause(input.signal);

  const [failure] = failures;

  if (failure !== undefined) return failed({ cause: failure.error });

  const totalMs = now() - started;

  return { ok: true, firstTokenMs: firstTokenMs ?? totalMs, totalMs };
}

function failed({ cause }: { readonly cause: unknown }): ModelTestResult {
  const classified = toProviderError({ doing: 'testing the model', cause });
  const { status } = providerFailureFacts({ cause });
  const message = describeProviderError({ cause });

  if (classified.code === 'budget') return { ok: false, failure: 'spent', message };

  if (status === 401 || status === 403 || classified.code === 'denied') return { ok: false, failure: 'signed-out', message };

  if (status === 404 || classified.code === 'missing') return { ok: false, failure: 'unknown-model', message };

  if (classified.code === 'unavailable' || classified.code === 'timeout') return { ok: false, failure: 'unreachable', message };

  return { ok: false, failure: 'refused', message };
}

const FAILURE_WORDS: Record<ModelTestFailure, string> = {
  'signed-out': 'Sign-in expired',
  spent: 'Allowance spent',
  'unknown-model': 'Unknown model',
  unreachable: 'Unreachable',
  refused: 'Refused',
};

const fmtMs = (ms: number): string => (ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`);

export function modelTestText(result: ModelTestResult): string {
  return result.ok
    ? `Works · first token ${fmtMs(result.firstTokenMs)} · total ${fmtMs(result.totalMs)}`
    : `${FAILURE_WORDS[result.failure]}: ${result.message}`;
}

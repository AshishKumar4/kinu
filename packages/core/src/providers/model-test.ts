import { streamText, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { PROVIDER_SDK_RETRIES } from './rate-limit-retry';
import { describeProviderError, providerFailureFacts, toProviderError } from './util';
import { abortCause } from '../utils/abort';

export type ModelTestFailure = 'signed-out' | 'spent' | 'unknown-model' | 'unreachable' | 'refused';

export type ModelTestResult =
  | { readonly ok: true; readonly firstTokenMs: number; readonly totalMs: number }
  | { readonly ok: false; readonly failure: ModelTestFailure; readonly message: string; readonly until?: number };

export const ModelTestResultSchema: v.GenericSchema<ModelTestResult> = v.union([
  v.object({ ok: v.literal(true), firstTokenMs: v.number(), totalMs: v.number() }),
  v.object({
    ok: v.literal(false),
    failure: v.picklist(['signed-out', 'spent', 'unknown-model', 'unreachable', 'refused']),
    message: v.string(),
    until: v.optional(v.number()),
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

  if (classified.code === 'budget') {
    const until = /until (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/u.exec(message)?.[1];

    return { ok: false, failure: 'spent', message, ...(until !== undefined && { until: Date.parse(`${until.replace(' ', 'T')}Z`) }) };
  }

  if (status === 401 || status === 403 || classified.code === 'denied') return { ok: false, failure: 'signed-out', message };

  if (status === 404 || classified.code === 'missing') return { ok: false, failure: 'unknown-model', message };

  if (classified.code === 'unavailable' || classified.code === 'timeout') return { ok: false, failure: 'unreachable', message };

  return { ok: false, failure: 'refused', message };
}

const PROVIDER_NAMES = new Map(Object.entries({
  codex: 'ChatGPT', claude: 'Claude', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter',
  'workers-ai': 'Workers AI', 'ai-gateway': 'AI Gateway', 'my-gateway': 'AI Gateway', opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go', devin: 'Devin',
}));

export function providerName(provider: string): string {
  return PROVIDER_NAMES.get(provider) ?? provider;
}

const fmtMs = (ms: number): string => (ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`);

const fmtUntil = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function modelTestText(result: ModelTestResult, where: { readonly provider: string; readonly from: 'this server' | 'here' }): string {
  if (result.ok) return `Works · first token ${fmtMs(result.firstTokenMs)} · total ${fmtMs(result.totalMs)}`;
  const name = providerName(where.provider);

  switch (result.failure) {
    case 'signed-out': return `Signed out of ${name}. Reconnect it in settings.`;
    case 'spent': return result.until === undefined ? `${name} allowance is spent.` : `${name} allowance is spent until ${fmtUntil(result.until)}.`;
    case 'unknown-model': return `${name} doesn't offer this model.`;
    case 'unreachable': return `Can't reach ${name} from ${where.from}.`;
    case 'refused': return `${name} refused the test.`;
  }
}

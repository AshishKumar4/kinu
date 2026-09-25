import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import { describeProviderError, providerFailureFacts, toProviderError } from './util';
import { abortCause } from '../utils/abort';
import { renderThrownChain } from '../obs/index';
import { streamTextReported } from './model-invocation';
import type { ModelCallSink } from '../events/model-call';

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

/** Unretried; output uncapped by rule. */
export async function testModel(input: {
  readonly spec: string;
  readonly resolve: (spec: string) => LanguageModel;
  readonly report?: ModelCallSink;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<ModelTestResult> {
  const now = input.now ?? performance.now.bind(performance);
  let model: LanguageModel;

  try {
    model = input.resolve(input.spec);
  } catch (cause) {
    return { ok: false, failure: 'unknown-model', message: renderThrownChain({ cause }) };
  }

  const started = now();
  let firstTokenMs: number | null = null;
  const spend = { source: 'test', report: input.report ?? ((): void => {}) } as const;
  // The stream then throws a generic "no output" in place of this.
  const streamed: Array<{ readonly error: unknown }> = [];

  try {
    const stream = streamTextReported({
      model,
      prompt: 'Reply with the word OK.',
      maxRetries: 0,
      ...(input.signal !== undefined && { abortSignal: input.signal }),
      onError: (event) => { streamed.push(event); },
    }, { spend, spec: input.spec }, (part) => {
      if (firstTokenMs === null && (part.type === 'text-delta' || part.type === 'reasoning-delta')) firstTokenMs = now() - started;
    });

    for await (const chunk of stream) void chunk;
  } catch (cause) {
    if (input.signal?.aborted) throw abortCause(input.signal);

    return failed({ cause: streamed[0]?.error ?? cause });
  }

  if (streamed[0] !== undefined) return failed({ cause: streamed[0].error });

  const totalMs = now() - started;

  return { ok: true, firstTokenMs: firstTokenMs ?? totalMs, totalMs };
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

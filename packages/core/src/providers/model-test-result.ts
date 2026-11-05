/** A model test's answer as the app reads and words it, apart from the test itself: the pages that show it run no model. */
import * as v from 'valibot';

type ModelTestFailure = 'signed-out' | 'spent' | 'unknown-model' | 'unreachable' | 'refused';

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

const PROVIDER_NAMES = new Map(Object.entries({
  chatgpt: 'ChatGPT', codex: 'ChatGPT Codex', claude: 'Claude', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter',
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

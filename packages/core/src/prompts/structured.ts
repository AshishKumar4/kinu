import { generateText, type LanguageModel } from 'ai';
import * as v from 'valibot';

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

export function jsonObjectOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON object. Do not include markdown fences or prose.';
}

export function jsonArrayOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON array. Do not include markdown fences or prose.';
}

export function extractJsonObject(text: string): unknown {
  return JSON.parse(extractBalancedJson(text, '{', '}'));
}

export function extractJsonArray(text: string): unknown {
  return JSON.parse(extractBalancedJson(text, '[', ']'));
}

function extractBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string {
  const fenced = text.match(JSON_FENCE);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf(open);
  if (start === -1) throw new Error(`no JSON ${open === '{' ? 'object' : 'array'} in model output`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated JSON ${open === '{' ? 'object' : 'array'} in model output`);
}

/**
 * Generate a schema-validated object from a model.
 *
 * ai-SDK v6 `generateObject` drives object generation through a synthetic tool
 * call and reads `toolCall.input`; the Workers AI provider (the default — Kimi)
 * does not reliably emit that tool, so the SDK dereferences `.input` on an
 * undefined call and throws "Cannot read properties of undefined (reading
 * 'input')". So this asks for JSON via plain `generateText`, extracts the
 * object, and validates it against the same schema — which works on every
 * provider.
 *
 * Throws on malformed output or schema mismatch; callers handle the failure
 * (the heads merge falls back to per-head summaries, the GEPA metric to a
 * neutral score).
 */
export async function generateJson<TOutput>(opts: {
  model: LanguageModel;
  schema: v.GenericSchema<unknown, TOutput>;
  prompt: string;
  maxOutputTokens?: number;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
}): Promise<TOutput> {
  const { text } = await generateText({
    model: opts.model,
    prompt: `${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
  });
  return v.parse(opts.schema, extractJsonObject(text));
}

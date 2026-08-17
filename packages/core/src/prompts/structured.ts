import { generateText, type LanguageModel } from 'ai';
import * as v from 'valibot';
import type { ModelCallSpend } from '../events/model-call.js';
import { normalizeUsage } from '../usage.js';
import { parseJsonArray, parseJsonObject, type JsonObject, type JsonValue } from '../utils/json.js';

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

export interface MarkdownFencedBlock {
  readonly tag: string | null;
  readonly code: string;
}

/** Parse Markdown fences without assigning any execution semantics to the tag. */
export function markdownFencedBlocks(text: string): MarkdownFencedBlock[] {
  return [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((match) => ({
    tag: match[1]!.trim().split(/\s+/)[0]?.toLowerCase() || null,
    code: match[2]!.trim(),
  }));
}

/** Return the first fenced payload, or the trimmed response when there is no fence. */
export function stripMarkdownFences(raw: string): string {
  return markdownFencedBlocks(raw)[0]?.code ?? raw.trim();
}

export function jsonObjectOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON object. Do not include markdown fences or prose.';
}

export function jsonArrayOnlyInstruction(): string {
  return 'Return ONLY a single minified JSON array. Do not include markdown fences or prose.';
}

export function extractJsonObject(text: string): JsonObject {
  return parseJsonObject(extractBalancedJson(text, '{', '}'));
}

export function extractJsonArray(text: string): JsonValue[] {
  return parseJsonArray(extractBalancedJson(text, '[', ']'));
}

function extractBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string {
  const fenced = text.match(JSON_FENCE);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf(open);
  if (start === -1) throw new SyntaxError(`no JSON ${open === '{' ? 'object' : 'array'} in model output`);

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
  throw new SyntaxError(`unterminated JSON ${open === '{' ? 'object' : 'array'} in model output`);
}

/**
 * Generate a schema-validated object from a model.
 *
 * ai-SDK v6 `generateObject` drives object generation through a synthetic tool
 * call and reads `toolCall.input`; some Workers AI models, including Kimi,
 * do not reliably emit that tool, so the SDK dereferences `.input` on an
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
  /** Where this call is reported, and as whose spend. Four producers share this
   *  one seam — the scaffold JSON judge, both head-merge paths and the GEPA
   *  metric — so the label travels with the sink and is never assumed here.
   *  Absent means this producer's spend is attributed to nothing. */
  spend?: ModelCallSpend;
}): Promise<TOutput> {
  const result = await generateText({
    model: opts.model,
    prompt: `${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`,
    maxOutputTokens: opts.maxOutputTokens,
    providerOptions: opts.providerOptions,
  });
  // Before the extract-and-validate, and outside it: the call COMPLETED and was
  // billed whether or not its output turns out to be JSON this schema accepts,
  // and every caller handles that throw by falling back to something cheaper —
  // so a report placed after it would drop exactly the spend of a bad model.
  const spend = opts.spend;
  spend?.report({
    source: spend.source,
    usage: normalizeUsage(result.totalUsage),
    modelId: result.response.modelId,
  });
  return v.parse(opts.schema, extractJsonObject(result.text));
}

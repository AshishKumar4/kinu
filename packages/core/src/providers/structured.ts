import type { LanguageModel } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';
import type { ModelCallSpend } from '../events/model-call';
import { generateReported, type GenerateRequest } from './model-invocation';
import { parseJsonArray, parseJsonObject, type JsonObject, type JsonValue } from '../utils/json';

const JSON_FENCE = /```json\s*([\s\S]*?)```/i;

export interface MarkdownFencedBlock {
  readonly tag: string | null;
  readonly code: string;
}

export function markdownFencedBlocks(text: string): MarkdownFencedBlock[] {
  return [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((match) => ({
    tag: (match[1] ?? '').trim().split(/\s+/)[0]?.toLowerCase() || null,
    code: (match[2] ?? '').trim(),
  }));
}

/** Return the first fenced payload, or the trimmed response when there is no fence. */
export function stripMarkdownFences(raw: string): string {
  return markdownFencedBlocks(raw)[0]?.code ?? raw.trim();
}

export function jsonObjectOnlyInstruction(): string {
  return 'Return a single minified JSON object, with no markdown fences or prose.';
}

export function jsonArrayOnlyInstruction(): string {
  return 'Return a single minified JSON array, with no markdown fences or prose.';
}

export function extractJsonObject(text: string): JsonObject {
  return settleSync(Effect.map(balancedJson(text, '{', '}'), parseJsonObject));
}

export function extractJsonArray(text: string): JsonValue[] {
  return settleSync(Effect.map(balancedJson(text, '[', ']'), parseJsonArray));
}

function balancedJson(text: string, open: '{' | '[', close: '}' | ']'): Effect.Effect<string> {
  const fenced = text.match(JSON_FENCE);
  const inner = fenced?.[1] ?? '';
  const src = inner.includes(open) ? inner : text;
  const start = src.indexOf(open);

  if (start === -1) return Effect.die(new SyntaxError(`no JSON ${open === '{' ? 'object' : 'array'} in model output`));

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
    else if (ch === close && --depth === 0) return Effect.succeed(src.slice(start, i + 1));
  }

  return Effect.die(new SyntaxError(`unterminated JSON ${open === '{' ? 'object' : 'array'} in model output`));
}

/** Uses plain `generateText` + extraction because `generateObject`'s synthetic tool call fails on some
 *  Workers AI models (Kimi). Throws on malformed output or schema mismatch. */
export async function generateJson<TOutput>(opts: {
  model: LanguageModel;
  schema: v.GenericSchema<unknown, TOutput>;
  prompt: string;
  providerOptions?: GenerateRequest['providerOptions'];
  spend: ModelCallSpend;
}): Promise<TOutput> {
  // Reported before validation: the call was billed even if its output fails the schema.
  const result = await generateReported({
    model: opts.model,
    prompt: `${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`,
    providerOptions: opts.providerOptions,
  }, { spend: opts.spend }, 'generate_json');

  return v.parse(opts.schema, extractJsonObject(result.text));
}

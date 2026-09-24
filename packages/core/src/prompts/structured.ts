import { generateText, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { beginModelOperation, type ModelCallSpend } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { callAccountOf } from '../providers/quota';
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
  return parseJsonObject(extractBalancedJson(text, '{', '}'));
}

export function extractJsonArray(text: string): JsonValue[] {
  return parseJsonArray(extractBalancedJson(text, '[', ']'));
}

function extractBalancedJson(text: string, open: '{' | '[', close: '}' | ']'): string {
  const fenced = text.match(JSON_FENCE);
  const inner = fenced?.[1] ?? '';
  const src = inner.includes(open) ? inner : text;
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

/** Uses plain `generateText` + extraction because `generateObject`'s synthetic tool call fails on some
 *  Workers AI models (Kimi). Throws on malformed output or schema mismatch. */
export async function generateJson<TOutput>(opts: {
  model: LanguageModel;
  schema: v.GenericSchema<unknown, TOutput>;
  prompt: string;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  /** Four producers share this seam, so the label travels with the sink; absent means unattributed. */
  spend?: ModelCallSpend;
}): Promise<TOutput> {
  const spend = opts.spend;
  // Opened before the request so a judge killed mid-call still leaves a ledger trace.
  const operation = beginModelOperation(spend, 'generate_json');
  let result;

  try {
    result = await generateText({
      model: opts.model,
      prompt: `${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`,
      providerOptions: opts.providerOptions,
    });
  } catch (err) {
    operation.failed({ cause: err });
    throw err;
  }

  // Reported before validation: the call was billed even if its output fails the schema.
  const usage = normalizeUsage(result.totalUsage);
  const modelId = result.response.modelId;
  operation.completed({ usage, modelId });
  spend?.report({ source: spend.source, usage, modelId, account: callAccountOf(result.response) });

  return v.parse(opts.schema, extractJsonObject(result.text));
}

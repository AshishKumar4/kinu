// Provider-agnostic structured output.
//
// ai-SDK v6 `generateObject` drives object generation through a synthetic tool
// call and reads `toolCall.input`; the Workers AI provider (our default — Kimi)
// does not reliably emit that tool, so the SDK dereferences `.input` on an
// undefined call and throws "Cannot read properties of undefined (reading
// 'input')". Rather than depend on that path, we ask the model for JSON via
// plain `generateText`, extract the object, and validate with the same valibot
// schema — which works on every provider (the pattern sleep-time-compute uses).

import { generateText, type LanguageModel } from "ai";
import * as v from "valibot";
import { extractJsonObject, jsonObjectOnlyInstruction } from "@proteus/core";

export { extractJsonObject };

/** Generate a schema-validated object from a model via plain text + JSON parse.
 *  Throws on malformed output or schema mismatch — callers handle the failure
 *  (e.g. the heads merge falls back to per-head summaries). */
export async function generateJson<TOutput>(opts: {
  model: LanguageModel;
  schema: v.GenericSchema<unknown, TOutput>;
  prompt: string;
  maxOutputTokens?: number;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}): Promise<TOutput> {
  const { text } = await generateText({
    model: opts.model,
    prompt:
      opts.prompt +
      `\n\n${jsonObjectOnlyInstruction()}`,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
  });
  return v.parse(opts.schema, extractJsonObject(text));
}

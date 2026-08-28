/**
 * Cached-usage repair for Cloudflare AI SSE streams.
 *
 * The {account}/ai/v1 chat-completions stream carries usage TWICE: the model
 * runtime's own final chunk, then a platform-appended duplicate. The duplicate
 * loses the cache report in one of TWO shapes, and both were observed live:
 * it zeroes `prompt_tokens_details.cached_tokens` (2026-07-13,
 * @cf/zai-org/glm-5.2: the model chunk reported cached_tokens:14528 while the
 * trailing duplicate said 0 — and account billing confirmed the discounted
 * cached rate was applied), or it DROPS `prompt_tokens_details` altogether
 * (2026-08-17, @cf/deepseek-ai/deepseek-v4-pro-0813 — see the workspace
 * evidence in unit-stream-usage-repair.ts). @cf/moonshotai/kimi-k2.6's
 * duplicate is faithful. @ai-sdk/openai-compatible keeps the LAST usage chunk
 * it sees, so without repair every streamed step loses its cache read:
 * the zeroing shape reports `cacheRead: 0`, which reads as a total cache miss
 * because a reported zero is evidence, and the dropping shape reports nothing
 * at all, which `normalizeUsage` correctly refuses to guess at. Either way the
 * cache itself works; only the reporting is lost.
 *
 * Repair rule: within one response, `cached_tokens` cannot legitimately
 * decrease. Track the largest value seen; rewrite any later usage chunk that
 * reports less, or that dropped the field, to that maximum. Untouched lines
 * pass through byte-exactly and nothing is ever fabricated — until a chunk has
 * reported a real cache read there is no maximum to restore, so a stream that
 * only ever reports 0, or never mentions caching at all, is left exactly as it
 * came.
 *
 * The rule and the byte pass are separate exports because the two paths that
 * need the rule differ in exactly one way: this endpoint's SSE bytes reach the
 * caller unread (cloudflare-ai-fetch.ts), so they have to be split and parsed
 * here, while the direct binding path already parses every `data:` line to
 * translate it (direct-workers-ai-fetch.ts). That path applies the rule inside
 * its own pass rather than splitting, decoding, parsing and re-encoding the
 * same bytes a second time.
 */

import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

/** The cache detail a usage report carries, all of it optional: a duplicate
 *  that dropped or nulled the whole object is precisely the shape needing
 *  repair. */
const UsageSchema = v.looseObject({
  prompt_tokens_details: v.nullish(v.looseObject({ cached_tokens: v.nullish(v.number()) })),
});

/**
 * The repair rule, as one stateful function over one response.
 *
 * Takes the `usage` a chunk reports and answers with the usage it should report
 * instead, or `undefined` when the chunk needs no repair — so a caller holding
 * the original bytes can forward them untouched. Every usage report of the
 * response must pass through, in arrival order: the maximum is what a later
 * under-reporting duplicate is restored to.
 */
export function createCachedUsageRepair(): (usage: JsonObject) => JsonObject | undefined {
  let maxCached = 0;
  return (usage) => {
    const parsed = v.safeParse(UsageSchema, usage);
    if (!parsed.success) return undefined;
    const cached = parsed.output.prompt_tokens_details?.cached_tokens ?? undefined;
    if (cached !== undefined && cached >= maxCached) {
      maxCached = cached;
      return undefined;
    }
    // No chunk has reported a real cache read yet, so there is no maximum to
    // restore — and writing a `cached_tokens: 0` here would fabricate a report
    // the provider never made, which is the one thing this repair must not do.
    if (maxCached === 0) return undefined;
    // Built in statements rather than spread-when-present: the duplicate we
    // repair is exactly the chunk that DROPPED or nulled this object, so
    // "no detail" is the common case and deserves to read as one.
    const details = usage.prompt_tokens_details;
    const repaired: JsonObject = v.is(JsonObjectSchema, details) ? { ...details } : {};
    repaired.cached_tokens = maxCached;
    return { ...usage, prompt_tokens_details: repaired };
  };
}

/** Wrap an upstream response so its SSE usage chunks are repaired. Non-SSE
 *  and bodyless responses are returned unchanged. */
export function repairSseCachedUsage(res: Response): Response {
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || !contentType.includes('text/event-stream')) return res;
  return new Response(res.body.pipeThrough(cachedUsageRepairTransform()), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Byte→byte transform: split the SSE stream into lines, repair `data:` lines
 *  whose usage under-reports or drops the cached-token count, pass everything
 *  else through. */
function cachedUsageRepairTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const repairUsage = createCachedUsageRepair();
  let buffer = '';

  const repairLine = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const crlf = line.endsWith('\r');
    const payload = line.slice(5, crlf ? -1 : undefined).trim();
    if (!payload.startsWith('{')) return line; // e.g. "data: [DONE]"
    // A `data:` line that is not JSON is not a usage chunk, so it passes
    // through untouched like every other non-usage line. Any other failure is
    // real and must not become a silent skip of the repair.
    const decoded = tolerate<unknown>(() => JSON.parse(payload), 'malformed-input');
    const parsed = v.safeParse(JsonObjectSchema, decoded);
    if (!parsed.success) return line;
    const chunk = parsed.output;
    // `usage` is what distinguishes a usage chunk from a delta.
    if (!v.is(JsonObjectSchema, chunk.usage)) return line;
    const repaired = repairUsage(chunk.usage);
    if (!repaired) return line;
    return `data: ${JSON.stringify({ ...chunk, usage: repaired })}${crlf ? '\r' : ''}`;
  };

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(encoder.encode(`${repairLine(line)}\n`));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) controller.enqueue(encoder.encode(repairLine(buffer)));
    },
  });
}

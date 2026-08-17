/**
 * Cached-usage repair for Cloudflare AI SSE streams.
 *
 * The {account}/ai/v1 chat-completions stream carries usage TWICE: the model
 * runtime's own final chunk, then a platform-appended duplicate. For some
 * models the duplicate zeroes `prompt_tokens_details.cached_tokens` (verified
 * live 2026-07-13: @cf/zai-org/glm-5.2's model chunk reported
 * cached_tokens:14528 while the trailing duplicate said 0 — and account
 * billing confirmed the discounted cached rate was applied;
 * @cf/moonshotai/kimi-k2.6's duplicate is faithful). @ai-sdk/openai-compatible
 * keeps the LAST usage chunk it sees, so without repair every streamed step
 * reports cachedInputTokens:0 and prefix-cache efficacy is invisible to
 * per-turn accounting (`cacheRead: 0` on every run, which reads as a total
 * cache miss because a reported zero is evidence) — the cache itself works;
 * only the reporting is lost.
 *
 * Repair rule: within one response, `cached_tokens` cannot legitimately
 * decrease. Track the largest value seen; rewrite any later usage chunk that
 * reports less (or drops the field) to that maximum. Untouched lines pass
 * through byte-exactly and nothing is ever fabricated — a stream that only
 * ever reports 0 stays 0.
 */

import * as v from 'valibot';
import { tolerate } from '@proteus/core/obs';

const UsageChunkSchema = v.looseObject({
  usage: v.looseObject({
    prompt_tokens_details: v.looseObject({ cached_tokens: v.optional(v.number()) }),
  }),
});

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
 *  whose usage under-reports cached tokens, pass everything else through. */
function cachedUsageRepairTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let maxCached = 0;

  const repairLine = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const crlf = line.endsWith('\r');
    const payload = line.slice(5, crlf ? -1 : undefined).trim();
    if (!payload.startsWith('{')) return line; // e.g. "data: [DONE]"
    // A `data:` line that is not JSON is not a usage chunk, so it passes
    // through untouched like every other non-usage line. Any other failure is
    // real and must not become a silent skip of the repair.
    const decoded = tolerate<unknown>(() => JSON.parse(payload), 'malformed-input');
    const parsed = v.safeParse(UsageChunkSchema, decoded);
    if (!parsed.success) return line;
    const chunk = parsed.output;
    const details = chunk.usage.prompt_tokens_details;
    const cached = details.cached_tokens ?? 0;
    if (cached >= maxCached) {
      maxCached = cached;
      return line;
    }
    chunk.usage.prompt_tokens_details = { ...details, cached_tokens: maxCached };
    return `data: ${JSON.stringify(chunk)}${crlf ? '\r' : ''}`;
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

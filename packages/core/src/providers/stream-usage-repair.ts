/** Cloudflare AI SSE usage repair: the platform's trailing duplicate usage chunk zeroes or
 *  drops `cached_tokens`, and the AI SDK keeps the last one. */

import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { tolerate } from '../obs/index';

/** All optional: a dropped or nulled object is the shape needing repair. */
const UsageSchema = v.looseObject({
  prompt_tokens_details: v.nullish(v.looseObject({ cached_tokens: v.nullish(v.number()) })),
});

/** Per-response rule: `cached_tokens` cannot decrease, so restore later under-reports to
 *  the max seen; `undefined` means forward the original bytes. Feed every usage in order. */
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

    // No real cache read yet: never fabricate a report.
    if (maxCached === 0) return undefined;
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

/** Byte transform repairing `data:` usage lines; other lines pass through verbatim. */
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
    // Only a JSON parse failure passes through; other failures propagate.
    const decoded = tolerate<unknown>(() => JSON.parse(payload), 'malformed-input');
    const parsed = v.safeParse(JsonObjectSchema, decoded);

    if (!parsed.success) return line;
    const chunk = parsed.output;

    if (!v.is(JsonObjectSchema, chunk.usage)) return line;
    const repaired = repairUsage(chunk.usage);
    // The SDK chunk schema requires `choices`; error frames are never given one.
    const needsChoices = !('choices' in chunk) && !('error' in chunk);

    if (!repaired && !needsChoices) return line;

    const out: JsonObject = { ...chunk };

    if (repaired) out.usage = repaired;

    if (needsChoices) out.choices = [];

    return `data: ${JSON.stringify(out)}${crlf ? '\r' : ''}`;
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

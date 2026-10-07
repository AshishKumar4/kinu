/**
 * Cached-token usage, repaired per response: Cloudflare's trailing duplicate usage report zeroes or drops
 * `cached_tokens`, and a provider keeps the last report, so the finish carries the most any raw report said.
 */
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../../utils/json';

const CachedReportSchema = v.looseObject({
  usage: v.looseObject({
    prompt_tokens_details: v.looseObject({ cached_tokens: v.number() }),
  }),
});

/** Raw parts pass through: the retry layer measures silence on them and is the one that drops them. */
export function usageRepairMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params, type }) => (type === 'stream' ? { ...params, includeRawChunks: true } : params),
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let maxCached = 0;

      const repair = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          const report = part.type === 'raw' ? v.safeParse(CachedReportSchema, part.rawValue) : null;

          if (report?.success === true) maxCached = Math.max(maxCached, report.output.usage.prompt_tokens_details.cached_tokens);

          controller.enqueue(part.type === 'finish' ? { ...part, usage: withCacheRead(part.usage, maxCached) } : part);
        },
      });

      return { ...result, stream: result.stream.pipeThrough(repair) };
    },
  };
}

/** No real cache read seen: nothing is fabricated. The provider's own report is repaired too, since accounting reads
 *  which fields it carried. */
function withCacheRead(usage: LanguageModelV4Usage, cached: number): LanguageModelV4Usage {
  const { total, cacheRead } = usage.inputTokens;

  if (cached === 0 || (cacheRead ?? 0) >= cached) return usage;

  const repaired: LanguageModelV4Usage = {
    ...usage,
    inputTokens: { ...usage.inputTokens, cacheRead: cached, noCache: total === undefined ? undefined : Math.max(0, total - cached) },
  };

  if (usage.raw !== undefined) {
    const details = v.safeParse(JsonObjectSchema, usage.raw.prompt_tokens_details);
    const reported: JsonObject = details.success ? { ...details.output } : {};
    reported.cached_tokens = cached;
    repaired.raw = { ...usage.raw, prompt_tokens_details: reported };
  }

  return repaired;
}

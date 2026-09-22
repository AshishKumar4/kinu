/**
 * Static context-window table for callers that only have a model spec string.
 *
 * The provider catalog (ModelInfo.contextWindow, live from models.dev / the
 * Codex models endpoint) is the source of truth — prefer the reported window
 * when a resolved ModelInfo is available, as the CLI does
 * (`reportedContextWindow ?? contextWindowForModel(spec)`).
 *
 * EVERY ENTRY IS A FIGURE SOMEBODY READ OFF A PUBLISHED CATALOG, with the date
 * it was read. What the table answers for everything ELSE is a stand-in, and it
 * says so rather than returning a bare number: an unmatched spec used to come
 * back as 128,000 — indistinguishable from a measured 128,000 — and the
 * composition downstream (`modelOutputLimit ?? contextWindow`, then the half
 * split) turned that stand-in into a 64,000-token input allocation that refused
 * a 124,644-token request on a model whose real window is 1,048,576 (#20). A
 * stand-in may SIZE a budget, because something has to; it may never refuse a
 * request, and only a value that carries its own provenance can enforce that.
 */
const WINDOWS: Array<[RegExp, number]> = [
  [/minimax\/m3/i, 1_000_000],
  [/^codex\/gpt-5\.(?:5|4)\b/i, 272_000],
  [/^codex\/gpt-5\.3-codex-spark\b/i, 128_000],
  [/^codex\/gpt-5\.3-codex\b/i, 272_000],
  [/(^|\/)gpt-5\.5\b/i, 1_050_000],
  [/claude-(?:opus|sonnet)-4-[67]\b/i, 1_000_000],
  [/deepseek-v4-pro-0813/i, 1_048_576],
  // Per developers.cloudflare.com/workers-ai/models/glm-5.3 (read 2026-08-31):
  // 1M-token context, same as its 5.2 sibling.
  [/glm-5\.[23]/i, 1_048_576],
  [/kimi-k3/i, 1_048_576],
  [/kimi-k2/i, 262_144],
  [/llama-4/i, 131_072],
  // The Meta line this product's OpenCode routing serves. models.dev (read
  // 2026-09-22) reports limit.context 1_048_576 for muse-spark 1.1/1.2/1.3
  // under meta, opencode, opencode-go, openrouter and vercel alike; #20 was
  // reported on muse-spark-1.3, which matched nothing here and was sized at
  // 128k. Glimmer is the 30B sibling, 131_072 at every provider that lists it.
  [/muse-spark/i, 1_048_576],
  [/muse-glimmer/i, 131_072],
  [/qwen/i, 131_072],
  [/claude/i, 200_000],
  // Before the gpt-5 rule: Workers AI publishes 128k for both GPT-OSS sizes
  // (models.dev cloudflare-workers-ai, read 2026-09-22, and the offline catalog
  // in providers/workers-ai-catalog.ts), so answering 256k for them was a
  // number nobody measured.
  [/gpt-oss/i, 128_000],
  // models.dev nvidia + cloudflare-workers-ai, read 2026-09-22: the Nemotron 3
  // Super this account serves reports 256_000, and so does Gemma 4 on Workers
  // AI (Google's own endpoint publishes 262_144 for the same weights; the
  // smaller of two measurements is the one a budget is safe on).
  [/nemotron-3/i, 256_000],
  [/gemma-4/i, 256_000],
  [/gpt-5|\bo3\b/i, 256_000],
  [/gemini/i, 1_000_000],
  [/grok/i, 256_000],
];

/**
 * The window a spec is sized against, and whether anybody measured it.
 *
 * `measured: false` is not a hedge about the number's accuracy — it is the
 * statement that NO figure for this model exists here, and `window` is only the
 * table's stand-in so a caller that must produce a budget can. Admission reads
 * this field and declines to refuse a request it cannot prove too large.
 */
export type ContextWindowEstimate =
  | { readonly measured: true; readonly window: number }
  | { readonly measured: false; readonly window: number };

/** The stand-in: large enough that a normal conversation fits, small enough
 *  that compaction still triggers on a long one. Never a refusal's basis. */
const STANDIN_WINDOW = 128_000;

export function contextWindowForModel(spec: string): ContextWindowEstimate {
  for (const [re, n] of WINDOWS) if (re.test(spec)) return { measured: true, window: n };

  return { measured: false, window: STANDIN_WINDOW };
}

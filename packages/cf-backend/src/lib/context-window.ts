/**
 * Approximate context-window sizes (input tokens) per model family, used to
 * drive UTILIZATION-based compaction: compact when only ~15% of the window
 * remains (85% used), instead of a fixed token count that's wrong for every
 * model (262k Kimi vs 1M MiniMax vs 200k Claude). Pattern-matched on the model
 * spec (`provider/modelId`); conservative default for unknown models.
 */
const WINDOWS: Array<[RegExp, number]> = [
  [/minimax\/m3/i, 1_000_000],
  [/kimi-k2/i, 262_144],
  [/llama-4/i, 131_072],
  [/qwen/i, 131_072],
  [/claude/i, 200_000],
  [/gpt-5|gpt-oss|\bo3\b/i, 256_000],
  [/gemini/i, 1_000_000],
  [/grok/i, 256_000],
];
const DEFAULT_WINDOW = 128_000;

/** Best-effort context window (input tokens) for a model spec. */
export function contextWindowForModel(spec: string): number {
  for (const [re, n] of WINDOWS) if (re.test(spec)) return n;
  return DEFAULT_WINDOW;
}

/** Fraction of the window at which to trigger compaction (15% headroom left). */
export const COMPACT_AT_UTILIZATION = 0.85;

/** Token threshold that triggers compaction for a model — utilization-based. */
export function compactionThreshold(spec: string, utilization: number = COMPACT_AT_UTILIZATION): number {
  return Math.floor(contextWindowForModel(spec) * utilization);
}

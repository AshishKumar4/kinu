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

export function contextWindowForModel(spec: string): number {
  for (const [re, n] of WINDOWS) if (re.test(spec)) return n;
  return DEFAULT_WINDOW;
}

export const COMPACT_AT_UTILIZATION = 0.85;

export function compactionThreshold(spec: string, utilization: number = COMPACT_AT_UTILIZATION): number {
  return Math.floor(contextWindowForModel(spec) * utilization);
}

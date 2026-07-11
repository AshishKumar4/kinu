/**
 * Static context-window FALLBACK for callers that only have a model spec
 * string. The provider catalog (ModelInfo.contextWindow, live from
 * models.dev / the Codex models endpoint) is the source of truth — prefer
 * the reported window when a resolved ModelInfo is available, as the CLI
 * does (`reportedContextWindow ?? contextWindowForModel(spec)`).
 */
const WINDOWS: Array<[RegExp, number]> = [
  [/minimax\/m3/i, 1_000_000],
  [/^codex\/gpt-5\.(?:5|4)\b/i, 272_000],
  [/^codex\/gpt-5\.3-codex-spark\b/i, 128_000],
  [/^codex\/gpt-5\.3-codex\b/i, 272_000],
  [/(^|\/)gpt-5\.5\b/i, 1_050_000],
  [/claude-(?:opus|sonnet)-4-[67]\b/i, 1_000_000],
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

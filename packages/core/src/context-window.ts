/**
 * Static context-window table for callers with only a spec string; prefer ModelInfo.contextWindow when resolved.
 * Entries are read off published catalogs; anything unmatched is a stand-in that may size a budget but never refuse a request (#20).
 */
import { specWithoutAccount } from './providers/types';

const WINDOWS: Array<[RegExp, number]> = [
  [/minimax\/m3/i, 1_000_000],
  [/^codex\/gpt-5\.(?:5|4)\b/i, 272_000],
  [/^codex\/gpt-5\.3-codex-spark\b/i, 128_000],
  [/^codex\/gpt-5\.3-codex\b/i, 272_000],
  [/(^|\/)gpt-5\.5\b/i, 1_050_000],
  [/claude-(?:opus|sonnet)-4-[67]\b/i, 1_000_000],
  [/deepseek-v4-pro-0813/i, 1_048_576],
  // developers.cloudflare.com/workers-ai/models/glm-5.3 (read 2026-08-31): 1M-token context.
  [/glm-5\.[23]/i, 1_048_576],
  [/kimi-k3/i, 1_048_576],
  [/kimi-k2/i, 262_144],
  [/llama-4/i, 131_072],
  // models.dev (read 2026-09-22): muse-spark 1.1-1.3 report 1_048_576 at every provider; glimmer 131_072.
  [/muse-spark/i, 1_048_576],
  [/muse-glimmer/i, 131_072],
  [/qwen/i, 131_072],
  [/claude/i, 200_000],
  // Must precede the gpt-5 rule: Workers AI publishes 128k for both GPT-OSS sizes (models.dev, read 2026-09-22).
  [/gpt-oss/i, 128_000],
  // models.dev, read 2026-09-22: Nemotron 3 Super and Gemma 4 on Workers AI report 256_000 (smaller of two measurements).
  [/nemotron-3/i, 256_000],
  [/gemma-4/i, 256_000],
  [/gpt-5|\bo3\b/i, 256_000],
  [/gemini/i, 1_000_000],
  [/grok/i, 256_000],
];

/** `measured: false` means no figure exists for the model; admission never refuses a request on that stand-in. */
export type ContextWindowEstimate =
  | { readonly measured: true; readonly window: number }
  | { readonly measured: false; readonly window: number };

/** Large enough for a normal conversation, small enough that compaction triggers on a long one. */
const STANDIN_WINDOW = 128_000;

export function contextWindowForModel(spec: string): ContextWindowEstimate {
  const listed = specWithoutAccount(spec);

  for (const [re, n] of WINDOWS) if (re.test(listed)) return { measured: true, window: n };

  return { measured: false, window: STANDIN_WINDOW };
}

/**
 * `modelOutputLimit` is the catalog maximum only (no caller sets an output cap),
 * a share of `contextWindow`. `null` means unreported, which reserves nothing.
 */
export interface ModelWindow {
  readonly contextWindow: number;
  readonly modelOutputLimit: number | null;
}

/** `windowMeasured: false` marks a static-table stand-in. Budgets may spend it;
 * the refusal in orchestrator/turn-context.ts may not. */
export interface ResolvedModelWindow extends ModelWindow {
  readonly windowMeasured: boolean;
}

/**
 * Tokens held back for the answer: its reported maximum, bounded by half the
 * window (a published maximum can equal the whole window and admit no input).
 * An unreported maximum reserves nothing; the provider bounds the answer anyway.
 */
export function outputReserveTokens(limits: ModelWindow): number {
  if (limits.modelOutputLimit === null) return 0;
  const window = Math.max(0, Math.floor(limits.contextWindow));
  const answer = Math.max(0, Math.floor(limits.modelOutputLimit));

  return Math.min(answer, Math.floor(window / 2));
}

/**
 * Tokens one step's request may occupy: the one allocation every request-bound
 * producer divides. Exported so MCP catalog admission (`tools/mcp-surface.ts`)
 * subtracts from it instead of taking a second share.
 */
export function stepContextLimit(limits: ModelWindow): number {
  return Math.max(0, Math.floor(limits.contextWindow)) - outputReserveTokens(limits);
}

/**
 * A model's window, from its provider's catalog row only (a custom endpoint's declared window is such a row). With no
 * row naming one the window is unknown, and nothing is sized, triggered or refused by it.
 */
/**
 * `contextWindow` null: unknown. `modelOutputLimit` is the catalog maximum only (no caller sets an output cap), a share
 * of `contextWindow`; null means unreported, which reserves nothing.
 */
export interface ModelWindow {
  readonly contextWindow: number | null;
  readonly modelOutputLimit: number | null;
}

/** The one reader of a model's window: its catalog row. */
export function modelWindow(info: { readonly contextWindow?: number | null; readonly modelOutputLimit?: number | null } | null | undefined): ModelWindow {
  return { contextWindow: info?.contextWindow ?? null, modelOutputLimit: info?.modelOutputLimit ?? null };
}

/**
 * Tokens held back for the answer: its reported maximum, bounded by half the
 * window (a published maximum can equal the whole window and admit no input).
 * An unreported maximum reserves nothing; the provider bounds the answer anyway.
 */
export function outputReserveTokens(limits: ModelWindow): number {
  if (limits.contextWindow === null || limits.modelOutputLimit === null) return 0;
  const window = Math.max(0, Math.floor(limits.contextWindow));
  const answer = Math.max(0, Math.floor(limits.modelOutputLimit));

  return Math.min(answer, Math.floor(window / 2));
}

/**
 * Tokens one step's request may occupy: the one allocation every request-bound
 * producer divides. Unbounded for an unknown window, so nothing is trimmed,
 * deferred or refused by it. Exported so MCP catalog admission (`tools/mcp-surface.ts`)
 * subtracts from it instead of taking a second share.
 */
export function stepContextLimit(limits: ModelWindow): number {
  if (limits.contextWindow === null) return Number.POSITIVE_INFINITY;

  return Math.max(0, Math.floor(limits.contextWindow)) - outputReserveTokens(limits);
}

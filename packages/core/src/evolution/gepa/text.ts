/**
 * Small text helpers shared by the GEPA mutate + merge operators —
 * fence-stripping for LM output and prompt truncation. Single source so the
 * two operators can't drift.
 */

/** Strip leading/trailing markdown fences the LM tends to add despite the
 *  prompt explicitly asking it not to. */
export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

/** Truncate to `n` chars with a visible marker. Used in prompt rendering to
 *  bound context size. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '... [truncated]';
}

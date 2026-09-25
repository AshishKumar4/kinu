// Head-and-tail evidence policy every evolution-loop reader shares. DEFAULT_SHADOW_CONFIG was calibrated on
// head-only slices (scripts/shadow-veto-monte-carlo.ts); re-run it before changing the promotion rule.

import type { ToolSet, TypedToolResult } from 'ai';
import * as v from 'valibot';
import { renderThrownChain } from '../obs/index';
import { EVIDENCE_BUDGETS } from '../types/evidence';

export { EVIDENCE_BUDGETS } from '../types/evidence';

/** Even split: the framing is at the start and the judged outcome at the end. */
const HEAD_FRACTION = 0.5;

/** Keeps both ends and names what was dropped; text within budget passes through byte-identical. */
export function evidenceWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) throw new Error(`evidence budget must be positive, got ${maxChars}`);

  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * HEAD_FRACTION);
  const tailLen = maxChars - headLen;
  const omitted = text.length - headLen - tailLen;

  return `${text.slice(0, headLen)}\n[... ${omitted} chars omitted from the middle ...]\n${text.slice(-tailLen)}`;
}

/** Renders a tool result for trajectory/trace/fallback; objects serialize as JSON, never "[object Object]". */
export function renderToolResult(raw: TypedToolResult<ToolSet>['output']): string {
  const text = v.safeParse(v.string(), raw);

  if (text.success) return text.output;

  if (raw == null) return '';

  try { return JSON.stringify(raw) ?? String(raw); }
  catch (error) {
    return `unserializable value: ${renderThrownChain({ cause: error })}`;
  }
}

/** Turn text when a turn ends on tool calls with no prose; shared by streaming and generateText paths. */
export function synthesizeToolFallback(
  steps: ReadonlyArray<{
    readonly toolResults: ReadonlyArray<{
      readonly toolName: string;
      readonly output: TypedToolResult<ToolSet>['output'];
    }>;
  }>,
): string {
  const lines: string[] = [];

  for (const step of steps) {
    for (const result of step.toolResults) {
      lines.push(`[${result.toolName}] ${evidenceWindow(renderToolResult(result.output), EVIDENCE_BUDGETS.toolFallbackSummary)}`);
    }
  }

  return lines.join('\n');
}

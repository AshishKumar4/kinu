// Head-and-tail evidence policy every evolution-loop reader shares.

import type { ToolSet, TypedToolResult } from 'ai';
import * as v from 'valibot';
import { Effect } from 'effect';
import { renderThrownChain, settleSync } from '../obs/index';
import { headEnd, tailStart } from './text';

export { EVIDENCE_BUDGETS } from '../types/evidence';

/** Even split: the framing is at the start and the judged outcome at the end. */
const HEAD_FRACTION = 0.5;

/** Keeps both ends and names what was dropped; text within budget passes through byte-identical. */
export function evidenceWindow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Neither cut splits a surrogate pair: each moves at most one unit inward, and the count names what was cut.
  const head = text.slice(0, headEnd(text, Math.floor(maxChars * HEAD_FRACTION)));
  const tail = text.slice(tailStart(text, maxChars - Math.floor(maxChars * HEAD_FRACTION)));
  const omitted = text.length - head.length - tail.length;

  return `${head}\n[... ${omitted} chars omitted from the middle ...]\n${tail}`;
}

/** Renders a tool result for a trajectory or a trace; objects serialize as JSON, never "[object Object]". */
export function renderToolResult(raw: TypedToolResult<ToolSet>['output']): string {
  const text = v.safeParse(v.string(), raw);

  if (text.success) return text.output;

  if (raw == null) return '';

  return settleSync(Effect.try({ try: () => JSON.stringify(raw) ?? String(raw), catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => Effect.succeed(`unserializable value: ${renderThrownChain(failed)}`)),
  ));
}

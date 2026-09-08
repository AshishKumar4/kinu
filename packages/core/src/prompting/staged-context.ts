/**
 * When a staged context edit becomes the request — and what it may not drop.
 *
 * A mid-turn edit does not rewrite the array a step is already being issued
 * with: it stages a later revision (`orchestrator/actor-claims.ts`), and this
 * module decides whether the step about to be composed is a boundary that
 * revision may land on.
 *
 * TWO THINGS THE EDIT CANNOT TAKE WITH IT:
 *
 *  • THE PROTECTED TAIL. The live array at a step boundary is the edited base
 *    plus whatever the turn produced since: the assistant message that made the
 *    tool calls, their results, and any steer that landed. Those are records of
 *    work that already happened, so the staged revision replaces the base and
 *    the tail is re-appended after it. An edit cannot un-happen a tool call.
 *
 *  • THE PAIRING INVARIANT. If that tail holds a tool call whose result has not
 *    arrived, this is not a boundary: substituting history underneath a
 *    half-finished exchange is how a turn reaches `AI_MissingToolResultsError`
 *    and stops being usable (`prompting/interrupted-tool-calls.ts` documents the
 *    same invariant for turn assembly). The edit stays staged for the next step,
 *    which is what "next safe step" means.
 */

import type { ModelMessage } from 'ai';

/** The tool-call ids a message array leaves unanswered — an assistant call with
 *  no later tool result. Empty means every call in the array is settled. */
function unpairedToolCalls(messages: readonly ModelMessage[]): Set<string> {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'tool-call') open.add(part.toolCallId);
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'tool-result') open.delete(part.toolCallId);
    }
  }
  return open;
}

/** What a staged revision needs to be applied: the edited array and how long the
 *  revision it was staged from was, which is where the protected tail starts. */
export interface StagedContextEdit {
  readonly messages: readonly ModelMessage[];
  readonly baseMessageCount: number;
}

/**
 * The array a step consumes once a staged edit lands, or null when this step is
 * not a safe boundary for it.
 *
 * Null is a deferral, not a failure: the caller composes the step from the live
 * array and the staged revision waits. The two null arms are the honest ones —
 * a live array SHORTER than the base the edit was staged against is not a tail
 * this function can identify (the history was rewritten underneath the edit, so
 * the edit's base no longer exists), and an unsettled tool call is a boundary
 * the invariant above forbids.
 */
export function applyStagedContext(
  live: readonly ModelMessage[],
  edit: StagedContextEdit,
): ModelMessage[] | null {
  if (live.length < edit.baseMessageCount) return null;
  const tail = live.slice(edit.baseMessageCount);
  if (unpairedToolCalls(tail).size > 0) return null;
  return [...edit.messages, ...tail];
}

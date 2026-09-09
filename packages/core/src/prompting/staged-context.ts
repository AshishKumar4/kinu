/**
 * When an edited working history becomes the request — and what it may not drop.
 *
 * An edit does not rewrite the array a step is already being issued with: it is
 * staged as a later working revision (`orchestrator/working-context.ts`), and
 * this module decides whether the step about to be composed may take it.
 *
 * THE COORDINATE. `baseMessageCount` is a count in the RAW working array, taken
 * from the revision the edit was authored against — never from a rendered
 * request. A rendered array has been pruned and woven, so its length differs
 * from the raw one by however many `<dynamic_context>` blocks the ledger froze
 * and however many tool outputs the pruner shrank away. Slicing the live raw
 * array at a rendered count is the defect this file's caller used to have: the
 * protected tail then started in the wrong place, and the turn either re-sent
 * the tool call it had already made or dropped it.
 *
 * TWO THINGS AN EDIT CANNOT TAKE WITH IT:
 *
 *  • THE PROTECTED TAIL. The live array at a boundary is the edited base plus
 *    whatever the turn produced since: the assistant message that made the tool
 *    calls, their results, and any steer or user input that landed. Those are
 *    records of work that already happened, so the revision replaces the base
 *    and the tail is re-appended after it, exactly once. An edit cannot un-happen
 *    a tool call, and it cannot double-append one either.
 *
 *  • THE PAIRING INVARIANT. If that tail holds a tool call whose result has not
 *    arrived, this is not a boundary: substituting history underneath a
 *    half-finished exchange is how a turn reaches `AI_MissingToolResultsError`
 *    and stops being usable (`prompting/interrupted-tool-calls.ts` documents the
 *    same invariant for turn assembly). The revision stays staged and the
 *    deferral is reported with its reason, which is what "next safe step" means.
 *
 * ONE ASYMMETRY, DELIBERATE. The pairing gate applies to a PENDING revision —
 * the first boundary that would make it effective. A revision that is already
 * the actor's working history is re-applied at every later step of the turn
 * without that gate, because the alternative is worse: skipping it would send
 * the pre-edit prefix again, which is the history rewrite this module exists to
 * prevent, and the tail rides through untouched either way.
 */

import type { ModelMessage } from 'ai';

/** Why a boundary could not take a pending revision. */
export const STAGED_CONTEXT_DEFERRALS = ['unpaired_tool_call', 'history_rewritten'] as const;
export type StagedContextDeferral = (typeof STAGED_CONTEXT_DEFERRALS)[number];

/** The working base a step renders from: the array, and where the material it
 *  does not own begins in the live array. */
export interface StagedContextEdit {
  readonly messages: readonly ModelMessage[];
  readonly baseMessageCount: number;
  /** True while this revision has not been activated yet — this boundary is its
   *  landing, so the pairing gate applies and frozen ledger positions move. */
  readonly pending: boolean;
}

export type StagedContextOutcome =
  | { readonly kind: 'landed'; readonly messages: ModelMessage[] }
  | { readonly kind: 'deferred'; readonly reason: StagedContextDeferral };

/**
 * The tool-call ids a message array leaves unanswered — an assistant call with
 * no later tool result. Empty means every call in the array is settled.
 *
 * Exported because the `/context` write path validates an INCOMING edited array
 * with the same rule it enforces on landing: an edit that itself severs a call
 * from its result is refused at the write, not discovered at the next step.
 */
export function unpairedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
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

/**
 * The array a step consumes once the working base is applied, or the deferral
 * that keeps a pending revision staged.
 *
 * `history_rewritten` is the honest arm for a live array SHORTER than the base
 * the revision was authored against: the tail this function would preserve is
 * not identifiable, because the history the edit named no longer exists. It
 * defers rather than guessing; the caller decides whether that is temporary (a
 * step boundary) or terminal (a turn boundary, where the base is gone for good).
 */
export function applyStagedContext(
  live: readonly ModelMessage[],
  edit: StagedContextEdit,
): StagedContextOutcome {
  if (live.length < edit.baseMessageCount) return { kind: 'deferred', reason: 'history_rewritten' };
  const tail = live.slice(edit.baseMessageCount);
  if (edit.pending && unpairedToolCallIds(tail).size > 0) {
    return { kind: 'deferred', reason: 'unpaired_tool_call' };
  }
  return { kind: 'landed', messages: [...edit.messages, ...tail] };
}

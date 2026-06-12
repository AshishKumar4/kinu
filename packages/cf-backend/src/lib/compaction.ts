/**
 * Proteus compaction function for the agents-SDK Session seam.
 *
 * Same skeleton as the SDK's reference `createCompactFunction` (protect head,
 * protect a recent token-budget tail, align boundaries to tool-call groups),
 * with the two Proteus policies layered in:
 *
 *  1. Pre-compaction prune: the middle being summarized passes through the
 *     SDK's `truncateOlderMessages` (keepRecent: 0 → every middle message)
 *     so old tool outputs shrink to one-liners BEFORE the summarizer call —
 *     the protected tail is never touched.
 *  2. Content spec: the summarizer prompt is core's structured handoff
 *     template (Active Task verbatim → Remaining Work, recall-first,
 *     secret-redaction, iterative updates), and the stored summary is
 *     wrapped in the [CONTEXT CHECKPOINT] preamble so the successor builds
 *     on prior work instead of redoing it.
 */

import {
  alignBoundaryForward,
  findTailCutByTokens,
  isCompactionMessage,
  computeSummaryBudget,
  truncateOlderMessages,
  type CompactResult,
} from 'agents/experimental/memory/utils';
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session';
import {
  buildCompactionSummaryPrompt,
  renderCompactionTranscript,
  wrapCompactionSummary,
  stripCheckpointPreamble,
} from '@proteus/core';

export interface ProteusCompactOptions {
  /** Calls the LLM with the summarizer prompt; returns the summary body. */
  summarize: (prompt: string) => Promise<string>;
  /** Head messages always protected (default 3 — SDK parity). */
  protectHead?: number;
  /** Recent-tail token budget never compacted (default 40k — the OpenCode
   *  recent-context bar, double the SDK default). */
  tailTokenBudget?: number;
  /** Minimum tail messages protected regardless of tokens (default 2). */
  minTailMessages?: number;
}

function messageText(msg: SessionMessage): string {
  return msg.parts
    .filter((p: SessionMessagePart) => p.type === 'text' && typeof p.text === 'string')
    .map((p: SessionMessagePart) => p.text)
    .join('\n');
}

/** The most recent real user request across the FULL history — including the
 *  protected tail, so the summary's Active Task is the live one. */
function latestUserAsk(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || isCompactionMessage(msg)) continue;
    const text = messageText(msg).trim();
    if (text) return text;
  }
  return undefined;
}

export function createProteusCompactFunction(opts: ProteusCompactOptions) {
  const protectHead = opts.protectHead ?? 3;
  const tailTokenBudget = opts.tailTokenBudget ?? 40_000;
  const minTailMessages = opts.minTailMessages ?? 2;

  return async (messages: SessionMessage[]): Promise<CompactResult | null> => {
    if (messages.length <= protectHead + minTailMessages) return null;

    // 1. Boundaries: protected head, token-budget tail, tool-group aligned.
    const compressStart = alignBoundaryForward(messages, protectHead);
    const compressEnd = findTailCutByTokens(messages, compressStart, tailTokenBudget, minTailMessages);
    if (compressEnd <= compressStart) return null;

    // Compaction overlays carry virtual ids — exclude them from the range.
    const middle = messages
      .slice(compressStart, compressEnd)
      .filter((m) => !isCompactionMessage(m));
    if (middle.length === 0) return null;

    // 2. Prune old tool outputs / oversize text before the summarizer sees
    //    them (keepRecent: 0 — the recent tail is already outside `middle`).
    const pruned = truncateOlderMessages(middle, { keepRecent: 0 });

    // 3. Iterative update: recover the previous summary body from the
    //    existing overlay, preamble stripped.
    const existing = messages.find(isCompactionMessage);
    const previousSummary = existing ? stripCheckpointPreamble(messageText(existing)) : null;

    const prompt = buildCompactionSummaryPrompt({
      transcript: renderCompactionTranscript(pruned),
      latestUserAsk: latestUserAsk(messages),
      previousSummary,
      budgetTokens: computeSummaryBudget(pruned),
    });
    const summary = await opts.summarize(prompt);
    if (!summary.trim()) return null;

    return {
      fromMessageId: middle[0].id,
      toMessageId: middle[middle.length - 1].id,
      summary: wrapCompactionSummary(summary),
    };
  };
}

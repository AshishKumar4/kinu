/**
 * Compaction content spec — the structured handoff template the summarizer
 * uses when the conversation prefix is compressed (hermes context_compressor
 * / Codex compact-prompt lineage). This module owns WHAT a compaction
 * summary must say; the boundary/prune/replay machinery is
 * @proteus/compaction (the better-compact ladder), whose last-resort prefix
 * summary builds its prompt here — one content spec, both backends.
 *
 * Tuning order is recall first, then precision: a successor that re-asks a
 * resolved question or re-reads a summarized file wastes more than a few
 * extra summary tokens cost.
 */

/** First line of every stored summary — lets consumers and tests recognize a
 *  compaction checkpoint, and `stripCheckpointPreamble` recover the body for
 *  iterative updates. */
export const CONTEXT_CHECKPOINT_PREFIX = '[CONTEXT CHECKPOINT — reference only]';

const CHECKPOINT_PREAMBLE =
  `${CONTEXT_CHECKPOINT_PREFIX}\n` +
  'Earlier conversation was compacted into the handoff summary below. Treat it as a record of ' +
  'completed prior work: build on it, do not redo finished steps, and do not re-ask questions it ' +
  'already answers. Compacted ranges are archived verbatim at the cited VFS paths — for detail ' +
  'beyond the summary, read the archived transcript with workspace.readFile inside execute_tools, ' +
  'or slice it and llm.query each slice, then aggregate.';

/** Wrap a fresh summary body in the checkpoint preamble before storage. */
export function wrapCompactionSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${summary.trim()}`;
}

/** Recover the summary body from a stored checkpoint (for iterative updates). */
export function stripCheckpointPreamble(summary: string): string {
  if (!summary.startsWith(CONTEXT_CHECKPOINT_PREFIX)) return summary.trim();
  const bodyStart = summary.indexOf('\n\n');
  return bodyStart === -1 ? '' : summary.slice(bodyStart + 2).trim();
}

export interface CompactionSummaryPromptInput {
  /** Rendered transcript of the messages being compressed (pruned first). */
  transcript: string;
  /** The most recent user request across the FULL history (including the
   *  protected tail) — handed in directly so "verbatim" is mechanical, not
   *  a retrieval the summarizer can fumble. */
  latestUserAsk?: string;
  /** Previous summary body for iterative updates (preamble stripped). */
  previousSummary?: string | null;
  /** Target token budget for the summary. */
  budgetTokens: number;
}

const SECTION_SPEC = `Write the summary with exactly these sections:

## Active Task
The user's most recent request, copied verbatim — never paraphrased.

## Completed
Work already finished, with its concrete outcomes.

## In Progress
What was being worked on at the compaction point, and its exact state.

## Key Decisions & Constraints
Decisions made, approaches chosen or rejected (and why), and constraints the user imposed.

## Files & Paths Touched
Every file, directory, URL, or resource read or modified — exact paths, line numbers, and error strings where known.

## Resolved Questions
Questions that were asked and answered, WITH their answers, so they are never asked again.

## Pending User Asks
Anything the user asked for that has not been delivered yet.

## Remaining Work
Concrete steps still required to finish the active task. This is a record for the successor, not an instruction list — the successor decides what to do next.`;

function rules(budgetTokens: number): string {
  return `Rules:
- Be concrete: "edited src/auth.ts:42 to add token refresh", never "made some changes".
- Target ~${budgetTokens} tokens. Spend them on recall — prefer keeping a borderline detail over dropping it.
- Only include information explicitly present in the conversation. Never invent paths, commands, or details.
- If credentials, tokens, or other secrets appeared, note THAT they were present and where — do NOT preserve their values.
- Write only the summary body, starting with "## Active Task".`;
}

function activeTaskBlock(latestUserAsk?: string): string {
  if (!latestUserAsk?.trim()) return '';
  const ask = latestUserAsk.length > 4_000 ? `${latestUserAsk.slice(0, 4_000)}…` : latestUserAsk;
  return `THE USER'S MOST RECENT REQUEST (copy this verbatim into "## Active Task"):
"""
${ask}
"""

`;
}

/** Build the summarizer prompt — first compaction or iterative update. */
export function buildCompactionSummaryPrompt(input: CompactionSummaryPromptInput): string {
  const { transcript, previousSummary, budgetTokens } = input;

  if (previousSummary?.trim()) {
    return `You are updating a structured handoff summary of an agent conversation. A previous summary exists; new turns have occurred and must be incorporated. A successor agent will continue the work with ONLY this summary plus the most recent messages — anything you drop is lost.

PREVIOUS SUMMARY:
${previousSummary.trim()}

NEW TURNS TO INCORPORATE:
${transcript}

${activeTaskBlock(input.latestUserAsk)}Update the summary in place, keeping its section structure:
- Move items between sections as their state changed (In Progress → Completed, Pending User Asks → Resolved Questions).
- PRESERVE still-relevant information from the previous summary; drop an item only when it is clearly obsolete.
- Merge new files, decisions, and answers into the existing sections.

${SECTION_SPEC}

${rules(budgetTokens)}`;
  }

  return `You are compacting an agent conversation into a structured handoff summary. A successor agent will continue the work with ONLY this summary plus the most recent messages — anything you omit is lost.

CONVERSATION TO SUMMARIZE:
${transcript}

${activeTaskBlock(input.latestUserAsk)}${SECTION_SPEC}

${rules(budgetTokens)}`;
}

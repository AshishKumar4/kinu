/**
 * The facet inherited-context digest — what a spawned head (or a steer
 * branch) sees of its parent conversation. Shared by both backends; the
 * Alternate-Takes capture lives with the takes store (mcts/takes.ts
 * recordGroundedHeadsTake).
 *
 * The per-message window is applied HERE, at read time, as the digest is
 * built — not later at render time. A root materialises up to
 * INHERITED_CONTEXT_CAP stored bodies, each of which may run to
 * EVIDENCE_BUDGETS.storedAssistantResponse (16,000 chars), and that array is
 * copied into every spawned head's HeadInput and crosses a Durable Object RPC
 * boundary once per head. Windowing after those copies exist bounds the prompt
 * but not the memory, so the cap lives at the read and nowhere else.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { SerializedMessage } from '../heads/types';
import type { SplitPhaseEvent } from '../heads/controller';
import type { RunEventInput } from '../events/types';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

/** The parent-conversation cap handed to each spawned head — bounds head LLM
 *  context over long sessions. */
export const INHERITED_CONTEXT_CAP = 50;

/** Narrow an arbitrary stored role to the SerializedMessage union (anything
 *  unrecognized reads as assistant output). */
export function narrowInheritedRole(role: string): SerializedMessage['role'] {
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool'
    ? role
    : 'assistant';
}

/** Serialize message content for head inheritance. File-part payloads (data
 *  URLs from attachments) are reduced to their filename/mediaType reference so
 *  spawned heads never inherit megabytes of base64. */
export function serializeContentForHeads(content: ModelMessage['content']): string {
  const text = v.safeParse(v.string(), content);
  if (text.success) return text.output;
  if (Array.isArray(content)) {
    return JSON.stringify(content.map((part) =>
      part.type === 'file'
        ? { type: 'file', mediaType: part.mediaType, filename: part.filename }
        : part));
  }
  return JSON.stringify(content);
}

/**
 * A split's lifecycle as one durable run-event row.
 *
 * Both backends fan the same phase event to two places — the live broadcast
 * their frontends render the branch timeline from, and the run-event ledger
 * that outlives the process. Which fields a row carries is the thing worth
 * having once: the cost summary gained `headsWithFindings` for a reason, and
 * a backend that transcribed the row itself simply would not have it.
 */
export function headPhaseRunEvent(event: SplitPhaseEvent): RunEventInput {
  if (event.kind === 'split') {
    return { type: 'head_split', rootId: event.rootId, headIds: [...event.headIds], rationale: event.rationale };
  }
  const merge: Extract<RunEventInput, { type: 'head_merge' }> = {
    type: 'head_merge',
    rootId: event.rootId,
    headCount: event.cost.headCount,
    headsWithFindings: event.cost.headsWithFindings,
    mergedNarrative: event.mergedNarrative,
    fileChanges: [...event.fileChanges],
    blindSpots: [...event.blindSpots],
  };
  // Absent when no head in the split reported usage — an unmeasured split is
  // not a free one.
  if (event.cost.totalTokens !== undefined) merge.totalTokens = event.cost.totalTokens;
  return merge;
}

/** Stored conversation rows as inherited context (the cf backend's source: it
 *  digests durable message rows, having already decoded each row's text). */
export function inheritedContextFromRows(
  rows: ReadonlyArray<{ id: string; role: string; content: string; createdAt: number }>,
  total: number,
): SerializedMessage[] {
  return [
    ...inheritedContextOmissionNote(total, rows.length),
    ...rows.map((r) => ({
      id: r.id,
      role: narrowInheritedRole(r.role),
      content: evidenceWindow(r.content, EVIDENCE_BUDGETS.inheritedMessage),
      createdAt: r.createdAt,
    })),
  ];
}

/** The recent live conversation as inherited context (the CLI's source; the
 *  cf backend digests its durable assistant_messages rows instead). */
export function inheritedContextFromHistory(
  history: readonly ModelMessage[],
  cap: number = INHERITED_CONTEXT_CAP,
): SerializedMessage[] {
  const kept = history.slice(-cap).map((m, i) => ({
    id: `ctx-${i}`,
    role: narrowInheritedRole(m.role),
    content: evidenceWindow(serializeContentForHeads(m.content), EVIDENCE_BUDGETS.inheritedMessage),
    createdAt: i,
  }));
  return [...inheritedContextOmissionNote(history.length, kept.length), ...kept];
}

/** The disclosure entry a capped inheritance leads with — a head must be able
 *  to tell its view is a window, or it treats the window as the whole story. */
export function inheritedContextOmissionNote(total: number, kept: number): SerializedMessage[] {
  if (total <= kept) return [];
  return [{
    id: 'ctx-omitted',
    role: 'system',
    content: `(${total - kept} earlier messages omitted from inherited context — durable state lives in the workspace files)`,
    createdAt: -1,
  }];
}

/**
 * The facet inherited-context digest — what a spawned head (or a steer
 * branch) sees of its parent conversation. Shared by both backends. Kept
 * dependency-pure (types only) so the layer gate can own it as a subject
 * module; the Alternate-Takes capture lives with the takes store
 * (mcts/takes.ts recordGroundedHeadsTake).
 */

import type { ModelMessage } from 'ai';
import type { SerializedMessage } from '../heads/types.js';

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
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return JSON.stringify(content.map((part) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'file'
        ? { type: 'file', mediaType: part.mediaType, filename: part.filename }
        : part));
  }
  return JSON.stringify(content);
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
    content: serializeContentForHeads(m.content),
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

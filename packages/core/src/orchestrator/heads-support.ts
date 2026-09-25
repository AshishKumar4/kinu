/**
 * Inherited-context digest a spawned head or steer branch sees of its parent.
 * The per-message window applies at read time: the digest is copied into every head's input,
 * so windowing later bounds the prompt but not the memory.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { SerializedMessage } from '../heads/types';
import type { SessionTranscriptReader } from '../session/transcript';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';

const INHERITED_CONTEXT_CAP = 50;

/** Detach a delegation's birth-time conversation from its parent's live turn. */
export function freezeInheritedContext<T>(messages: readonly T[]): readonly T[] {
  return Object.freeze(structuredClone([...messages]));
}

/** Unrecognized roles read as assistant output. */
export function narrowInheritedRole(role: string): SerializedMessage['role'] {
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool'
    ? role
    : 'assistant';
}

/** File parts reduce to filename/mediaType so heads never inherit base64 payloads. */
export function serializeContentForHeads(content: ModelMessage['content']): string {
  const text = v.safeParse(v.string(), content);

  if (text.success) return text.output;

  if (Array.isArray(content)) {
    if (content.every((part) => part.type === 'text')) return content.map((part) => part.text).join('');

    return JSON.stringify(content.map((part) =>
      part.type === 'file'
        ? { type: 'file', mediaType: part.mediaType, filename: part.filename }
        : part));
  }

  return JSON.stringify(content);
}

/** The frozen origin a hire is born with; the root's own inheritance reads the transcript. */
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

/** Both backends hand a hire the same window: the newest entries of the leaf's ancestry. */
export async function inheritedContextFromTranscript(transcript: SessionTranscriptReader): Promise<SerializedMessage[]> {
  const kept: SerializedMessage[] = [];

  for (const entry of transcript.ancestry(transcript.newestId(), INHERITED_CONTEXT_CAP)) {
    const projected = await transcript.project(entry.id);

    if (projected !== null) kept.push({ id: entry.id, role: narrowInheritedRole(entry.role), content: evidenceWindow(projected.content, EVIDENCE_BUDGETS.inheritedMessage), createdAt: entry.recordedAt });
  }

  return [...inheritedContextOmissionNote(transcript.count(), kept.length), ...kept];
}

/** A head must be able to tell its view is a window. */
export function inheritedContextOmissionNote(total: number, kept: number): SerializedMessage[] {
  if (total <= kept) return [];

  return [{
    id: 'ctx-omitted',
    role: 'system',
    content: `(${total - kept} earlier messages omitted from inherited context — durable state lives in the workspace files)`,
    createdAt: -1,
  }];
}

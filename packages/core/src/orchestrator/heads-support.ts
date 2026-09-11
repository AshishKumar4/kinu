/**
 * The facet inherited-context digest — what a spawned head (or a steer
 * branch) sees of its parent conversation. Shared by both backends.
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
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
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

/**
 * The recent durable conversation of one actor as inherited context, off the
 * plain `messages` store.
 *
 * The SAME cap and the SAME disclosure the cloud backend's row digest applies:
 * the newest {@link INHERITED_CONTEXT_CAP} user/assistant rows of the session,
 * and a count over the same predicate so a hire is told how much of the
 * conversation it was not handed. A reader that windowed to its own literal
 * and digested the window as if it were the whole history handed every local
 * hire sixteen messages and no note that the rest existed.
 */
export function inheritedContextFromConversation(
  sql: SqlExecutor, actor: ActorHandle, sessionId: string,
): SerializedMessage[] {
  actor.assertCurrent();

  type Row = { id: string; role: string; content: string; created_at: number };

  const rows = sql<Row>`
    SELECT id, role, content, created_at
    FROM (
      SELECT id, role, content, created_at, rowid AS seq FROM messages
      WHERE actor_id = ${actor.actorId} AND session_id = ${sessionId}
        AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${INHERITED_CONTEXT_CAP}
    ) tail
    ORDER BY created_at ASC, seq ASC`;

  const total = sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages
    WHERE actor_id = ${actor.actorId} AND session_id = ${sessionId}
      AND role IN ('user', 'assistant')`[0]?.n ?? rows.length;

  return inheritedContextFromRows(
    rows.map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at })),
    total,
  );
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

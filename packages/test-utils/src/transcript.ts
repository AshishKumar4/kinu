import { CHAT_SESSION_ID, readSessionTranscript, type ActorHandle, type JsonObject, type SessionHistory, type SqlExecutor, type VFS } from '@kinu.run/core';
import type { ModelMessage } from 'ai';

export interface TranscriptRow {
  readonly id: string;
  readonly position: number;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly recordedAt: number;
}

/** The chat as a reader sees it, oldest first, with each entry's text. */
export async function readTranscriptRows(
  sql: SqlExecutor, actor: ActorHandle, files: Pick<VFS, 'readFile'>, sessionId = CHAT_SESSION_ID,
): Promise<TranscriptRow[]> {
  const transcript = readSessionTranscript(sql, actor, sessionId, () => Promise.resolve(files));
  const rows: TranscriptRow[] = [];

  for (const entry of transcript.entries()) {
    const projected = await transcript.project(entry.id);

    if (projected !== null) rows.push({ id: entry.id, position: entry.position, role: entry.role, content: projected.content, recordedAt: entry.recordedAt });
  }

  return rows;
}

/** Seed the canonical message and transcript stores without selecting working context. */
export async function seedTranscriptEntry(
  history: SessionHistory, sessionId: string,
  input: { readonly id: string; readonly message: ModelMessage; readonly origin: 'input' | 'output'; readonly metadata?: JsonObject },
): Promise<void> {
  const prepared = await history.messages.prepare(input.message, input.id);
  const metadata = input.metadata === undefined ? null : await history.messages.payloads.prepare(input.metadata);

  history.atomic(() => {
    const reference = history.messages.insert(prepared, input.origin);
    history.transcript(sessionId).record({
      id: input.id, role: input.message.role, turnId: null, runId: null, metadata, context: null,
      parts: prepared.content.parts.map((part) => ({ messageId: reference.messageId, partNo: part.partNo })),
    });
  });
}

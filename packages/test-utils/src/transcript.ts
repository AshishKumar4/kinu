import { CHAT_SESSION_ID, readSessionTranscript, type ActorHandle, type SqlExecutor, type VFS } from '@kinu.run/core';

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

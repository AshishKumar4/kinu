/**
 * The chat transcript as the turn loop reads and writes it.
 *
 * ONE interface, two tables. A workspace's root on the hosted backend keeps its
 * chat in `assistant_messages`, the Agents SDK's own table; every other actor,
 * and every actor on the local backend, keeps it in the plain `actor_messages`
 * store. The loop's four durable facts are the same on both — the opening row
 * lands at admission, a landed steer lands at its drain, the answer lands at
 * the commit, and a restore reads newest first — so they are stated here once
 * and each table implements them over its own shape.
 *
 * Nothing here decides the chain. Which row an answer parents to, and what a
 * steer row is parented to, are the loop's rules (`ChatSession`); a store only
 * writes the parent it is handed.
 */

import type { ModelMessage, UIMessage } from 'ai';
import type { ActorReference } from '../identity/actor-handle';
import { operatorMessageAdmitted } from '../identity/conversation-store';
import type { PromptFile } from '../types/backend-host';
import type { SqlExecutor } from '../types/primitives';
import type { JsonObject } from '../utils/json';
import { transcriptRow, type TranscriptRow, type TranscriptSourceRow } from '../utils/ui-message';


export interface TranscriptStore {
  /** Whether a row with this id is on disk in this conversation. */
  has(id: string): boolean;

  /**
   * Append a user row. IDEMPOTENT ON `id`: a re-announced programmatic turn's
   * row is the row its first announcement wrote, and a user turn's admission
   * row survives the commit that writes it again with its stamp. `parentId`
   * chains a landed steer under the row before it — the turn's opening row for
   * the first, the previous steer after that — so a walk from the answer
   * reaches every steer; `metadata` is the provenance stamp core gave the row,
   * absent on a plain user turn. `files` are the attachments the message
   * carried; a store whose rows hold only text keeps none.
   */
  appendUser(row: {
    readonly id: string;
    readonly text: string;
    readonly parentId?: string | null;
    readonly metadata?: JsonObject;
    readonly files?: ReadonlyArray<PromptFile>;
  }): void;

  /**
   * Append the answer. Its id is minted fresh per commit, so a collision is a
   * defect the store reports rather than a duplicate it ignores.
   */
  appendAssistant(row: {
    readonly id: string;
    readonly parentId: string;
    readonly text: string;
  }): void;

  /** Every user and assistant row of this conversation, newest first — or
   *  the newest `limit` of them, for a reader that walks back a bounded way. */
  newestFirst(limit?: number): readonly TranscriptRow[];

  /** Whether the operator has spoken in this conversation — a row a person
   *  wrote, as opposed to one the harness announced. */
  operatorSpoke(): boolean;
}

/**
 * The plain store: `actor_messages`, flat rows with a `parent_id` chain,
 * scoped by actor and conversation.
 */
export class ActorMessagesTranscript implements TranscriptStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorReference,
    private readonly sessionId: string,
  ) {}

  has(id: string): boolean {
    return this.sql<{ id: string }>`
      SELECT id FROM actor_messages
      WHERE actor_id = ${this.actor.actorId} AND id = ${id} AND session_id = ${this.sessionId}
    `.length > 0;
  }

  appendUser(row: {
    readonly id: string;
    readonly text: string;
    readonly parentId?: string | null;
    readonly metadata?: JsonObject;
  }): void {
    // The plain store's rows are text: an attachment rides the model message
    // in memory and the reservation on disk, never this row.
    const stamp = row.metadata === undefined ? null : JSON.stringify(row.metadata);
    void this.sql`INSERT OR IGNORE INTO actor_messages (actor_id, id, session_id, parent_id, role, content, metadata)
      VALUES (${this.actor.actorId}, ${row.id}, ${this.sessionId}, ${row.parentId ?? null}, ${'user'}, ${row.text}, ${stamp})`;
  }

  /** `message` is the streamed UIMessage the answer rides in; the row then
   *  holds its parts as JSON, which every reader projects through
   *  `uiMessageRow` / `storedUiMessageParts`. */
  appendAssistant(row: { readonly id: string; readonly parentId: string; readonly text: string; readonly message?: UIMessage }): void {
    const content = row.message === undefined ? row.text : JSON.stringify(row.message);

    void this.sql`INSERT INTO actor_messages (actor_id, id, session_id, parent_id, role, content)
      VALUES (${this.actor.actorId}, ${row.id}, ${this.sessionId}, ${row.parentId}, ${'assistant'}, ${content})`;
  }

  newestFirst(limit?: number): readonly TranscriptRow[] {
    return this.sql<TranscriptSourceRow>`
      SELECT id, role, content
      FROM actor_messages
      WHERE actor_id = ${this.actor.actorId}
        AND session_id = ${this.sessionId} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit ?? -1}`
      .map(transcriptRow);
  }

  operatorSpoke(): boolean {
    return operatorMessageAdmitted(this.sql, this.actor, this.sessionId);
  }
}

/**
 * The head of a transcript that could not be restored whole.
 *
 * A restore bounded by the context window can still leave older turns behind
 * on a long-lived session. Saying so is the difference between an agent that
 * knows it is reading the tail of its own conversation and one that believes
 * the conversation started there — and the session store is still queryable,
 * so the notice names where the rest is rather than only that it is gone.
 */
export function olderHistoryNotice(omitted: number, sessionId: string): ModelMessage {
  return {
    role: 'user',
    content:
      `[Runtime note — written by the Kinu harness, not by the user.]\n\n`
      + `${omitted} earlier message${omitted === 1 ? '' : 's'} from this session `
      + `are not in your context: the transcript is longer than this model's context window, `
      + `so it was restored from the newest end. They are not lost — they are in this `
      + `workspace's local session store under session id "${sessionId}", readable with your `
      + `normal tools. Say so rather than guessing if something earlier in the conversation matters.`,
  };
}

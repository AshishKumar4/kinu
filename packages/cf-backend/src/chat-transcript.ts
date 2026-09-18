/**
 * Two transcripts, one per kind of actor this object hosts.
 *
 * The root's is {@link AssistantMessagesTranscript}: core's
 * {@link TranscriptStore} over the Agents SDK's own session tree.
 *
 * `assistant_messages` is the SDK's table — its DDL, its FTS index and the
 * active-leaf cache the tree walks from all belong to `AgentSessionProvider`,
 * so every write goes through that provider and never through a statement of
 * our own (the 2026-09-11 outage was a reader that assumed the table's shape).
 * Reads that the provider does not offer — the newest-first restore, the
 * operator check — are the plain selects core already prepares against the
 * installed vendor's DDL (`gate:vendor-schema`).
 *
 * A row here is a UIMessage. The loop hands this store text; the transport
 * that streamed the answer hands it the accumulated parts under the same id,
 * so the persisted row carries the tool calls and step markers the client
 * rendered — {@link AssistantMessagesTranscript.answersFrom}.
 *
 * A HOSTED actor's default chat is the plain `actor_messages` store instead —
 * core's `ActorMessagesTranscript` writes it, and the two reads a pane's
 * socket needs of it are {@link actorChatHistory} and
 * {@link actorChatNewestId} below. They live here because the projection is
 * the same one this file already owns in the other direction: a stored row
 * becomes the UIMessage the SDK's clients render.
 */
import { AgentSessionProvider, type SessionMessage, type SqlProvider } from 'agents/experimental/memory/session';
import * as v from 'valibot';
import {
  CHAT_SESSION_ID, JsonObjectSchema, operatorMessageAdmitted, recordedAnswer, storedUiMessageParts, transcriptRow,
  type ActorReference, type JsonObject, type PromptFile, type SqlExecutor,
  type TranscriptSourceRow, type TranscriptRow, type TranscriptStore,
} from '@kinu.run/core';

/** The session the SDK keys the root's chat under: the empty id its own
 *  `Session.create` uses when none is given. */
const ROOT_SESSION_ID = '';

/** The parts a persisted message carries — text and files as the client sends
 *  them, exactly as Think's intake stored them. */
function userParts(text: string, files: ReadonlyArray<PromptFile> | undefined): SessionMessage['parts'] {
  return [
    ...(files ?? []).map((file) => ({ type: 'file' as const, url: file.url, mediaType: file.mediaType, filename: file.filename })),
    { type: 'text' as const, text },
  ];
}

export class AssistantMessagesTranscript implements TranscriptStore {
  private readonly provider: AgentSessionProvider;
  private answered: ((id: string) => SessionMessage | null) | null = null;
  private streamed: ((id: string) => SessionMessage | null) | null = null;

  constructor(
    agent: SqlProvider,
    private readonly sql: SqlExecutor,
    private readonly actor: ActorReference,
  ) {
    this.provider = new AgentSessionProvider(agent, ROOT_SESSION_ID);
    // The table exists from the store's first breath, as it did from Think's
    // session boot: the provider declares its DDL on first use, and the
    // operator check below reads the table before any turn has written it.
    this.provider.getLatestLeaf();
  }

  /** Where a finished answer's accumulated UIMessage comes from, by id — the
   *  transport that streamed it. Installed once, when both are built. */
  answersFrom(source: { answer: (id: string) => SessionMessage | null; streamed: (id: string) => SessionMessage | null }): void {
    this.answered = source.answer;
    this.streamed = source.streamed;
  }

  /** The assistant row as it WILL be persisted under this id — the roster
   *  records this shape as the turn-end announcement's input. */
  recordedAssistant(id: string, text: string): SessionMessage {
    return recordedAnswer(this.streamed?.(id) ?? null, id, text);
  }

  has(id: string): boolean {
    return this.provider.getMessage(id) !== null;
  }

  /** The conversation as the client renders it: the path to the latest
   *  leaf, oldest first — the SDK's own read. */
  history(): SessionMessage[] {
    return this.provider.getHistory();
  }

  /** Every row of this conversation, gone — the clear the client asked for. */
  clear(): void {
    this.provider.clearMessages();
  }

  appendUser(row: {
    readonly id: string;
    readonly text: string;
    readonly parentId?: string | null;
    readonly metadata?: JsonObject;
    readonly files?: ReadonlyArray<PromptFile>;
  }): void {
    // Idempotent on id: the provider refuses a second row under the same id,
    // which is the same rule the plain store's `INSERT OR IGNORE` states.
    this.provider.appendMessage({
      id: row.id,
      role: 'user',
      parts: userParts(row.text, row.files),
      ...(row.metadata !== undefined && { metadata: row.metadata }),
    }, row.parentId ?? undefined);
  }

  appendAssistant(row: { readonly id: string; readonly parentId: string; readonly text: string }): void {
    const recorded = this.recordedAssistant(row.id, row.text);
    // Spent here: the transport keeps the streamed answer only until its row.
    this.answered?.(row.id);

    this.provider.appendMessage(recorded, row.parentId);
  }

  /** The metadata of the newest user row — the composer's mode, a signal's
   *  stamp — for a reader with no turn to ask: the tool listing an idle actor
   *  serves narrows its work mode off the last message, as Think's cache did. */
  lastUserMetadata(): JsonObject | undefined {
    const row = this.sql<{ content: string }>`
      SELECT content FROM assistant_messages
      WHERE session_id = ${ROOT_SESSION_ID} AND role = 'user'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`[0];

    if (row === undefined) return undefined;
    const parsed = v.safeParse(v.object({ metadata: v.optional(JsonObjectSchema) }), JSON.parse(row.content));

    return parsed.success ? parsed.output.metadata : undefined;
  }

  newestFirst(limit?: number): readonly TranscriptRow[] {
    return this.sql<TranscriptSourceRow>`
      SELECT id, role, content FROM assistant_messages
      WHERE session_id = ${ROOT_SESSION_ID} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit ?? -1}`
      .map(transcriptRow);
  }

  operatorSpoke(): boolean {
    return operatorMessageAdmitted(this.sql, this.actor);
  }
}

/** The role words the pane's own rows carry. A row with any other role — the
 *  MCTS trees, a peer lane — is not this conversation's. */
const CHAT_ROLES = ['user', 'assistant'] as const;

/** One hosted actor's conversation as the client renders it, oldest first:
 *  a user row is plain text, an answer row holds the parts it streamed. */
export function actorChatHistory(sql: SqlExecutor, actor: ActorReference): SessionMessage[] {
  return sql<{ id: string; role: string; content: string }>`
    SELECT id, role, content FROM actor_messages
    WHERE actor_id = ${actor.actorId} AND session_id = ${CHAT_SESSION_ID}
      AND role IN (${CHAT_ROLES[0]}, ${CHAT_ROLES[1]})
    ORDER BY created_at ASC, rowid ASC`
    .map((row) => ({
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' as const : 'user' as const,
      parts: storedUiMessageParts(row.content),
    }));
}

/** The row a new answer chains under: the newest row of this actor's chat.
 *  Null on an empty conversation, which is a turn whose opening row never
 *  landed and therefore an answer with nothing to parent to. */
export function actorChatNewestId(sql: SqlExecutor, actor: ActorReference): string | null {
  return sql<{ id: string }>`
    SELECT id FROM actor_messages
    WHERE actor_id = ${actor.actorId} AND session_id = ${CHAT_SESSION_ID}
    ORDER BY created_at DESC, rowid DESC LIMIT 1`[0]?.id ?? null;
}

/** Drop this actor's chat, the clear its own pane asked for. Scoped to the
 *  default session: an actor's MCTS and peer trees live in the same table
 *  under their own session ids and are not this conversation. */
export function actorChatClear(sql: SqlExecutor, actor: ActorReference): void {
  void sql`DELETE FROM actor_messages
    WHERE actor_id = ${actor.actorId} AND session_id = ${CHAT_SESSION_ID}`;
}

/**
 * The hosted root's transcript: core's {@link TranscriptStore} over the Agents
 * SDK's own session tree.
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
 */
import { AgentSessionProvider, type SessionMessage, type SqlProvider } from 'agents/experimental/memory/session';
import * as v from 'valibot';
import {
  JsonObjectSchema, operatorMessageAdmitted, uiMessageText,
  type ActorReference, type JsonObject, type PromptFile, type SqlExecutor,
  type TranscriptRow, type TranscriptStore,
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

  /**
   * The assistant row as it WILL be persisted under this id: what the client
   * was streamed — its tool calls, its step markers, its reasoning — carrying
   * the turn's ANSWER as its one text part, else the text alone. The roster
   * records this very shape as the turn-end announcement's input, so a replay
   * reads what the row holds.
   *
   * The streamed message's own text parts are the turn's narration, one per
   * step; the loop hands this the answer the turn stopped on. A row that kept
   * both read as the narration and the answer concatenated to every reader
   * that projects a row to text (`uiMessageText`: the history page, search,
   * inherited context), which is how the deployed build's stored reply for a
   * ten-step turn began with "I'll take a quick look…". The narration is not
   * lost: it is on each step's own `step_finish` row in the run ledger, and it
   * reached whoever was watching live.
   */
  recordedAssistant(id: string, text: string): SessionMessage {
    const streamed = this.streamed?.(id);

    if (streamed === undefined || streamed === null) return { id, role: 'assistant', parts: [{ type: 'text', text }] };

    // The answer rides the streamed message's OWN last text part, text
    // replaced, left where that part streamed: that part carries what the
    // client rendered it as (`state`, and whatever the SDK adds next), and a
    // hand-built part would drop it. A turn whose answer came after its calls
    // already holds it last; one that stopped on its calls holds its streamed
    // narration first, and moving that sentence after the calls is what put
    // the tool card ahead of it on reload.
    let lastText: { readonly index: number; readonly part: SessionMessage['parts'][number] } | null = null;

    for (const [index, part] of streamed.parts.entries()) {
      if (part.type === 'text') lastText = { index, part };
    }

    if (lastText === null) return { ...streamed, parts: [...streamed.parts, { type: 'text', text }] };

    const found = lastText;

    return {
      ...streamed,
      parts: streamed.parts.flatMap((part, index) =>
        part.type !== 'text' || index === found.index ? [index === found.index ? { ...found.part, text } : part] : []),
    };
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

  newestFirst(): readonly TranscriptRow[] {
    return this.sql<{ role: string; content: string }>`
      SELECT role, content FROM assistant_messages
      WHERE session_id = ${ROOT_SESSION_ID} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, rowid DESC`
      .map((row) => ({ role: row.role, content: uiMessageText(row.content) }));
  }

  operatorSpoke(): boolean {
    return operatorMessageAdmitted(this.sql, this.actor);
  }
}

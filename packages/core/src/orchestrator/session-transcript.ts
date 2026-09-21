import * as v from 'valibot';
import { validateUIMessages, type UIMessage } from 'ai';
import type { ActorHandle } from '../identity/actor-handle';
import type { PromptFile } from '../types/backend-host';
import type { SqlExecutor, VFS } from '../types/primitives';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { type SessionMessages, SessionMessageReader, type ActorReadAuthority, type MessagePartReference, type MessageReference } from './session-messages';
import { type SessionPayloads, SessionPayloadReader, type SessionPayload } from './session-payload';
import { turnAuthor } from '../utils/ui-message';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../read-models/page';
import type { ContextSelection } from './session-context';

export interface ConversationPartReference extends MessagePartReference { textRange?: { readonly start: number; readonly length: number } }

export interface ConversationEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly recordedAt: number;
  readonly metadata: SessionPayload | null;
  readonly parts: readonly ConversationPartReference[];
  readonly context?: ContextSelection | null;
}

export interface PreparedConversationEntry extends Omit<ConversationEntry, 'recordedAt' | 'parentId'> { readonly parentId: string | null | undefined }

interface EntryRow { id: string; parent_id: string | null; role: ConversationEntry['role']; turn_id: string | null; run_id: string | null; recorded_at: number; metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null; context_id: string | null; context_revision: number | null }

interface EntryPartRow { message_id: string; part_no: number; through_sequence: number; text_start: number | null; text_length: number | null }

export interface ConversationProjection {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: ConversationEntry['role'];
  readonly content: string;
  readonly recordedAt: number;
  readonly toolCalls: readonly string[];
  metadata?: JsonObject;
}

interface StoredUiMessage {
  readonly id: string;
  readonly role: string;
  readonly parts: JsonObject[];
  metadata?: JsonValue;
}

export function readSessionTranscript(sql: SqlExecutor, authority: ActorReadAuthority, sessionId: string, files: () => Promise<Pick<VFS, 'readFile'>>): SessionTranscriptReader {
  const payloads = new SessionPayloadReader(files);

  return new SessionTranscriptReader(sql, authority, sessionId, new SessionMessageReader(sql, authority, payloads), payloads);
}

/** Public transcript references canonical parts; pruning model context never rewrites this tree. */
export class SessionTranscriptReader<A extends ActorReadAuthority = ActorReadAuthority, P extends SessionPayloadReader = SessionPayloadReader> {
  constructor(protected readonly sql: SqlExecutor, protected readonly actor: A, readonly sessionId: string,
    protected readonly messages: SessionMessageReader, protected readonly payloads: P) {}

  async project(id: string): Promise<ConversationProjection | null> {
    const entry = this.read(id);

    if (entry === null) return null;
    const parts = await this.parts(entry.parts);
    const text: string[] = [];
    const toolCalls: string[] = [];

    for (const part of parts) {
      if (part.type === 'text') text.push(v.parse(v.string(), part.text));
      else if (part.type === 'tool-call') toolCalls.push(v.parse(v.string(), part.toolName));
    }

    const projection: ConversationProjection = { id: entry.id, parentId: entry.parentId, role: entry.role, content: text.join(''), recordedAt: entry.recordedAt, toolCalls };

    if (entry.metadata !== null) projection.metadata = v.parse(JsonObjectSchema, await this.payloads.read(entry.metadata));
    this.actor.assertCurrent();

    return projection;
  }

  /** The head's ancestry, newest first, one entry per row; a cursor resumes above its entry. */
  pageIds(request: PageRequest = {}): Page<{ readonly id: string }> {
    this.actor.assertCurrent();
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 100)));
    const after = request.cursor?.after ?? null;
    let id: string | null;

    if (after === null) id = this.newestId();
    else {
      const anchor = this.read(after);

      if (anchor === null) throw new StaleCursorError('conversation', after);
      id = anchor.parentId;
    }

    const rows: { id: string }[] = [];

    while (id !== null && rows.length <= limit) {
      const entry = this.read(id);

      if (entry === null) throw new KinuError('missing', 'conversation ancestry entry is missing');

      if (entry.role !== 'tool') rows.push({ id: entry.id });
      id = entry.parentId;
    }

    return seekPage(rows, limit, row => row.id);
  }

  async metadata(id: string): Promise<JsonObject | undefined> {
    const reference = this.read(id)?.metadata;
    const result = reference === undefined || reference === null ? undefined : v.parse(JsonObjectSchema, await this.payloads.read(reference));
    this.actor.assertCurrent();

    return result;
  }

  async page(request: PageRequest = {}): Promise<Page<ConversationProjection>> {
    const page = this.pageIds(request);
    const items: ConversationProjection[] = [];

    for (const row of page.items) {
      const projected = await this.project(row.id);

      if (projected === null) throw new KinuError('missing', 'conversation entry disappeared');
      items.push(projected);
    }

    return { ...page, items };
  }


  has(id: string): boolean {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND id=${id}`.length > 0;
  }

  /** The entry the next record chains from: the head a revert set, else the newest leaf. */
  newestId(): string | null {
    this.actor.assertCurrent();
    const head = this.sql<{ entry_id: string | null }>`SELECT entry_id FROM conversation_heads WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId}`[0];

    if (head !== undefined) return head.entry_id;

    return this.sql<{ id: string }>`SELECT e.id FROM conversation_entries e WHERE e.actor_id=${this.actor.actorId} AND e.session_id=${this.sessionId}
      AND NOT EXISTS(SELECT 1 FROM conversation_entries c WHERE c.actor_id=e.actor_id AND c.session_id=e.session_id AND c.parent_id=e.id)
      ORDER BY e.rowid DESC LIMIT 1`[0]?.id ?? null;
  }

  read(id: string): ConversationEntry | null {
    this.actor.assertCurrent();

    const row = this.sql<EntryRow>`SELECT id,parent_id,role,turn_id,run_id,recorded_at,metadata_json,metadata_path,metadata_digest,context_id,context_revision FROM conversation_entries
      WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND id=${id}`[0];

    if (row === undefined) return null;
    let metadata: SessionPayload | null = null;

    if (row.metadata_json !== null) metadata = { json: row.metadata_json, path: null, digest: null };
    else if (row.metadata_path !== null && row.metadata_digest !== null) metadata = { json: null, path: row.metadata_path, digest: row.metadata_digest };
    const parts = this.sql<EntryPartRow>`SELECT message_id,part_no,through_sequence,text_start,text_length FROM conversation_entry_parts WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND entry_id=${id} ORDER BY position`;

    return { id: row.id, parentId: row.parent_id, role: row.role, turnId: row.turn_id, runId: row.run_id, recordedAt: row.recorded_at, metadata,
      context: row.context_id === null || row.context_revision === null ? null : { contextId: row.context_id, revision: row.context_revision },
      parts: parts.map(part => {
        const reference: ConversationPartReference = { messageId: part.message_id, partNo: part.part_no, throughSequence: part.through_sequence };

        if (part.text_start !== null && part.text_length !== null) reference.textRange = { start: part.text_start, length: part.text_length };

        return reference;
      }) };
  }


  children(id: string): readonly string[] {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND parent_id=${id} ORDER BY rowid`.map(row => row.id);
  }

  /** Entries on the head's ancestry. */
  count(): number {
    return this.ancestry().length;
  }

  ancestry(leafId = this.newestId(), limit = 10_000): readonly ConversationEntry[] {
    this.actor.assertCurrent();

    if (!Number.isSafeInteger(limit) || limit < 0) throw new KinuError('bad_input', 'history limit must be a nonnegative integer');
    const chain: ConversationEntry[] = [];
    const seen = new Set<string>();
    let id = leafId;

    while (id !== null && chain.length < limit) {
      if (seen.has(id)) throw new KinuError('io', 'conversation ancestry contains a cycle');
      seen.add(id);
      const entry = this.read(id);

      if (entry === null) throw new KinuError('missing', 'conversation ancestry entry is missing');
      chain.push(entry);
      id = entry.parentId;
    }

    return chain.reverse();
  }

  async parts(references: readonly ConversationPartReference[]): Promise<JsonObject[]> {
    const cache = new Map<string, readonly { partNo: number; value: JsonObject }[]>();
    const parts: JsonObject[] = [];

    for (const ref of references) {
      const key = `${ref.messageId}:${ref.throughSequence}`;
      let message = cache.get(key);

      if (message === undefined) { message = await this.messages.materializeParts({ messageId: ref.messageId, sequence: ref.throughSequence }); cache.set(key, message); }

      const part = message.find(value => value.partNo === ref.partNo);

      if (part === undefined) throw new KinuError('io', 'conversation reference names a part outside its cutoff');

      if (ref.textRange === undefined) parts.push(part.value);
      else {
        const { start, length } = ref.textRange;
        const text = v.parse(v.string(), part.value.text);

        if (part.value.type !== 'text' || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > text.length) throw new KinuError('io', 'conversation text range exceeds its recorded cutoff');
        parts.push({ ...part.value, text: text.slice(start, start + length) });
      }
    }

    this.actor.assertCurrent();

    return parts;
  }

  async history(leafId = this.newestId(), limit = 10_000): Promise<UIMessage[]> {
    const messages: UIMessage[] = [];

    for (const entry of this.ancestry(leafId, limit)) messages.push(await this.materializeEntry(entry));

    return messages;
  }

  /** User and assistant projections of the head's ancestry, newest first. */
  async newestFirst(limit = 10_000): Promise<readonly ConversationProjection[]> {
    const rows: ConversationProjection[] = [];

    for (const entry of [...this.ancestry(this.newestId(), limit)].reverse()) {
      if (entry.role !== 'user' && entry.role !== 'assistant') continue;
      const projected = await this.project(entry.id);

      if (projected !== null) rows.push(projected);
    }

    return rows;
  }

  lastUserMetadataReference(): SessionPayload | null {
    const chain = this.ancestry();

    for (let index = chain.length - 1; index >= 0; index--) {
      const entry = chain[index];

      if (entry !== undefined && entry.role === 'user') return entry.metadata;
    }

    return null;
  }

  async lastUserMetadata(): Promise<JsonObject | undefined> {
    const reference = this.lastUserMetadataReference();
    const metadata = reference === null ? undefined : v.parse(JsonObjectSchema, await this.payloads.read(reference));
    this.actor.assertCurrent();

    return metadata;
  }

  async operatorSpoke(): Promise<boolean> {
    for (const entry of this.ancestry()) {
      if (entry.role !== 'user') continue;
      const metadata = entry.metadata === null ? undefined : await this.payloads.read(entry.metadata);
      this.actor.assertCurrent();

      if (turnAuthor({ id: entry.id, metadata }) === 'operator') return true;
    }

    return false;
  }

  async message(id: string): Promise<UIMessage | null> {
    const entry = this.read(id);

    return entry === null ? null : this.materializeEntry(entry);
  }

  private async materializeEntry(entry: ConversationEntry): Promise<UIMessage> {
      const parts = await this.parts(entry.parts);
      const projected: JsonObject[] = [];
      const calls = new Map<string, JsonObject>();

      for (const part of parts) {
        if (part.type === 'tool-call') {
          const id = v.parse(v.string(), part.toolCallId);
          const call: JsonObject = { type: `tool-${v.parse(v.string(), part.toolName)}`, toolCallId: id, state: 'input-available', input: part.input ?? null };
          calls.set(id, call);
          projected.push(call);
        } else if (part.type === 'tool-result') {
          const id = v.parse(v.string(), part.toolCallId);
          const call = calls.get(id);

          if (call === undefined) throw new KinuError('io', 'public tool result has no call in its entry');
          const output = v.parse(JsonObjectSchema, part.output);
          call.state = output.type === 'error-text' || output.type === 'error-json' ? 'output-error' : 'output-available';

          if (call.state === 'output-error') call.errorText = v.is(v.string(), output.value) ? output.value : JSON.stringify(output.value);
          else call.output = output.value ?? output;
        } else if (part.type === 'file' || part.type === 'image') {
          const native = await this.payloads.resolveMedia(part);
          const carrier = native.data ?? native.image;
          const string = v.safeParse(v.string(), carrier);
          const url = v.safeParse(v.object({ $url: v.string() }), carrier);
          const binary = v.safeParse(v.object({ $binary: v.string() }), carrier);
          const mediaType = v.is(v.string(), native.mediaType) ? native.mediaType : 'application/octet-stream';
          let address: string;

          if (url.success) address = url.output.$url;
          else if (binary.success) address = `data:${mediaType};base64,${binary.output.$binary}`;
          else if (string.success) address = /^(https?:|data:|\/)/u.test(string.output) ? string.output : `data:${mediaType};base64,${string.output}`;
          else throw new KinuError('io', 'stored attachment has no native data carrier');
          const file: JsonObject = { type: 'file', mediaType, url: address };

          if (native.filename !== undefined) file.filename = native.filename;
          projected.push(file);
        } else {
          const { providerOptions, ...value } = part;

          if (providerOptions !== undefined) value.providerMetadata = providerOptions;
          projected.push(value);
        }
      }

      const message: StoredUiMessage = { id: entry.id, role: entry.role, parts: projected };

      if (entry.metadata !== null) message.metadata = await this.payloads.read(entry.metadata);
      this.actor.assertCurrent();

      // An answer with nothing in it is a recorded turn the UI shows as empty; the SDK validator rejects only its part count.
      if (projected.length === 0 && entry.role !== 'tool') {
        const empty: UIMessage = { id: entry.id, role: entry.role, parts: [] };

        if (message.metadata !== undefined) empty.metadata = message.metadata;

        return empty;
      }

      const validated = await validateUIMessages({ messages: [message] });
      this.actor.assertCurrent();
      const result = validated[0];

      if (result === undefined) throw new KinuError('io', 'conversation entry did not materialize');

      return result;
  }
}

export class SessionTranscript extends SessionTranscriptReader<ActorHandle, SessionPayloads> {
  /** `selection` is the actor's working context at record time: an entry that
   *  names no context of its own is stamped with it, so a fork cut at that
   *  entry restores exactly the model context the actor held there. */
  constructor(sql: SqlExecutor, actor: ActorHandle, sessionId: string, messages: SessionMessages, payloads: SessionPayloads,
    private readonly atomic: <T>(write: () => T) => T, private readonly selection: () => ContextSelection | null) {
    super(sql, actor, sessionId, messages, payloads);
  }

  async prepareSteers(rows: readonly { readonly id: string; readonly text: string; readonly metadata: JsonObject; readonly files?: ReadonlyArray<PromptFile> }[], reference: MessageReference, turnId: string, runId: string, parentId: string | null): Promise<PreparedConversationEntry[]> {
    const textPart = rows.reduce((count, row) => count + (row.files?.length ?? 0), 0);
    let filePart = 0;
    let start = 0;
    const entries: PreparedConversationEntry[] = [];

    for (const row of rows) {
      const parts: ConversationPartReference[] = [];

      for (const _file of row.files ?? []) parts.push({ messageId: reference.messageId, partNo: filePart++, throughSequence: reference.sequence });
      parts.push({ messageId: reference.messageId, partNo: textPart, throughSequence: reference.sequence, textRange: { start, length: row.text.length } });
      entries.push({ id: row.id, parentId, role: 'user', turnId, runId, parts, metadata: await this.payloads.prepare(row.metadata) });
      start += row.text.length + 2;
      parentId = row.id;
    }

    return entries;
  }

  async prepareUser(input: { readonly id: string; readonly parentId?: string | null; readonly turnId: string; readonly runId?: string; readonly message: MessageReference; readonly metadata?: JsonObject }): Promise<PreparedConversationEntry> {
    const parts = await this.messages.materializeParts(input.message);

    return { id: input.id, parentId: input.parentId, role: 'user', turnId: input.turnId, runId: input.runId ?? null,
      metadata: input.metadata === undefined ? null : await this.payloads.prepare(input.metadata),
      parts: parts.map(part => ({ messageId: input.message.messageId, partNo: part.partNo, throughSequence: input.message.sequence })) };
  }

  async prepareAssistant(input: { readonly id: string; readonly parentId: string; readonly turnId: string; readonly runId: string; readonly parts: readonly MessagePartReference[]; readonly finalText: MessagePartReference | null; readonly metadata?: JsonObject }): Promise<PreparedConversationEntry> {
    const values = await this.parts(input.parts);
    let lastText = -1;

    for (const [index, value] of values.entries()) if (value.type === 'text') lastText = index;
    const parts = input.parts.filter((_, index) => values[index]?.type !== 'text' || index === lastText);

    if (input.finalText !== null) {
      const position = lastText < 0 ? -1 : parts.findIndex(part => part === input.parts[lastText]);

      if (position < 0) parts.push(input.finalText);
      else parts[position] = input.finalText;
    }

    return { id: input.id, parentId: input.parentId, role: 'assistant', turnId: input.turnId, runId: input.runId,
      metadata: input.metadata === undefined ? null : await this.payloads.prepare(input.metadata), parts };
  }

  appendUser(entry: PreparedConversationEntry): void {
    if (entry.role !== 'user') throw new KinuError('bad_input', 'user admission requires a user entry');
    this.atomic(() => { if (!this.has(entry.id)) this.record(entry); });
  }

  appendAssistant(entry: PreparedConversationEntry): void {
    if (entry.role !== 'assistant') throw new KinuError('bad_input', 'assistant settlement requires an assistant entry');
    this.record(entry);
  }

  record(entry: PreparedConversationEntry): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      const actorId = this.actor.actorId;
      const parentId = entry.parentId === undefined ? this.newestId() : entry.parentId;
      const context = entry.context === undefined ? this.selection() : entry.context;
      void this.sql`INSERT INTO conversation_entries(actor_id,session_id,id,parent_id,role,turn_id,run_id,metadata_json,metadata_path,metadata_digest,recorded_at,context_id,context_revision)
        VALUES(${actorId},${this.sessionId},${entry.id},${parentId},${entry.role},${entry.turnId},${entry.runId},${entry.metadata?.json ?? null},${entry.metadata?.path ?? null},${entry.metadata?.digest ?? null},${Date.now()},${context?.contextId ?? null},${context?.revision ?? null})`;

      for (const [position, part] of entry.parts.entries()) {
        void this.sql`INSERT INTO conversation_entry_parts(actor_id,session_id,entry_id,position,message_id,part_no,through_sequence,text_start,text_length)
          VALUES(${actorId},${this.sessionId},${entry.id},${position},${part.messageId},${part.partNo},${part.throughSequence},${part.textRange?.start ?? null},${part.textRange?.length ?? null})`;
      }

      this.setHead(entry.id);
    });
  }

  /** Move the head; entries beyond it stay recorded but leave the ancestry every read follows. */
  setHead(entryId: string | null): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      void this.sql`INSERT INTO conversation_heads(actor_id,session_id,entry_id) VALUES(${this.actor.actorId},${this.sessionId},${entryId})
        ON CONFLICT(actor_id,session_id) DO UPDATE SET entry_id=excluded.entry_id`;
    });
  }

  /** Clear the public view, not execution history or model context. */
  clear(): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      void this.sql`PRAGMA defer_foreign_keys = ON`;
      void this.sql`DELETE FROM conversation_heads WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId}`;
      void this.sql`DELETE FROM conversation_entries WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId}`;
    });
  }
}


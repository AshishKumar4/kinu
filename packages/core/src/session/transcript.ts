import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';
import type { UIMessage } from 'ai';
import type { ActorHandle } from '../identity/actor-handle';
import type { PromptFile } from '../types/backend-host';
import type { SqlExecutor } from '../types/primitives';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { type SessionMessages, SessionMessageReader, type ActorReadAuthority, type MessagePartReference, type MessageReference, type StoredPart } from './messages';
import { type SessionPayloads, SessionPayloadReader, type SessionPayload } from './payload';
import { rowText, turnAuthor, UIMessageSchema } from '../utils/ui-message';
import type { Page, PositionCursor, PositionPageRequest } from './page';
import type { ContextSelection } from './context';
import { isServerCompaction } from '../providers/server-compaction';

export interface ConversationPartReference extends MessagePartReference { textRange?: { readonly start: number; readonly length: number } }

export interface ConversationEntry {
  readonly id: string;
  /** Its place in the chat, from 0; the chat is a list, so the newest position + 1 is its length. */
  readonly position: number;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly recordedAt: number;
  readonly metadata: SessionPayload | null;
  readonly parts: readonly ConversationPartReference[];
  readonly context?: ContextSelection | null;
}

export type PreparedConversationEntry = Omit<ConversationEntry, 'recordedAt' | 'position'>;

interface EntryRow { id: string; position: number; role: ConversationEntry['role']; turn_id: string | null; run_id: string | null; recorded_at: number; metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null; context_id: string | null; context_revision: number | null }

interface EntryPartRow { message_id: string; part_no: number; text_start: number | null; text_length: number | null }

type EntryWithPartRow = EntryRow & { [K in keyof EntryPartRow]: EntryPartRow[K] | null };

/** Folds one row per part (a partless entry: one row of nulls) into entries, in row order. */
function withParts(rows: readonly EntryWithPartRow[]): ConversationEntry[] {
  const entries: Array<ConversationEntry & { parts: ConversationPartReference[] }> = [];

  for (const row of rows) {
    let entry = entries.at(-1);

    if (entry?.id !== row.id) {
      let metadata: SessionPayload | null = null;

      if (row.metadata_json !== null) metadata = { json: row.metadata_json, path: null, digest: null };
      else if (row.metadata_path !== null && row.metadata_digest !== null) metadata = { json: null, path: row.metadata_path, digest: row.metadata_digest };

      entry = { id: row.id, position: row.position, role: row.role, turnId: row.turn_id, runId: row.run_id, recordedAt: row.recorded_at, metadata,
        context: row.context_id === null || row.context_revision === null ? null : { contextId: row.context_id, revision: row.context_revision },
        parts: [] };
      entries.push(entry);
    }

    if (row.message_id === null || row.part_no === null) continue;
    const reference: ConversationPartReference = { messageId: row.message_id, partNo: row.part_no };

    if (row.text_start !== null && row.text_length !== null) reference.textRange = { start: row.text_start, length: row.text_length };
    entry.parts.push(reference);
  }

  return entries;
}

export interface ConversationProjection {
  readonly id: string;
  readonly position: number;
  readonly role: ConversationEntry['role'];
  readonly content: string;
  readonly recordedAt: number;
  readonly toolCalls: readonly string[];
  metadata?: JsonObject;
  /** Content sits in a spilled payload this reader (no file plane) cannot read. */
  unavailable?: true;
}

interface StoredUiMessage {
  readonly id: string;
  readonly role: string;
  readonly parts: JsonObject[];
  metadata?: JsonValue;
}

/** The trailing text parts `answer` is made of, last first. */
function answeredTexts(parts: readonly JsonObject[], answer: string): number[] {
  const covered: number[] = [];
  const whole = answer.trim();
  let tail = '';

  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];

    if (part?.type === 'tool-call' || part?.type === 'tool-result') break;

    if (part?.type !== 'text') continue;
    const joined = `${v.parse(v.string(), part.text)}${tail}`;

    if (!whole.endsWith(joined.trim())) break;
    covered.push(index);
    tail = joined;
  }

  return covered;
}

function drawnParts(parts: readonly JsonObject[], role: ConversationEntry['role']): JsonObject[] {
  const projected: JsonObject[] = [];
  const calls = new Map<string, JsonObject>();

  for (const part of parts) {
    // The provider's compaction summary is for the model, not the owner.
    if (isServerCompaction(part.providerOptions)) continue;

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
      const carrier = part.data ?? part.image;
      const string = v.safeParse(v.string(), carrier);
      const url = v.safeParse(v.object({ $url: v.string() }), carrier);
      const binary = v.safeParse(v.object({ $binary: v.string() }), carrier);
      const mediaType = v.is(v.string(), part.mediaType) ? part.mediaType : 'application/octet-stream';
      let address: string;

      if (url.success) address = url.output.$url;
      else if (binary.success) address = `data:${mediaType};base64,${binary.output.$binary}`;
      else if (string.success) address = /^(https?:|data:|\/)/u.test(string.output) ? string.output : `data:${mediaType};base64,${string.output}`;
      else throw new KinuError('io', 'stored attachment has no native data carrier');
      const file: JsonObject = { type: 'file', mediaType, url: address };

      if (part.filename !== undefined) file.filename = part.filename;
      projected.push(file);
    } else {
      const { providerOptions, ...value } = part;

      if (providerOptions !== undefined) value.providerMetadata = providerOptions;

      if (role === 'assistant' && (value.type === 'text' || value.type === 'reasoning')) value.state = 'done';

      projected.push(value);
    }
  }

  return projected;
}

const StepMessageSchema = v.looseObject({ content: v.union([v.string(), v.array(JsonObjectSchema)]) });

/** A recorded step projected for display. */
export function drawnStep(messages: readonly JsonValue[]): JsonObject[] {
  return drawnParts(messages.flatMap((message) => {
    const { content } = v.parse(StepMessageSchema, message);

    return v.is(v.string(), content) ? [{ type: 'text', text: content }] : content;
  }), 'assistant');
}

export function readSessionTranscript(sql: SqlExecutor, authority: ActorReadAuthority, sessionId: string, files: (() => Promise<Pick<VFS, 'readFile'>>) | null): SessionTranscriptReader {
  const payloads = new SessionPayloadReader(files);

  return new SessionTranscriptReader({
    sql, actor: authority, sessionId, messages: new SessionMessageReader(sql, authority, payloads), payloads,
  });
}

interface TranscriptStores<A extends ActorReadAuthority, P extends SessionPayloadReader> {
  readonly sql: SqlExecutor;
  readonly actor: A;
  readonly sessionId: string;
  readonly messages: SessionMessageReader;
  readonly payloads: P;
}

/** Public transcript references canonical parts; pruning model context never rewrites this tree. */
export function answerParts(parts: readonly MessagePartReference[], finalText: MessagePartReference | null): MessagePartReference[] {
  return finalText === null ? [...parts] : [...parts, finalText];
}

export class SessionTranscriptReader<A extends ActorReadAuthority = ActorReadAuthority, P extends SessionPayloadReader = SessionPayloadReader> {
  protected readonly sql: SqlExecutor;
  protected readonly actor: A;
  readonly sessionId: string;
  protected readonly messages: SessionMessageReader;
  protected readonly payloads: P;

  constructor(stores: TranscriptStores<A, P>) {
    this.sql = stores.sql;
    this.actor = stores.actor;
    this.sessionId = stores.sessionId;
    this.messages = stores.messages;
    this.payloads = stores.payloads;
  }

  async project(id: string): Promise<ConversationProjection | null> {
    const entry = this.read(id);

    return entry === null ? null : this.projectEntry(entry);
  }

  private async projectEntry(entry: ConversationEntry, cache?: Map<string, readonly StoredPart[]>): Promise<ConversationProjection> {
    if (!this.payloads.readsFiles && ((entry.metadata !== null && entry.metadata.path !== null)
      || [...new Set(entry.parts.map((part) => part.messageId))].some((messageId) => this.messages.spilled(messageId)))) {
      return { id: entry.id, position: entry.position, role: entry.role, content: '', recordedAt: entry.recordedAt, toolCalls: [], unavailable: true };
    }

    const parts = await this.parts(entry.parts, cache);
    const toolCalls = parts.flatMap((part) => part.type === 'tool-call' ? [v.parse(v.string(), part.toolName)] : []);
    const projection: ConversationProjection = { id: entry.id, position: entry.position, role: entry.role, content: rowText({ role: entry.role, parts }), recordedAt: entry.recordedAt, toolCalls };

    if (entry.metadata !== null) projection.metadata = v.parse(JsonObjectSchema, await this.payloads.read(entry.metadata));
    this.actor.assertCurrent();

    return projection;
  }

  /** Newest first, tool rows skipped; a cursor names a position, so any stretch is one indexed read. */
  pageIds(request: PositionPageRequest = {}): Page<{ readonly id: string; readonly position: number }, PositionCursor> {
    this.actor.assertCurrent();
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 100)));
    const before = request.cursor?.before ?? Number.MAX_SAFE_INTEGER;

    const rows = this.sql<{ id: string; position: number }>`SELECT id,position FROM conversation_entries
      WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND position < ${before} AND role != 'tool'
      ORDER BY position DESC LIMIT ${limit + 1}`;

    if (rows.length <= limit) return { status: 'end', items: rows };
    const items = rows.slice(0, limit);

    return { status: 'more', items, next: { before: items[items.length - 1]?.position ?? 0 } };
  }

  async metadata(id: string): Promise<JsonObject | undefined> {
    const reference = this.read(id)?.metadata;
    const result = reference === undefined || reference === null ? undefined : v.parse(JsonObjectSchema, await this.payloads.read(reference));
    this.actor.assertCurrent();

    return result;
  }

  async page(request: PositionPageRequest = {}): Promise<Page<ConversationProjection, PositionCursor>> {
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

  /** The one read of the chat's newest entry: its id, and its position, which is the chat's length less one. */
  private newest(): { readonly id: string; readonly position: number } | undefined {
    this.actor.assertCurrent();

    return this.sql<{ id: string; position: number }>`SELECT id,position FROM conversation_entries
      WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} ORDER BY position DESC LIMIT 1`[0];
  }

  newestId(): string | null {
    return this.newest()?.id ?? null;
  }

  read(id: string): ConversationEntry | null {
    this.actor.assertCurrent();
    const { actorId } = this.actor;

    return withParts(this.sql<EntryWithPartRow>`SELECT e.id,e.position,e.role,e.turn_id,e.run_id,e.recorded_at,e.metadata_json,e.metadata_path,e.metadata_digest,
        e.context_id,e.context_revision,p.message_id,p.part_no,p.text_start,p.text_length
      FROM conversation_entries e LEFT JOIN conversation_entry_parts p ON p.actor_id=e.actor_id AND p.session_id=e.session_id AND p.entry_id=e.id
      WHERE e.actor_id=${actorId} AND e.session_id=${this.sessionId} AND e.id=${id} ORDER BY p.position`)[0] ?? null;
  }

  count(): number {
    return (this.newest()?.position ?? -1) + 1;
  }

  at(position: number): ConversationEntry | null {
    this.actor.assertCurrent();
    const row = this.sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND position=${position}`[0];

    return row === undefined ? null : this.read(row.id);
  }

  /** The context the nearest entry at or before `position` recorded; null if none did. */
  contextAt(position: number): ContextSelection | null {
    this.actor.assertCurrent();

    const row = this.sql<{ context_id: string; context_revision: number }>`SELECT context_id,context_revision FROM conversation_entries
      WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId} AND position <= ${position} AND context_id IS NOT NULL
      ORDER BY position DESC LIMIT 1`[0];

    return row === undefined ? null : { contextId: row.context_id, revision: row.context_revision };
  }

  /** The newest `limit` entries, oldest first, with their parts, in one statement. */
  entries(limit = 10_000): readonly ConversationEntry[] {
    this.actor.assertCurrent();
    const { actorId } = this.actor;

    return withParts(this.sql<EntryWithPartRow>`WITH newest AS (SELECT id,position FROM conversation_entries
        WHERE actor_id=${actorId} AND session_id=${this.sessionId} ORDER BY position DESC LIMIT ${limit})
      SELECT e.id,e.position,e.role,e.turn_id,e.run_id,e.recorded_at,e.metadata_json,e.metadata_path,e.metadata_digest,
        e.context_id,e.context_revision,p.message_id,p.part_no,p.text_start,p.text_length
      FROM newest CROSS JOIN conversation_entries e ON e.actor_id=${actorId} AND e.session_id=${this.sessionId} AND e.id=newest.id
      LEFT JOIN conversation_entry_parts p ON p.actor_id=e.actor_id AND p.session_id=e.session_id AND p.entry_id=e.id
      ORDER BY e.position, p.position`);
  }

  /** Each text part among `references`, oldest first. */
  async narration(references: readonly ConversationPartReference[]): Promise<string[]> {
    return (await this.parts(references)).flatMap((part) => (part.type === 'text' ? [v.parse(v.string(), part.text)] : []));
  }

  async parts(references: readonly ConversationPartReference[], cache = new Map<string, readonly StoredPart[]>()): Promise<JsonObject[]> {
    const parts: JsonObject[] = [];

    for (const ref of references) {
      let message = cache.get(ref.messageId);

      if (message === undefined) { message = await this.messages.materializeParts({ messageId: ref.messageId }); cache.set(ref.messageId, message); }

      const part = message.find(value => value.partNo === ref.partNo);

      if (part === undefined) throw new KinuError('io', 'conversation reference names a part its message does not hold');

      if (ref.textRange === undefined) parts.push(part.value);
      else {
        const { start, length } = ref.textRange;
        const text = v.parse(v.string(), part.value.text);

        if (part.value.type !== 'text' || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > text.length) throw new KinuError('io', 'conversation text range exceeds its recorded part');
        parts.push({ ...part.value, text: text.slice(start, start + length) });
      }
    }

    this.actor.assertCurrent();

    return parts;
  }

  async history(limit = 10_000): Promise<UIMessage[]> {
    const messages: UIMessage[] = [];

    const entries = this.entries(limit);
    const parts = await this.messages.materializePartsOf([...new Set(entries.flatMap((entry) => entry.parts.map((part) => part.messageId)))]);

    for (const entry of entries) messages.push(await this.materializeEntry(entry, parts));

    return messages;
  }

  /** Entries and their messages in one statement each, however many entries. */
  async newestFirst(limit = 10_000): Promise<readonly ConversationProjection[]> {
    const entries = [...this.entries(limit)].reverse().filter((entry) => entry.role === 'user' || entry.role === 'assistant');
    const parts = await this.messages.materializePartsOf([...new Set(entries.flatMap((entry) => entry.parts.map((part) => part.messageId)))]);
    const rows: ConversationProjection[] = [];

    for (const entry of entries) rows.push(await this.projectEntry(entry, parts));

    return rows;
  }

  newestUserId(): string | null {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${this.actor.actorId} AND session_id=${this.sessionId}
      AND role = 'user' ORDER BY position DESC LIMIT 1`[0]?.id ?? null;
  }

  lastUserMetadataReference(): SessionPayload | null {
    const newest = this.newestUserId();

    return newest === null ? null : this.read(newest)?.metadata ?? null;
  }

  async lastUserMetadata(): Promise<JsonObject | undefined> {
    const reference = this.lastUserMetadataReference();
    const metadata = reference === null ? undefined : v.parse(JsonObjectSchema, await this.payloads.read(reference));
    this.actor.assertCurrent();

    return metadata;
  }

  async operatorSpoke(): Promise<boolean> {
    for (const entry of this.entries()) {
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

  private async materializeEntry(entry: ConversationEntry, cache?: Map<string, readonly StoredPart[]>): Promise<UIMessage> {
      const parts: JsonObject[] = [];

      for (const part of await this.parts(entry.parts, cache)) parts.push(part.type === 'file' || part.type === 'image' ? await this.payloads.resolveMedia(part) : part);
      const projected = drawnParts(parts, entry.role);
      const message: StoredUiMessage = { id: entry.id, role: entry.role, parts: projected };

      if (entry.metadata !== null) message.metadata = await this.payloads.read(entry.metadata);
      this.actor.assertCurrent();

      // Drawn from this store's own rows, so the SDK's validator, which walked every part of every read, is not run.
      const drawn = v.safeParse(UIMessageSchema, message);

      if (!drawn.success) throw new KinuError('io', 'conversation entry did not materialize');

      return drawn.output;
  }
}

/** Every row's parts point at `reference`. */
interface SteerBatch {
  readonly rows: readonly {
    readonly id: string;
    readonly text: string;
    readonly metadata: JsonObject;
    readonly files?: ReadonlyArray<PromptFile>;
  }[];
  readonly reference: MessageReference;
  readonly turnId: string;
  readonly runId: string;
}

interface TranscriptWriterStores extends TranscriptStores<ActorHandle, SessionPayloads> {
  readonly messages: SessionMessages;
  /** Runs one write as a transaction on the same connection as `sql`. */
  readonly atomic: <T>(write: () => T) => T;
  /** Stamped on entries naming no context, so a fork at that entry restores the model context held there. */
  readonly selection: () => ContextSelection | null;
}

export class SessionTranscript extends SessionTranscriptReader<ActorHandle, SessionPayloads> {
  private readonly atomic: <T>(write: () => T) => T;
  private readonly selection: () => ContextSelection | null;

  constructor(stores: TranscriptWriterStores) {
    super(stores);
    this.atomic = stores.atomic;
    this.selection = stores.selection;
  }

  async prepareSteers(batch: SteerBatch): Promise<PreparedConversationEntry[]> {
    const { rows, reference, turnId, runId } = batch;
    const textPart = rows.reduce((count, row) => count + (row.files?.length ?? 0), 0);
    let filePart = 0;
    let start = 0;
    const entries: PreparedConversationEntry[] = [];

    for (const row of rows) {
      const parts: ConversationPartReference[] = [];

      for (const _file of row.files ?? []) parts.push({ messageId: reference.messageId, partNo: filePart++ });
      parts.push({ messageId: reference.messageId, partNo: textPart, textRange: { start, length: row.text.length } });
      entries.push({ id: row.id, role: 'user', turnId, runId, parts, metadata: await this.payloads.prepare(row.metadata) });
      start += row.text.length + 2;
    }

    return entries;
  }

  async prepareUser(input: { readonly id: string; readonly turnId: string; readonly runId?: string; readonly message: MessageReference; readonly metadata?: JsonObject }): Promise<PreparedConversationEntry> {
    const parts = await this.messages.materializeParts(input.message);

    return { id: input.id, role: 'user', turnId: input.turnId, runId: input.runId ?? null,
      metadata: input.metadata === undefined ? null : await this.payloads.prepare(input.metadata),
      parts: parts.map(part => ({ messageId: input.message.messageId, partNo: part.partNo })) };
  }

  /** The row keeps every streamed part in order; a recorded answer replaces the trailing texts it is made of, else follows. */
  async prepareAssistant(input: { readonly id: string; readonly turnId: string; readonly runId: string; readonly parts: readonly MessagePartReference[]; readonly finalText: MessagePartReference | null; readonly metadata?: JsonObject }): Promise<PreparedConversationEntry> {
    const parts = [...input.parts];
    const finalText = input.finalText;

    if (finalText !== null && !parts.some((part) => part.messageId === finalText.messageId && part.partNo === finalText.partNo)) {
      const covered = answeredTexts(await this.parts(input.parts), rowText({ role: 'assistant', parts: await this.parts([finalText]) }));
      const [last, ...continued] = covered;

      if (last === undefined) parts.push(finalText);
      else parts[last] = finalText;

      for (const index of continued) parts.splice(index, 1);
    }

    return { id: input.id, role: 'assistant', turnId: input.turnId, runId: input.runId,
      metadata: input.metadata === undefined ? null : await this.payloads.prepare(input.metadata), parts };
  }

  appendUser(entry: PreparedConversationEntry): void {
    this.atomic(() => { if (!this.has(entry.id)) this.record(entry); });
  }

  appendAssistant(entry: PreparedConversationEntry): void {
    this.record(entry);
  }

  record(entry: PreparedConversationEntry): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      const actorId = this.actor.actorId;
      const context = entry.context === undefined ? this.selection() : entry.context;
      void this.sql`INSERT INTO conversation_entries(actor_id,session_id,id,position,role,turn_id,run_id,metadata_json,metadata_path,metadata_digest,recorded_at,context_id,context_revision)
        VALUES(${actorId},${this.sessionId},${entry.id},${this.count()},${entry.role},${entry.turnId},${entry.runId},${entry.metadata?.json ?? null},${entry.metadata?.path ?? null},${entry.metadata?.digest ?? null},${Date.now()},${context?.contextId ?? null},${context?.revision ?? null})`;

      for (const [position, part] of entry.parts.entries()) {
        void this.sql`INSERT INTO conversation_entry_parts(actor_id,session_id,entry_id,position,message_id,part_no,text_start,text_length)
          VALUES(${actorId},${this.sessionId},${entry.id},${position},${part.messageId},${part.partNo},${part.textRange?.start ?? null},${part.textRange?.length ?? null})`;
      }
    });
  }

  /** The newest user row's turn, its empty failed answer dropped; null without one. */
  reopenNewestTurn(): ConversationEntry | null {
    const newest = this.newestUserId();
    const row = newest === null ? null : this.read(newest);
    const opener = row === null ? null : this.read(row.turnId ?? row.id);

    if (opener?.role !== 'user') return null;
    const last = this.at(this.count() - 1);

    if (last?.role === 'assistant' && last.parts.length === 0 && last.turnId === opener.id) this.truncate(last.position);

    return opener;
  }

  /** A rewind: `position` and everything after it is deleted, parts with it; the chat keeps no branch. */
  truncate(position: number): void {
    this.atomic(() => {
      this.actor.assertCurrent();
      const { actorId } = this.actor;

      // Explicit, not left to the cascade: a retried turn re-records its message under the same id.
      void this.sql`DELETE FROM conversation_entry_parts WHERE actor_id=${actorId} AND session_id=${this.sessionId}
        AND entry_id IN (SELECT id FROM conversation_entries WHERE actor_id=${actorId} AND session_id=${this.sessionId} AND position >= ${position})`;
      void this.sql`DELETE FROM conversation_entries WHERE actor_id=${actorId} AND session_id=${this.sessionId} AND position >= ${position}`;
    });
  }

  /** Clear the public view, not execution history or model context. */
  clear(): void {
    this.truncate(0);
  }
}


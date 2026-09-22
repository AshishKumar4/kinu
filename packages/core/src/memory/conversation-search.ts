/**
 * Zero-LLM FTS5 transcript search over every session except MCTS trees. The index is derived and
 * disposable, fed from the canonical store by a rowid watermark; operations are async because entry
 * text is projected by `SessionTranscriptReader.project`.
 */

import { fillToCapacity, relaxFtsQuery, sanitizeFtsQuery } from '@kinu.run/agent-utils/memory';
import * as v from 'valibot';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { boundedInt } from '../utils/bounds';
import { KinuError } from '../obs/error';
// MCTS sessions hold tree nodes, not conversation: excluded from indexing and browse.
import { MCTS_SESSION_ID } from '../session/transcript-schema';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { SessionTranscriptReader } from '../session/transcript';

/** A default, not a ceiling: scroll honours the caller's max_chars. */
const MAX_MESSAGE_CHARS = 700;

const SNIPPET_TOKENS = 24;

/** Finite integers >= 50 pass through; anything else takes the default. */
const MaxCharsSchema = v.optional(v.pipe(v.number(), v.finite(), v.integer(), v.minValue(50)));

export interface ConversationSearchHit {
  conversationId: string;
  messageId: string;
  role: string;
  createdAt: number;
  snippet: string;
}

export interface ConversationScrollMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  anchor?: true;
}

export interface ConversationScrollResult {
  conversationId: string;
  messages: ConversationScrollMessage[];
  messagesBefore: number;
  messagesAfter: number;
}

export interface ConversationSummary {
  conversationId: string;
  messageCount: number;
  startedAt: number;
  lastActiveAt: number;
  preview: string;
}

function truncate(text: string, maxChars = MAX_MESSAGE_CHARS): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars — pass max_chars to read the full message]`
    : text;
}

interface EntryRow { id: string; session_id: string; role: string; recorded_at: number; rid: number }

interface HitRow { msg_id: string; session_id: string; role: string; created_at: number; snip: string }

function toHit(row: HitRow): ConversationSearchHit {
  return {
    conversationId: row.session_id,
    messageId: row.msg_id,
    role: row.role,
    createdAt: row.created_at,
    snippet: row.snip,
  };
}

/** SQLite reissues rowids a delete freed, so any purge forces a rebuild; inserts append from `synced_rowid`. */
interface SyncState { actor_id: string; rev: number; purges: number; synced_rev: number; synced_purges: number; synced_rowid: number }

function ensureIndexTables(sql: SqlExecutor): void {
  void sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
      content, msg_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
    )`;
  // Shared hosts hold several actors in one database; a mismatched `actor_id` rebuilds the index.
  void sql`
    CREATE TABLE IF NOT EXISTS conversation_fts_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      actor_id TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      purges INTEGER NOT NULL DEFAULT 0,
      synced_rev INTEGER NOT NULL DEFAULT -1,
      synced_purges INTEGER NOT NULL DEFAULT -1,
      synced_rowid INTEGER NOT NULL DEFAULT 0
    )`;
  void sql`
    INSERT OR IGNORE INTO conversation_fts_state (id, actor_id, rev, purges, synced_rev, synced_purges, synced_rowid)
    VALUES (1, ${''}, 0, 0, -1, -1, 0)`;
}

export class ConversationSearchStore {
  private ensured = false;
  private syncing: Promise<void> | null = null;
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly transcriptFor: (sessionId: string) => SessionTranscriptReader,
  ) {
    this.actorId = actor.actorId;
  }

  /** Strict all-term page, then ranked partial matches until full ({@link fillToCapacity}). */
  async search(query: string, limit = 5): Promise<ConversationSearchHit[]> {
    this.actor.assertCurrent();
    await this.ensure();

    if (!query.trim()) return [];
    const capacity = boundedInt(limit, 1, 1, 10);
    const safe = sanitizeFtsQuery(query);
    const strict = this.runFtsQuery(safe, capacity);
    const relaxed = strict.length >= capacity ? null : relaxFtsQuery(safe);

    const rows = relaxed === null
      ? strict
      : fillToCapacity(strict, this.runFtsQuery(relaxed, capacity), capacity, (row) => row.msg_id);

    return rows.map(toHit);
  }

  async scroll(aroundMessageId: string, window = 5, maxChars?: number): Promise<ConversationScrollResult | null> {
    this.actor.assertCurrent();
    await this.ensure();

    // Entry ids are unique per session only: the chat answers an ambiguous anchor first.
    const anchor = this.sql<EntryRow>`
      SELECT id, session_id, role, recorded_at, rowid AS rid FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND id = ${aroundMessageId}
      ORDER BY session_id = ${CHAT_SESSION_ID} DESC, rowid ASC LIMIT 1`[0];

    if (anchor === undefined) return null;
    const w = boundedInt(window, 1, 1, 20);

    // Rowid is total insertion order, so no timestamp tie-break is needed.
    const before = this.sql<EntryRow>`
      SELECT id, session_id, role, recorded_at, rowid AS rid FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id = ${anchor.session_id} AND rowid < ${anchor.rid}
      ORDER BY rowid DESC LIMIT ${w}`.reverse();

    const after = this.sql<EntryRow>`
      SELECT id, session_id, role, recorded_at, rowid AS rid FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id = ${anchor.session_id} AND rowid > ${anchor.rid}
      ORDER BY rowid ASC LIMIT ${w}`;

    const totalBefore = this.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id = ${anchor.session_id} AND rowid < ${anchor.rid}`[0]?.c ?? 0;

    const totalAfter = this.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id = ${anchor.session_id} AND rowid > ${anchor.rid}`[0]?.c ?? 0;

    const parsedMaxChars = v.safeParse(MaxCharsSchema, maxChars);

    const perMessage = parsedMaxChars.success && parsedMaxChars.output !== undefined
      ? parsedMaxChars.output
      : MAX_MESSAGE_CHARS;

    // An entry deleted mid-projection quotes as empty; the next sync drops it.
    const quote = async (row: EntryRow): Promise<ConversationScrollMessage> => ({
      id: row.id,
      role: row.role,
      content: truncate((await this.transcriptFor(row.session_id).project(row.id))?.content ?? '', perMessage),
      createdAt: row.recorded_at,
    });

    const messages: ConversationScrollMessage[] = [];

    for (const row of before) messages.push(await quote(row));
    messages.push({ ...await quote(anchor), anchor: true });

    for (const row of after) messages.push(await quote(row));

    return {
      conversationId: anchor.session_id,
      messages,
      messagesBefore: totalBefore - before.length,
      messagesAfter: totalAfter - after.length,
    };
  }

  async browse(limit = 10): Promise<ConversationSummary[]> {
    this.actor.assertCurrent();
    await this.ensure();
    const lim = boundedInt(limit, 1, 1, 20);

    const groups = this.sql<{ session_id: string; n: number; started_at: number; last_active: number }>`
      SELECT session_id, COUNT(*) AS n, MIN(recorded_at) AS started_at, MAX(recorded_at) AS last_active
      FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id <> ${MCTS_SESSION_ID}
      GROUP BY session_id ORDER BY last_active DESC LIMIT ${lim}`;

    const conversations: ConversationSummary[] = [];

    for (const group of groups) {
      const first = this.sql<{ id: string }>`
        SELECT id FROM conversation_entries
        WHERE actor_id = ${this.actorId} AND session_id = ${group.session_id} AND role = 'user'
        ORDER BY rowid ASC LIMIT 1`[0];

      const opening = first === undefined ? null : await this.transcriptFor(group.session_id).project(first.id);

      conversations.push({
        conversationId: group.session_id,
        messageCount: group.n,
        startedAt: group.started_at,
        lastActiveAt: group.last_active,
        preview: truncate(opening?.content ?? ''),
      });
    }

    return conversations;
  }

  /** Triggers are table-wide: a trigger cannot carry a bound actor. */
  private async ensure(): Promise<void> {
    if (!this.ensured) {
      ensureIndexTables(this.sql);
      void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_entries_ai AFTER INSERT ON conversation_entries BEGIN
        UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
      void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_entries_ad AFTER DELETE ON conversation_entries BEGIN
        UPDATE conversation_fts_state SET rev = rev + 1, purges = purges + 1 WHERE id = 1; END`;
      this.ensured = true;
    }

    await this.refreshIndex();
  }

  /** One sync at a time: projection awaits, so interleaved syncs would double-index. A failed sync invalidates the index. */
  private async refreshIndex(): Promise<void> {
    const pending = this.syncing;

    if (pending !== null) {
      await pending;

      return;
    }

    const run = this.sync();
    this.syncing = run;

    try { await run; }
    catch (cause) {
      invalidateConversationSearchIndex(this.sql);
      throw cause;
    }
    finally { this.syncing = null; }
  }

  private async sync(): Promise<void> {
    const state = this.sql<SyncState>`
      SELECT actor_id, rev, purges, synced_rev, synced_purges, synced_rowid
      FROM conversation_fts_state WHERE id = 1`[0];

    if (state === undefined) throw new KinuError('io', 'the transcript search index lost its sync state');
    const rebuild = state.actor_id !== this.actorId || state.purges !== state.synced_purges;

    if (!rebuild && state.rev === state.synced_rev) return;

    if (rebuild) void this.sql`DELETE FROM conversation_fts`;
    const watermark = rebuild ? 0 : state.synced_rowid;

    const rows = this.sql<EntryRow>`
      SELECT id, session_id, role, recorded_at, rowid AS rid FROM conversation_entries
      WHERE actor_id = ${this.actorId} AND session_id <> ${MCTS_SESSION_ID}
        AND role IN ('user', 'assistant') AND rowid > ${watermark}
      ORDER BY rowid ASC`;

    let synced = watermark;

    for (const row of rows) {
      const projected = await this.transcriptFor(row.session_id).project(row.id);

      if (projected !== null) {
        void this.sql`
          INSERT INTO conversation_fts (content, msg_id, session_id, role, created_at)
          VALUES (${projected.content}, ${row.id}, ${row.session_id}, ${row.role}, ${row.recorded_at})`;
      }

      synced = row.rid;
    }

    // Record the counters this sync read: writes landing during projection belong to the next pass.
    void this.sql`
      UPDATE conversation_fts_state
      SET actor_id = ${this.actorId}, synced_rev = ${state.rev}, synced_purges = ${state.purges}, synced_rowid = ${synced}
      WHERE id = 1`;
  }

  /** Rowid breaks bm25 ties so merged pages are reproducible. */
  private runFtsQuery(ftsQuery: string, limit: number): HitRow[] {
    return this.sql<HitRow>`
      SELECT msg_id, session_id, role, created_at,
             snippet(conversation_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip
      FROM conversation_fts
      WHERE conversation_fts MATCH ${ftsQuery}
        AND role IN ('user', 'assistant')
      ORDER BY bm25(conversation_fts) ASC, rowid ASC
      LIMIT ${limit}`;
  }
}

/** Called by every conversation mutation a rowid watermark cannot see (purge-and-reseed, reassignment, id reuse); the next refresh rebuilds. */
export function invalidateConversationSearchIndex(sql: SqlExecutor): void {
  ensureIndexTables(sql);
  void sql`
    UPDATE conversation_fts_state
    SET actor_id = ${''}, synced_rev = -1, synced_purges = -1, synced_rowid = 0 WHERE id = 1`;
}

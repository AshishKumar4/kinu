/**
 * Actor-owned FTS5 transcript search across its sessions. The derived index uses per-actor revision and purge
 * cursors; projection awaits outside an atomic publish, so readers never observe another actor's index or a half-build.
 */

import { searchFts } from '@kinu.run/agent-utils/memory';
import { Effect } from 'effect';
import * as v from 'valibot';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { boundedInt } from '../utils/bounds';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
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
    ? `${text.slice(0, maxChars)}... [+${text.length - maxChars} chars: pass max_chars to read the full message]`
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
      content, actor_id UNINDEXED, msg_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
    )`;
  void sql`
    CREATE TABLE IF NOT EXISTS conversation_fts_state (
      actor_id TEXT PRIMARY KEY NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      purges INTEGER NOT NULL DEFAULT 0,
      synced_rev INTEGER NOT NULL DEFAULT -1,
      synced_purges INTEGER NOT NULL DEFAULT -1,
      synced_rowid INTEGER NOT NULL DEFAULT 0
    )`;
}

export interface ConversationRecall {
  search(query: string, limit?: number): Promise<ConversationSearchHit[]>;
  scroll(aroundMessageId: string, window?: number, maxChars?: number): Promise<ConversationScrollResult | null>;
  browse(limit?: number): Promise<ConversationSummary[]>;
}

export class ConversationSearchStore implements ConversationRecall {
  private ensured = false;
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly transcriptFor: (sessionId: string) => SessionTranscriptReader,
    private readonly transactionSync: (write: () => void) => void,
  ) {
    this.actorId = actor.actorId;
  }

  /** Strict all-term page, then ranked partial matches until full. */
  search(query: string, limit = 5): Promise<ConversationSearchHit[]> {
    return settle(Effect.map(this.ensure(), () => this.searchIndexed(query, limit)));
  }

  scroll(aroundMessageId: string, window = 5, maxChars?: number): Promise<ConversationScrollResult | null> {
    return settle(Effect.flatMap(this.ensure(), () => Effect.promise(() => this.scrollIndexed(aroundMessageId, window, maxChars))));
  }

  browse(limit = 10): Promise<ConversationSummary[]> {
    return settle(Effect.flatMap(this.ensure(), () => Effect.promise(() => this.browseIndexed(limit))));
  }

  private searchIndexed(query: string, limit: number): ConversationSearchHit[] {
    if (!query.trim()) return [];
    const capacity = boundedInt(limit, 1, 1, 10);
    const rows = searchFts(query, capacity, (match, size) => this.runFtsQuery(match, size), (row) => row.msg_id);

    return rows.map(toHit);
  }

  private async scrollIndexed(aroundMessageId: string, window: number, maxChars: number | undefined): Promise<ConversationScrollResult | null> {
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

  private async browseIndexed(limit: number): Promise<ConversationSummary[]> {
    const lim = boundedInt(limit, 1, 1, 20);

    const groups = this.sql<{ session_id: string; n: number; started_at: number; last_active: number }>`
      SELECT session_id, COUNT(*) AS n, MIN(recorded_at) AS started_at, MAX(recorded_at) AS last_active
      FROM conversation_entries
      WHERE actor_id = ${this.actorId}
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
  private ensure(): Effect.Effect<void, KinuError> {
    return Effect.suspend(() => {
      this.actor.assertCurrent();

      if (!this.ensured) {
        ensureIndexTables(this.sql);
        void this.sql`INSERT OR IGNORE INTO conversation_fts_state (actor_id) VALUES (${this.actorId})`;
        void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_entries_ai AFTER INSERT ON conversation_entries BEGIN
          INSERT INTO conversation_fts_state (actor_id, rev) VALUES (NEW.actor_id, 1)
          ON CONFLICT(actor_id) DO UPDATE SET rev = rev + 1; END`;
        void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_entries_ad AFTER DELETE ON conversation_entries BEGIN
          INSERT INTO conversation_fts_state (actor_id, rev, purges) VALUES (OLD.actor_id, 1, 1)
          ON CONFLICT(actor_id) DO UPDATE SET rev = rev + 1, purges = purges + 1;
          DELETE FROM conversation_fts WHERE actor_id = OLD.actor_id AND rowid = OLD.rowid; END`;
        this.ensured = true;
      }

      return this.sync();
    });
  }

  private syncState(): SyncState {
    const state = this.sql<SyncState>`
      SELECT actor_id, rev, purges, synced_rev, synced_purges, synced_rowid
      FROM conversation_fts_state WHERE actor_id = ${this.actorId}`[0];

    if (state === undefined) throw new KinuError('io', 'the actor transcript index lost its sync state');

    return state;
  }

  private sync(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const state = this.syncState();
        const rebuild = state.purges !== state.synced_purges;

        if (!rebuild && state.rev === state.synced_rev) return;

        const watermark = rebuild ? 0 : state.synced_rowid;

        const rows = this.sql<EntryRow>`
          SELECT id, session_id, role, recorded_at, rowid AS rid FROM conversation_entries
          WHERE actor_id = ${this.actorId} AND role IN ('user', 'assistant') AND rowid > ${watermark}
          ORDER BY rowid ASC`;

        const projections: { row: EntryRow; content: string }[] = [];

        for (const row of rows) {
          const projected = yield* Effect.promise(() => this.transcriptFor(row.session_id).project(row.id));

          if (projected !== null) projections.push({ row, content: projected.content });
        }

        let committed = false;

        this.transactionSync(() => {
          this.actor.assertCurrent();
          const current = this.syncState();

          // A purge changes canonical row identities; project that new generation rather than publishing stale text.
          if (current.purges !== state.purges) return;
          committed = true;

          // Another refresh may have already published this snapshot, without any per-instance lock.
          if (current.synced_purges === state.purges && current.synced_rev >= state.rev) return;

          if (rebuild) void this.sql`DELETE FROM conversation_fts WHERE actor_id = ${this.actorId}`;

          for (const { row, content } of projections) {
            void this.sql`
              INSERT OR REPLACE INTO conversation_fts (rowid, content, actor_id, msg_id, session_id, role, created_at)
              VALUES (${row.rid}, ${content}, ${this.actorId}, ${row.id}, ${row.session_id}, ${row.role}, ${row.recorded_at})`;
          }

          const synced = Math.max(rebuild ? 0 : current.synced_rowid, rows[rows.length - 1]?.rid ?? watermark);

          void this.sql`
            UPDATE conversation_fts_state
            SET synced_rev = ${state.rev}, synced_purges = ${state.purges}, synced_rowid = ${synced}
            WHERE actor_id = ${this.actorId}`;
        });

        if (committed) return;
      }
    });
  }

  /** Rowid breaks bm25 ties so merged pages are reproducible. */
  private runFtsQuery(ftsQuery: string, limit: number): HitRow[] {
    return this.sql<HitRow>`
      SELECT msg_id, session_id, role, created_at,
             snippet(conversation_fts, 0, '[', ']', '...', ${SNIPPET_TOKENS}) AS snip
      FROM conversation_fts
      WHERE conversation_fts MATCH ${ftsQuery}
        AND actor_id = ${this.actorId}
        AND role IN ('user', 'assistant')
      ORDER BY bm25(conversation_fts) ASC, rowid ASC
      LIMIT ${limit}`;
  }
}

/** Called by every conversation mutation a rowid watermark cannot see (purge-and-reseed, reassignment, id reuse); the next refresh rebuilds. */
export function invalidateConversationSearchIndex(sql: SqlExecutor, actorId: string): void {
  ensureIndexTables(sql);
  void sql`
    INSERT INTO conversation_fts_state (actor_id, rev, purges) VALUES (${actorId}, 1, 1)
    ON CONFLICT(actor_id) DO UPDATE SET rev = rev + 1, purges = purges + 1`;
}

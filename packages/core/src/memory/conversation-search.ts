/**
 * Zero-LLM transcript search over the canonical conversation store. FTS5 covers
 * the workspace's default-chat authority (the SDK pane store where a backend
 * keeps one, `messages` on the CLI) plus the independent non-default sessions
 * (`messages` rows that are neither the default chat nor MCTS trees).
 *
 * Three operations:
 *   - search(query)        — ranked FTS5 snippets with conversation/message refs
 *   - scroll(messageId)    — a ±window slice of messages around an anchor
 *   - browse()             — recent conversation roots with counts
 *
 * The index is DERIVED and disposable: a plain fts5 table fed from the
 * authority by a watermark sync, never an authority itself. It carries its own
 * reference columns, so no join back into any mirror table can make stale
 * projection rows answer a query.
 */

import { fillToCapacity, relaxFtsQuery, sanitizeFtsQuery } from '@kinu.run/agent-utils/memory';
import * as v from 'valibot';
import { CHAT_SESSION_ID, hasPaneStore, paneStampMs } from '../identity/conversation-store';
import { boundedInt } from '../utils/bounds';
import type { SqlExecutor } from '../types/primitives';
import { uiMessageText } from '../utils/ui-message';

// session_id 'mcts' holds MCTS tree nodes, not conversation — excluded from
// indexing, search and browse below. A scroll may still anchor one: a
// non-default tree is a different tree, not a hidden one.
/** Default per-message budget in scroll/browse results. A DEFAULT, not a
 *  ceiling: scroll honours the caller's max_chars, because scroll IS the
 *  read-back path — a recall surface whose reads are capped with no way to
 *  ask for more is a keyhole, not recall. */
const MAX_MESSAGE_CHARS = 700;
const SNIPPET_TOKENS = 24;

/** Caller max_chars at the scroll boundary. Finite integers of 50 or more
 *  pass through untouched, so large read-backs keep working. Anything else
 *  means unstated and takes the default, the same way sibling bounds treat
 *  non-finite input. */
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
  /** Messages in the conversation earlier than the returned window. */
  messagesBefore: number;
  /** Messages in the conversation later than the returned window. */
  messagesAfter: number;
}

export interface ConversationSummary {
  conversationId: string;
  messageCount: number;
  startedAt: number;
  lastActiveAt: number;
  /** The session's first user message, truncated. */
  preview: string;
}

function truncate(text: string, maxChars = MAX_MESSAGE_CHARS): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars — pass max_chars to read the full message]`
    : text;
}

/** A row as its owning store writes it: the pane stamps whole-second
 *  datetimes, plain rows stamp ms numbers. */
interface PaneRaw { id: string; session_id: string; role: string; content: string; created_at: string; rid: number }
interface PlainRaw { id: string; session_id: string; role: string; content: string; created_at: number; rid: number }

/** A fetched row with its stamp already normalized to UTC ms — done at the
 *  fetch site, where the owning store is statically known. */
interface FetchedRow extends Omit<PaneRaw, 'created_at'> {
  createdAtMs: number;
}

function withPaneStamp(row: PaneRaw): FetchedRow {
  const { created_at, ...rest } = row;
  return { ...rest, createdAtMs: paneStampMs(created_at) };
}

function withPlainStamp(row: PlainRaw): FetchedRow {
  const { created_at, ...rest } = row;
  return { ...rest, createdAtMs: created_at };
}

interface HitRow { id: string; msg_id: string; session_id: string; role: string; created_at: number; snip: string }

function toHit(row: HitRow): ConversationSearchHit {
  return {
    conversationId: row.session_id,
    messageId: row.msg_id,
    role: row.role,
    createdAt: row.created_at,
    snippet: row.snip,
  };
}

/**
 * Which regime the index was built under. When the SDK creates its pane store
 * mid-life (its first hosted append), the plain default rows stop being chat —
 * they become retired mirror rows — so the regime flip forces a rebuild rather
 * than letting pre-pane rows answer queries beside their rich twins.
 */
type IndexRegime = 'pane' | 'plain';

export class ConversationSearchStore {
  private ensured = false;

  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Ranked FTS5 hits, best first: the strict all-term page, then ranked partial
   * matches until the page is full. One fill policy, shared with the memory
   * chunk surface — {@link fillToCapacity} carries the invariant and the proof
   * that one partial page of `capacity` rows finishes the fill.
   *
   * Broadening only when the strict query came back EMPTY left an underfull page
   * underfull and silently dropped every relevant partial.
   */
  search(query: string, limit = 5): ConversationSearchHit[] {
    this.ensure();
    this.refreshIndex();
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

  /** A window of ±`window` messages around the anchor message, in transcript
   *  order. Returns null when the anchor id doesn't exist. */
  scroll(aroundMessageId: string, window = 5, maxChars?: number): ConversationScrollResult | null {
    this.ensure();
    this.refreshIndex();
    // The anchor resolves in whichever store owns it: the pane for default-chat
    // ids, `messages` for non-default trees.
    const pane = hasPaneStore(this.sql);
    const paneAnchor = pane
      ? this.sql<PaneRaw>`
          SELECT id, session_id, role, content, created_at, rowid AS rid
          FROM assistant_messages WHERE id = ${aroundMessageId}`[0]
      : undefined;
    let anchor: FetchedRow;
    if (paneAnchor !== undefined) {
      anchor = withPaneStamp(paneAnchor);
    } else {
      // A miss in the pane store falls to `messages` — the non-default trees
      // (mcts, local peers) live only there.
      // Where the pane owns the backend, plain `default` rows are the retired
      // mirror — a non-pane id must not resolve against them. Without the pane
      // they ARE the chat (the CLI), so every session anchors.
      const plainAnchor = (pane
        ? this.sql<PlainRaw>`
            SELECT id, session_id, role, content, created_at, rowid AS rid
            FROM messages
            WHERE id = ${aroundMessageId} AND session_id <> ${CHAT_SESSION_ID}`[0]
        : this.sql<PlainRaw>`
            SELECT id, session_id, role, content, created_at, rowid AS rid
            FROM messages WHERE id = ${aroundMessageId}`[0]);
      if (plainAnchor === undefined) return null;
      anchor = withPlainStamp(plainAnchor);
    }
    const source: IndexRegime = paneAnchor !== undefined ? 'pane' : 'plain';
    const row = anchor;
    const w = boundedInt(window, 1, 1, 20);

    // Rowid is total and is insertion order, so the window needs no timestamp
    // tie-break — the same reason history paging seeks on it. The four
    // window/count queries are written out per store: the operators are SQL,
    // and SQL cannot ride a binding.
    const paneSide = source === 'pane';
    const before = (paneSide
      ? this.sql<PaneRaw>`
          SELECT id, role, content, created_at, rowid AS rid FROM assistant_messages
          WHERE session_id = ${row.session_id} AND rowid < ${row.rid}
          ORDER BY rowid DESC LIMIT ${w}`.map(withPaneStamp)
      : this.sql<PlainRaw>`
          SELECT id, role, content, created_at, rowid AS rid FROM messages
          WHERE session_id = ${row.session_id} AND rowid < ${row.rid}
          ORDER BY rowid DESC LIMIT ${w}`.map(withPlainStamp)).reverse();
    const after = paneSide
      ? this.sql<PaneRaw>`
          SELECT id, role, content, created_at, rowid AS rid FROM assistant_messages
          WHERE session_id = ${row.session_id} AND rowid > ${row.rid}
          ORDER BY rowid ASC LIMIT ${w}`.map(withPaneStamp)
      : this.sql<PlainRaw>`
          SELECT id, role, content, created_at, rowid AS rid FROM messages
          WHERE session_id = ${row.session_id} AND rowid > ${row.rid}
          ORDER BY rowid ASC LIMIT ${w}`.map(withPlainStamp);
    const totalBefore = (paneSide
      ? this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM assistant_messages
          WHERE session_id = ${row.session_id} AND rowid < ${row.rid}`
      : this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM messages
          WHERE session_id = ${row.session_id} AND rowid < ${row.rid}`)[0]!.c;
    const totalAfter = (paneSide
      ? this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM assistant_messages
          WHERE session_id = ${row.session_id} AND rowid > ${row.rid}`
      : this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM messages
          WHERE session_id = ${row.session_id} AND rowid > ${row.rid}`)[0]!.c;

    const parsedMaxChars = v.safeParse(MaxCharsSchema, maxChars);
    const perMessage = parsedMaxChars.success && parsedMaxChars.output !== undefined
      ? parsedMaxChars.output
      : MAX_MESSAGE_CHARS;
    // Pane rows carry the serialized UI message; its text parts are what a
    // recall surface quotes. Plain rows already hold plain text.
    const toMessage = (m: FetchedRow): ConversationScrollMessage => ({
      id: m.id, role: m.role,
      content: truncate(source === 'pane' ? uiMessageText(m.content) : m.content, perMessage),
      createdAt: m.createdAtMs,
    });
    return {
      conversationId: sessionIdOf(row.session_id),
      messages: [...before.map(toMessage), { ...toMessage(row), anchor: true }, ...after.map(toMessage)],
      messagesBefore: totalBefore - before.length,
      messagesAfter: totalAfter - after.length,
    };
  }

  /** Recent conversation roots, most recently active first. */
  browse(limit = 10): ConversationSummary[] {
    this.ensure();
    this.refreshIndex();
    const lim = boundedInt(limit, 1, 1, 20);
    interface GroupBase { session_id: string; n: number }
    interface PaneGroup extends GroupBase { started_at: string; last_active: string }
    interface PlainGroup extends GroupBase { started_at: number; last_active: number }
    interface Group extends GroupBase {
      source: 'pane' | 'plain';
      startedAtMs: number;
      lastActiveAtMs: number;
    }

    /** Each source's aggregates are stamped in its own encoding and normalized
     *  at the fetch site — the pane's datetimes via {@link paneStampMs}. */
    const withPaneStamps = (g: PaneGroup): Group =>
      ({ source: 'pane', session_id: g.session_id, n: g.n, startedAtMs: paneStampMs(g.started_at), lastActiveAtMs: paneStampMs(g.last_active) });
    const withPlainStamps = (g: PlainGroup): Group =>
      ({ source: 'plain', session_id: g.session_id, n: g.n, startedAtMs: g.started_at, lastActiveAtMs: g.last_active });

    let groups: Group[];
    if (hasPaneStore(this.sql)) {
      groups = [
        // Default chat lives in the pane; plain default rows would be the
        // retired mirror — never listed beside their rich twins.
        ...this.sql<PaneGroup>`
          SELECT session_id, COUNT(*) AS n, MIN(created_at) AS started_at, MAX(created_at) AS last_active
          FROM assistant_messages GROUP BY session_id`.map(withPaneStamps),
        ...this.sql<PlainGroup>`
          SELECT session_id, COUNT(*) AS n, MIN(created_at) AS started_at, MAX(created_at) AS last_active
          FROM messages
          WHERE session_id NOT IN (${CHAT_SESSION_ID}, 'mcts')
          GROUP BY session_id`.map(withPlainStamps),
      ];
    } else {
      groups = this.sql<PlainGroup>`
        SELECT session_id, COUNT(*) AS n, MIN(created_at) AS started_at, MAX(created_at) AS last_active
        FROM messages
        WHERE session_id NOT IN ('mcts')
        GROUP BY session_id`.map(withPlainStamps);
    }

    return groups
      .map((conversation) => {
        const firstUser: FetchedRow | undefined = conversation.source === 'pane'
          ? this.sql<PaneRaw>`
              SELECT id, session_id, role, content, created_at, rowid AS rid
              FROM assistant_messages
              WHERE session_id = ${conversation.session_id} AND role = 'user'
              ORDER BY rowid ASC LIMIT 1`.map(withPaneStamp)[0]
          : this.sql<PlainRaw>`
              SELECT id, session_id, role, content, created_at, rowid AS rid
              FROM messages
              WHERE session_id = ${conversation.session_id} AND role = 'user'
              ORDER BY rowid ASC LIMIT 1`.map(withPlainStamp)[0];
        return {
          conversationId: sessionIdOf(conversation.session_id),
          messageCount: conversation.n,
          startedAt: conversation.startedAtMs,
          lastActiveAt: conversation.lastActiveAtMs,
          preview: truncate(firstUser ? uiMessageText(firstUser.content) : ''),
        };
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, lim);
  }

  // ── Derived index maintenance ─────────────────────────────────────────────

  /**
   * Idempotent: drop the mirror-era index, create the derived one, then sync.
   *
   * The old shape was external-content fts5 over `messages` with sync triggers
   * — an index OF THE MIRROR, which stopped being the transcript when the
   * reconciler died. That state is disposable by definition, so it is dropped
   * once here and rebuilt from the authority.
   */
  private ensure(): void {
    if (this.ensured) return;
    void this.sql`DROP TRIGGER IF EXISTS messages_fts_ai`;
    void this.sql`DROP TRIGGER IF EXISTS messages_fts_ad`;
    void this.sql`DROP TRIGGER IF EXISTS messages_fts_au`;
    void this.sql`DROP TABLE IF EXISTS messages_fts`;
    void this.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
        content, msg_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
      )`;
    void this.sql`
      CREATE TABLE IF NOT EXISTS conversation_fts_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        regime TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        synced_rev INTEGER NOT NULL DEFAULT -1
      )`;
    void this.sql`
      INSERT OR IGNORE INTO conversation_fts_state (id, regime, rev, synced_rev)
      VALUES (1, 'uninitialized', 0, -1)`;
    this.ensured = true;
    this.refreshIndex();
  }

  /** Install source-table revision triggers. They observe direct SDK pane
   * writes as well as local SQL writes; the index never has to guess whether a
   * same-count mutation happened. */
  private ensureRevisionTriggers(pane: boolean): void {
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_messages_ai AFTER INSERT ON messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_messages_au AFTER UPDATE ON messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_messages_ad AFTER DELETE ON messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
    if (!pane) return;
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_pane_ai AFTER INSERT ON assistant_messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_pane_au AFTER UPDATE ON assistant_messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
    void this.sql`CREATE TRIGGER IF NOT EXISTS conversation_rev_pane_ad AFTER DELETE ON assistant_messages BEGIN
      UPDATE conversation_fts_state SET rev = rev + 1 WHERE id = 1; END`;
  }

  /** Rebuild deterministically when SOURCE revision changes. Rebuilding an
   * index is cheaper than serving one stale row; it runs only after a real
   * INSERT/UPDATE/DELETE, not every read. */
  private refreshIndex(): void {
    const pane = hasPaneStore(this.sql);
    this.ensureRevisionTriggers(pane);
    const regime: IndexRegime = pane ? 'pane' : 'plain';
    const state = this.sql<{ regime: string; rev: number; synced_rev: number }>`
      SELECT regime, rev, synced_rev FROM conversation_fts_state WHERE id = 1`[0]!;
    if (state.regime === regime && state.rev === state.synced_rev) return;

    void this.sql`DELETE FROM conversation_fts`;
    const paneRows = pane
      ? this.sql<PaneRaw>`
          SELECT id, session_id, role, content, created_at, rowid AS rid
          FROM assistant_messages ORDER BY rowid ASC`.map(withPaneStamp)
      : [];
    const plainRows = pane
      ? this.sql<PlainRaw>`
          SELECT id, session_id, role, content, created_at, rowid AS rid FROM messages
          WHERE session_id <> ${CHAT_SESSION_ID} AND session_id <> 'mcts' ORDER BY rowid ASC`.map(withPlainStamp)
      : this.sql<PlainRaw>`
          SELECT id, session_id, role, content, created_at, rowid AS rid FROM messages
          WHERE session_id <> 'mcts' ORDER BY rowid ASC`.map(withPlainStamp);
    this.indexRows(paneRows, true);
    this.indexRows(plainRows, false);
    void this.sql`
      UPDATE conversation_fts_state SET regime = ${regime}, synced_rev = rev WHERE id = 1`;
  }

  /** Index a source snapshot. The caller has already proved the source revision
   * stable for this synchronous read. */
  private indexRows(rows: readonly FetchedRow[], paneRows: boolean): void {
    for (const row of rows) {
      void this.sql`
        INSERT INTO conversation_fts (content, msg_id, session_id, role, created_at)
        VALUES (${paneRows ? uiMessageText(row.content) : row.content},
                ${row.id}, ${sessionIdOf(row.session_id)},
                ${row.role}, ${row.createdAtMs})`;
    }
  }

  /** Insertion order breaks a bm25 tie, for the same reason the scroll window
   *  seeks on rowid: it is total. Without it the all-term and any-term pages
   *  could order equally-ranked rows differently, and the page {@link search}
   *  merges from them would not be reproducible. */
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

/**
 * The session id surfaces report: hosted pane sessions stamp `''`, and every
 * reader says `default`. Lives beside the store because the pane's own stamping
 * convention is what it translates.
 */
function sessionIdOf(sessionId: string): string {
  return sessionId === '' ? CHAT_SESSION_ID : sessionId;
}

/**
 * Deterministic invalidation of the derived transcript-search index, called by
 * EVERY chat-row mutation that a rowid watermark cannot see: a fork restore's
 * purge-and-reseed, a session reassignment (`UPDATE messages SET session_id`),
 * any delete. The next `ensure()`/refresh observes the poisoned regime marker,
 * discards the index, and rebuilds it from the canonical store — disposable
 * state, so correctness here is one rebuild away, never a dual-read.
 */
export function invalidateConversationSearchIndex(sql: SqlExecutor): void {
  void sql`
    CREATE TABLE IF NOT EXISTS conversation_fts_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      regime TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      synced_rev INTEGER NOT NULL DEFAULT -1
    )`;
  void sql`
    INSERT INTO conversation_fts_state (id, regime, rev, synced_rev)
    VALUES (1, 'invalidated', 0, -1)
    ON CONFLICT(id) DO UPDATE SET regime = 'invalidated', synced_rev = -1`;
}

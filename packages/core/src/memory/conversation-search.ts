/**
 * Zero-LLM transcript search over past conversation messages. FTS5 covers the
 * canonical `messages` table, the store both backends already persist turns
 * into (DO SQLite on CF and bun:sqlite on the CLI).
 *
 * Three operations:
 *   - search(query)        — ranked FTS5 snippets with conversation/message refs
 *   - scroll(messageId)    — a ±window slice of messages around an anchor
 *   - browse()             — recent archived conversation roots with counts
 *
 * The FTS index is additive: an external-content FTS5 table + sync triggers
 * over `messages`, created lazily on first use and backfilled once via the
 * FTS5 'rebuild' command. No existing table or write path changes.
 */

import { sanitizeFtsQuery } from '@kinu.run/agent-utils/memory';
import type { SqlExecutor } from '../types/primitives';

// session_id 'mcts' holds MCTS tree nodes, not conversation — excluded from
// search and browse inline below.
/** Default per-message budget in scroll/browse results. A DEFAULT, not a
 *  ceiling: scroll honours the caller's max_chars, because scroll IS the
 *  read-back path — a recall surface whose reads are capped with no way to
 *  ask for more is a keyhole, not recall. */
const MAX_MESSAGE_CHARS = 700;
const SNIPPET_TOKENS = 24;

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

function clamp(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, n));
}

function truncate(text: string, maxChars = MAX_MESSAGE_CHARS): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars — pass max_chars to read the full message]`
    : text;
}

interface HitRow { id: string; session_id: string; role: string; created_at: number; snip: string }
interface MsgRow { id: string; role: string; content: string; created_at: number; rid: number }

export class ConversationSearchStore {
  private ensured = false;

  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Additive migration, idempotent. Creates the external-content FTS5 index +
   * sync triggers over `messages`; on first creation, backfills the index
   * from every already-persisted message via FTS5 'rebuild'. Triggers are
   * durable DDL, so once created the index stays in sync with every writer
   * (CLI persist, CF onChatResponse mirror, fork copies) with no code hooks.
   */
  private ensure(): void {
    if (this.ensured) return;
    const existed = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`.length > 0;
    void this.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content=messages, content_rowid=rowid
      )`;
    void this.sql`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END`;
    void this.sql`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END`;
    void this.sql`
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END`;
    if (!existed) {
      void this.sql`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`;
    }
    this.ensured = true;
  }

  /** Ranked FTS5 hits, best first. Falls back to OR-matching when the
   *  AND-default query has no hits (same recall policy as MemoryStore). */
  search(query: string, limit = 5): ConversationSearchHit[] {
    this.ensure();
    if (!query.trim()) return [];
    const lim = clamp(limit, 1, 10);
    const safe = sanitizeFtsQuery(query);
    let rows = this.runFtsQuery(safe, lim);
    if (rows.length === 0) {
      const tokens = safe.split(' ').filter(Boolean);
      if (tokens.length > 1) rows = this.runFtsQuery(tokens.join(' OR '), lim);
    }
    return rows.map((r) => ({
      conversationId: r.session_id,
      messageId: r.id,
      role: r.role,
      createdAt: r.created_at,
      snippet: r.snip,
    }));
  }

  /** A window of ±`window` messages around the anchor message, in transcript
   *  order. Returns null when the anchor id doesn't exist. */
  scroll(aroundMessageId: string, window = 5, maxChars?: number): ConversationScrollResult | null {
    this.ensure();
    const anchor = this.sql<MsgRow & { session_id: string }>`
      SELECT id, session_id, role, content, created_at, rowid AS rid
      FROM messages WHERE id = ${aroundMessageId}`[0];
    if (!anchor) return null;
    const w = clamp(window, 1, 20);

    const before = this.sql<MsgRow>`
      SELECT id, role, content, created_at, rowid AS rid
      FROM messages
      WHERE session_id = ${anchor.session_id}
        AND (created_at < ${anchor.created_at}
             OR (created_at = ${anchor.created_at} AND rowid < ${anchor.rid}))
      ORDER BY created_at DESC, rowid DESC LIMIT ${w}`.reverse();
    const after = this.sql<MsgRow>`
      SELECT id, role, content, created_at, rowid AS rid
      FROM messages
      WHERE session_id = ${anchor.session_id}
        AND (created_at > ${anchor.created_at}
             OR (created_at = ${anchor.created_at} AND rowid > ${anchor.rid}))
      ORDER BY created_at ASC, rowid ASC LIMIT ${w}`;

    const totalBefore = this.count(anchor.session_id, anchor.created_at, anchor.rid, 'before');
    const totalAfter = this.count(anchor.session_id, anchor.created_at, anchor.rid, 'after');

    const perMessage = maxChars !== undefined ? Math.max(50, Math.trunc(maxChars)) : MAX_MESSAGE_CHARS;
    const toMessage = (m: MsgRow): ConversationScrollMessage => ({
      id: m.id, role: m.role, content: truncate(m.content, perMessage), createdAt: m.created_at,
    });
    return {
      conversationId: anchor.session_id,
      messages: [...before.map(toMessage), { ...toMessage(anchor), anchor: true }, ...after.map(toMessage)],
      messagesBefore: totalBefore - before.length,
      messagesAfter: totalAfter - after.length,
    };
  }

  /** Recent conversation roots, most recently active first. */
  browse(limit = 10): ConversationSummary[] {
    this.ensure();
    const lim = clamp(limit, 1, 20);
    const conversations = this.sql<{ session_id: string; n: number; started_at: number; last_active: number }>`
      SELECT session_id, COUNT(*) AS n, MIN(created_at) AS started_at, MAX(created_at) AS last_active
      FROM messages
      WHERE session_id NOT IN ('mcts')
      GROUP BY session_id
      ORDER BY last_active DESC
      LIMIT ${lim}`;
    return conversations.map((conversation) => {
      const first = this.sql<{ content: string }>`
        SELECT content FROM messages
        WHERE session_id = ${conversation.session_id} AND role = 'user'
        ORDER BY created_at ASC, rowid ASC LIMIT 1`[0];
      return {
        conversationId: conversation.session_id,
        messageCount: conversation.n,
        startedAt: conversation.started_at,
        lastActiveAt: conversation.last_active,
        preview: truncate(first?.content ?? ''),
      };
    });
  }

  private runFtsQuery(ftsQuery: string, limit: number): HitRow[] {
    return this.sql<HitRow>`
      SELECT m.id, m.session_id, m.role, m.created_at,
             snippet(messages_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ${ftsQuery}
        AND m.session_id NOT IN ('mcts')
        AND m.role IN ('user', 'assistant')
      ORDER BY bm25(messages_fts) ASC
      LIMIT ${limit}`;
  }

  private count(sessionId: string, createdAt: number, rid: number, side: 'before' | 'after'): number {
    const rows = side === 'before'
      ? this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM messages
          WHERE session_id = ${sessionId}
            AND (created_at < ${createdAt} OR (created_at = ${createdAt} AND rowid < ${rid}))`
      : this.sql<{ c: number }>`
          SELECT COUNT(*) AS c FROM messages
          WHERE session_id = ${sessionId}
            AND (created_at > ${createdAt} OR (created_at = ${createdAt} AND rowid > ${rid}))`;
    return rows[0]?.c ?? 0;
  }
}

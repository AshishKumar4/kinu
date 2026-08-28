/**
 * The conversation store — the transcript as a DAG, and the one place that
 * decides which SQLite table owns the default chat.
 *
 * The transcript has always been a tree. `messages.parent_id` has existed since
 * the schema's first commit (`identity/schema.ts`, whose own comment calls it a
 * "simplified session tree") and is indexed by `idx_msg_parent`; on the
 * Cloudflare backend the SDK's own store — `assistant_messages`, written by
 * `agents`' `AgentSessionProvider` — carries the same edges, defaults a missing
 * parent to the latest leaf so no message is ever edgeless, and already exposes
 * `getHistory(leafId)`, `getBranches(messageId)`, `getLatestLeaf()` and
 * `getPathLength(leafId)`. Kinu called none of those. The tree was written,
 * indexed, and dead.
 *
 * Two consequences, both of which the operator hit:
 *
 *  1. Cutting a tree by timestamp is not a cut. `assistant_messages.created_at`
 *     is `DATETIME DEFAULT CURRENT_TIMESTAMP` — whole seconds — and a turn emits
 *     several messages inside one second, so `created_at <= T` could not resolve
 *     which side of the cut a message was on. It also cannot express a second
 *     child of the same message, which is the whole point of a tree.
 *     {@link sessionTreeAncestry} cuts on the edges.
 *
 *  2. A SECOND copy of the same conversation used to exist: a post-turn
 *     reconciler projected the pane's newest-leaf ancestry into plain
 *     `messages` rows because every reader except the fork cut read that
 *     table. An interrupted turn, or a sibling branch off an older node, sat
 *     unprojected until the next reconciler pass, invisible to status counts,
 *     paging, search and outcome attribution. There is no reconciler any more:
 *     every reader goes through THIS module, and each workspace carries its
 *     default chat in exactly ONE store.
 */

import * as v from 'valibot';
import { seekPage, mapPage, StaleCursorError, type Page, type PageRequest } from '../read-models/page';
import type { SqlExecutor } from '../types/primitives';
import { uiMessageRow, uiMessageText } from '../utils/ui-message';

/**
 * Bound on an ancestry walk, and the cycle guard. Matches the bound `agents`'
 * own `getPathLength` uses on the same edges, so a Kinu walk and an SDK walk
 * stop in the same place on a pathological chain.
 */
export const SESSION_TREE_MAX_DEPTH = 10_000;

/** The chat session every conversational read and write uses. `messages` also
 *  holds `session_id = 'mcts'` rows written by the durable MCTS session writer,
 *  which are a different tree and are never touched here. */
export const CHAT_SESSION_ID = 'default';

/** One message in the tree, root-first when returned as a chain. `content` is
 *  plain text — what search and the evolution read models want. */
export interface SessionTreeNode {
  id: string;
  parent_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

/** A row of the SDK's store — the serialized UI message the chat pane renders,
 *  which {@link SessionTreeNode.content} has already flattened away. */
export interface ChatPaneRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  content: string;
  created_at: string;
}

/**
 * Which store owns this workspace's default chat.
 *
 * The SDK's pane store where it exists (it is the one the chat pane renders,
 * so it is the one whose ids the user can point at), plain `messages`
 * otherwise — the CLI has no second store and writes its own edges. Asked as a
 * question against `sqlite_master`, never discovered by catching: a missing
 * table is a normal state of a workspace that has not run a hosted turn, while
 * a failing query is a fault that must still throw.
 *
 * The inference is only as sound as the invariant behind it, and two flows
 * would break that invariant if left alone — both normalized once, at their
 * boundary, by this module:
 *
 *   - A cloud archive imported into a LOCAL workspace arrives carrying the
 *     pane schema and rows; {@link normalizeImportedConversation} projects
 *     them into `messages` and drops the pane, so a local database never
 *     carries a second store.
 *   - A fork whose snapshot carries rich rows lands in the destination the
 *     caller DECLARES (`writeForkSnapshot`'s `targetAuthority`); hosted
 *     callers pass `'pane'`, local ones fall to `'plain'` — never "whatever
 *     table happens to exist".
 */
export function hasPaneStore(sql: SqlExecutor): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'
  `.length > 0;
}

/** Cheap fork-cut preflight. It reads only the authority table primary key, so
 * the driver can refuse an unknown requested cut before it probes or reserves a
 * workspace without materialising the ancestry the transfer will stream. */
export function forkPointExists(sql: SqlExecutor, messageId: string): boolean {
  if (hasPaneStore(sql)) {
    return sql<{ name: string }>`SELECT id AS name FROM assistant_messages WHERE id = ${messageId} LIMIT 1`.length > 0;
  }
  return sql<{ name: string }>`
    SELECT id AS name FROM messages WHERE id = ${messageId} AND session_id = ${CHAT_SESSION_ID} LIMIT 1
  `.length > 0;
}

/**
 * The pane's whole-second `YYYY-MM-DD HH:MM:SS` stamp as UTC ms — the store
 * writes `CURRENT_TIMESTAMP`, which SQLite renders in UTC with no zone marker,
 * so the `Z` is what stops the host's local offset from being applied. Public
 * because every writer that lands a row in the pane store must read one back
 * under exactly this rule.
 */
export function paneStampMs(createdAt: string): number {
  return Date.parse(`${createdAt.replace(' ', 'T')}Z`);
}

/** The session id a reader reports for a stored row: the pane stamps hosted
 *  sessions with `''`; every surface says `default`. */
function reportedSession(sessionId: string): string {
  return sessionId === '' ? CHAT_SESSION_ID : sessionId;
}

/** A row of the SDK's store as a tree node: the serialized UI message flattened
 *  to text, and its stamp read as ms. */
function paneRowToNode(row: ChatPaneRow): SessionTreeNode {
  return {
    id: row.id,
    parent_id: row.parent_id,
    role: row.role,
    content: uiMessageText(row.content),
    created_at: paneStampMs(row.created_at),
  };
}

/** Which store owns a chain, and the ids that chain carries. */
export interface AncestryIds {
  /** The store that answered — {@link hasPaneStore}'s question, asked once so
   *  every read of one chain reads the same store. */
  authority: 'pane' | 'plain';
  /** The chain from the tree's root down to the walked id, inclusive, root
   *  first. Ids repeat where the edges do: a self-parented row terminates by
   *  exhausting {@link SESSION_TREE_MAX_DEPTH}, and what the walk repeated is
   *  what the walk carried, so a reader that deduplicated here would report a
   *  chain nobody took. */
  ids: string[];
}

/**
 * WHICH rows an ancestry walk carries, as ids, root first.
 *
 * One recursive walk per store, and therefore one authority that every ancestry
 * read agrees with by construction: the tree read below, the fork's whole-value
 * read, and the fork's bounded frame stream (`identity/fork-transfer.ts`) all
 * resolve their chain here and then read rows by id.
 *
 * Ids and not rows, because a sender that must never hold the whole
 * conversation still has to know the whole ORDER before it can send the first
 * row: the walk climbs parent edges up from the leaf, and root-first is its
 * reverse. Ids are the smallest thing that answers that, and they carry no text.
 */
export function ancestryIds(sql: SqlExecutor, messageId: string): AncestryIds {
  // Pane authority is absolute: a stale default-session mirror must never make
  // a deleted pane id look forkable again.
  if (hasPaneStore(sql)) {
    return {
      authority: 'pane',
      ids: sql<{ id: string }>`
        WITH RECURSIVE ancestry(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 FROM assistant_messages WHERE id = ${messageId}
          UNION ALL
          SELECT am.id, am.parent_id, a.depth + 1
          FROM assistant_messages am JOIN ancestry a ON am.id = a.parent_id
          WHERE a.depth < ${SESSION_TREE_MAX_DEPTH}
        )
        SELECT id FROM ancestry ORDER BY depth DESC
      `.map((row) => row.id),
    };
  }
  return {
    authority: 'plain',
    ids: sql<{ id: string }>`
      WITH RECURSIVE ancestry(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM messages
        WHERE id = ${messageId} AND session_id = ${CHAT_SESSION_ID}
        UNION ALL
        SELECT m.id, m.parent_id, a.depth + 1
        FROM messages m JOIN ancestry a ON m.id = a.parent_id
        WHERE m.session_id = ${CHAT_SESSION_ID} AND a.depth < ${SESSION_TREE_MAX_DEPTH}
      )
      SELECT id FROM ancestry ORDER BY depth DESC
    `.map((row) => row.id),
  };
}

/** One row of the SDK's store by id — the read half of {@link ancestryIds} for
 *  the pane, and the unit a bounded sender reads one row at a time. */
export function paneRowById(sql: SqlExecutor, id: string): ChatPaneRow | undefined {
  return sql<ChatPaneRow>`
    SELECT id, session_id, parent_id, role, content, created_at
    FROM assistant_messages WHERE id = ${id} LIMIT 1
  `[0];
}

/** One row of the plain chat table by id, in the default session — so an `mcts`
 *  row under the same id cannot answer for it. */
export function messageRowById(sql: SqlExecutor, id: string): SessionTreeNode | undefined {
  return sql<SessionTreeNode>`
    SELECT id, parent_id, role, content, created_at FROM messages
    WHERE id = ${id} AND session_id = ${CHAT_SESSION_ID} LIMIT 1
  `[0];
}

/** Rows for a walked chain, in the chain's order. A row absent from the store it
 *  was just walked out of is skipped rather than reported as a hole, which is
 *  what the join inside the former single-query walk did with it. */
function rowsForIds<R>(ids: string[], read: (id: string) => R | undefined): R[] {
  return ids.flatMap((id) => {
    const row = read(id);
    return row === undefined ? [] : [row];
  });
}

/**
 * The chain from the tree's root down to `messageId`, inclusive, root first.
 *
 * A node lives in whichever store owns this backend's default chat, so the
 * lookup is "the store that has it, SDK's first". Non-default trees (`mcts`,
 * local peers) always live in `messages`; they have no ids that collide with
 * the pane's, so the rich-first probe cannot answer for them by accident.
 *
 * Empty when the id is in neither, which is the only honest answer and the one a
 * fork reports rather than cutting an arbitrary prefix.
 *
 * Cost is one indexed point lookup per ancestor — both stores key on `id` — so
 * it is linear in the chain and touches nothing else.
 */
export function sessionTreeAncestry(sql: SqlExecutor, messageId: string): SessionTreeNode[] {
  const { authority, ids } = ancestryIds(sql, messageId);
  return authority === 'pane'
    ? rowsForIds(ids, (id) => paneRowById(sql, id)).map(paneRowToNode)
    : rowsForIds(ids, (id) => messageRowById(sql, id));
}

/** One row of the plain chain as a fork carries it: `content` is nullable
 *  because the rich twin under the same id carries the text wherever one
 *  exists. */
export interface ForkChainRow {
  id: string;
  parent_id: string | null;
  role: string;
  content: string | null;
  created_at: number;
}

/** The ancestry as a fork carries it across a process boundary. */
export interface ForkAncestry {
  /** The chain for the plain `messages` table, root first, with `content` null
   *  wherever {@link ForkAncestry.pane} carries the same id: the plain row is a
   *  flattened projection of the rich one, so carrying both ships one
   *  conversation twice — 14.4 MiB beside 20.5 MiB for a real long session. */
  chain: ForkChainRow[];
  /** The same chain in the SDK's store, verbatim; empty where it has none. */
  pane: ChatPaneRow[];
}

/** The plain-table half of one pane row, as a fork carries it: the text elided
 *  because the rich row under the same id carries it, and the pane's stamp read
 *  as ms. THE elision contract, in one function, so the whole-value snapshot and
 *  the bounded frame stream cannot drift apart on it. */
export function paneRowToForkChainRow(row: ChatPaneRow): ForkChainRow {
  return {
    id: row.id,
    parent_id: row.parent_id,
    role: row.role,
    content: null,
    created_at: paneStampMs(row.created_at),
  };
}

/**
 * Both halves of the ancestry a fork copies, and the elision between them.
 *
 * Here rather than in `identity/fork.ts` because which store owns the tree is
 * decided once in this module, and the elision is only sound because both halves
 * are the same walk from the same node: where the pane owns the tree the plain
 * chain IS its flattening, id for id. A prefix cut could not say that, which is
 * why it had to carry the text twice.
 */
export function forkAncestry(sql: SqlExecutor, messageId: string): ForkAncestry {
  const { authority, ids } = ancestryIds(sql, messageId);
  if (authority === 'plain') {
    return { chain: rowsForIds(ids, (id) => messageRowById(sql, id)), pane: [] };
  }
  const pane = rowsForIds(ids, (id) => paneRowById(sql, id));
  return { pane, chain: pane.map(paneRowToForkChainRow) };
}

/**
 * The same chain in the SDK's store, verbatim — the rows the chat pane renders
 * and a fork must therefore carry, since the flattened text cannot rebuild a
 * tool call. Empty where the SDK's store does not exist.
 */
export function chatPaneAncestry(sql: SqlExecutor, messageId: string): ChatPaneRow[] {
  const { authority, ids } = ancestryIds(sql, messageId);
  if (authority !== 'pane') return [];
  return rowsForIds(ids, (id) => paneRowById(sql, id));
}

// ── The flat reads: count, page, turn pair ──────────────────────────────────

/** How many messages the workspace's default chat holds, per its own authority. */
export function conversationCount(sql: SqlExecutor): number {
  if (hasPaneStore(sql)) {
    return sql<{ c: number }>`SELECT COUNT(*) AS c FROM assistant_messages`[0]!.c;
  }
  return sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM messages WHERE session_id = ${CHAT_SESSION_ID}`[0]!.c;
}

interface StoredTranscriptRow {
  id: string;
  role: string;
  /** Raw stored content: the pane's serialized UI message, or plain text. */
  content: string;
  /** Provenance column — exists on `messages` only. */
  metadata?: string | null;
  created_at: string | number;
}

/** One raw transcript row, exactly as the authority stores it. Projection to
 *  display shape belongs to the serving read model; dropped roles must still
 *  count against a page and be able to anchor its cursor. */
export interface ConversationPageRow {
  id: string;
  role: string;
  content: string;
  metadata?: string | null;
  createdAt: string | number;
}

/** Widest transcript page a surface may ask for. */
const MAX_HISTORY_LIMIT = 200;

/** Page size when a caller does not care — one screenful of chat and then
 *  some, small enough that scrolling up stays responsive. */
const DEFAULT_HISTORY_LIMIT = 100;

const rowIdOf = (row: StoredTranscriptRow): string => row.id;

/**
 * One page of the canonical transcript, newest page first, oldest-first items.
 *
 * ── Why the cursor is rowid and not created_at ───────────────────────────────
 * `assistant_messages.created_at` is whole seconds and a turn emits several
 * messages inside one second, so `created_at` ties have no defined order and
 * `ORDER BY created_at DESC LIMIT n` does not even have a defined MEMBERSHIP.
 * Paging on it would drop and repeat messages at every page boundary without a
 * single concurrent write. `rowid` is total, is the insertion order, and both
 * stores have one (a `TEXT PRIMARY KEY` does not make a table WITHOUT ROWID).
 */
export function conversationPageRows(
  sql: SqlExecutor,
  request: PageRequest = {},
): Page<ConversationPageRow> {
  const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(request.limit ?? DEFAULT_HISTORY_LIMIT)));
  const after = request.cursor?.after ?? null;
  const over = limit + 1;

  /** The cursor's anchor as a rowid, or the refusal that keeps a vanished
   *  anchor from reading as an exhausted conversation. */
  const anchorRowid = (found: { seek: number }[]): number => {
    const seek = found[0]?.seek;
    if (seek === undefined) throw new StaleCursorError('conversation', after!);
    return seek;
  };

  if (hasPaneStore(sql)) {
    const from = after === null
      ? null
      : anchorRowid(sql`SELECT rowid AS seek FROM assistant_messages WHERE id = ${after}`);
    return mapPage(seekPage(from === null
      ? sql<StoredTranscriptRow>`
        SELECT id, role, content, created_at FROM assistant_messages
        WHERE role IN ('user', 'assistant', 'system')
        ORDER BY rowid DESC LIMIT ${over}`
      : sql<StoredTranscriptRow>`
        SELECT id, role, content, created_at FROM assistant_messages
        WHERE role IN ('user', 'assistant', 'system') AND rowid < ${from}
        ORDER BY rowid DESC LIMIT ${over}`,
      limit, rowIdOf), (rows) => rows.map((row) => ({
        id: row.id, role: row.role, content: row.content, createdAt: row.created_at,
      })));
  }

  const from = after === null
    ? null
    : anchorRowid(sql`
        SELECT rowid AS seek FROM messages WHERE id = ${after} AND session_id = ${CHAT_SESSION_ID}`);
  return mapPage(seekPage(from === null
    ? sql<StoredTranscriptRow>`
      SELECT id, role, content, metadata, created_at FROM messages
      WHERE session_id = ${CHAT_SESSION_ID} AND role IN ('user', 'assistant', 'system')
      ORDER BY rowid DESC LIMIT ${over}`
    : sql<StoredTranscriptRow>`
      SELECT id, role, content, metadata, created_at FROM messages
      WHERE session_id = ${CHAT_SESSION_ID} AND role IN ('user', 'assistant', 'system') AND rowid < ${from}
      ORDER BY rowid DESC LIMIT ${over}`,
    limit, rowIdOf), (rows) => rows.map((row) => ({
      id: row.id, role: row.role, content: row.content, metadata: row.metadata ?? undefined, createdAt: row.created_at,
    })));
}

/** The user→assistant pair behind a completed turn, from the authority. */
export interface ConversationTurnPair {
  /** The conversation the turn lives in, as surfaces report it. */
  sessionId: string;
  /** Flattened plain text; null where the pair has no user row. */
  request: string | null;
  responseId: string;
  response: string | null;
  startedAtMs: number | null;
  endedAtMs: number;
}

/**
 * The request/response pair behind a turn id — what outcome attribution, take
 * picks and explicit feedback grade a turn from.
 *
 * The default-chat arm reads the authority; the `messages` arm exists for the
 * NON-default trees (`mcts`, local peers) whose turn ids never enter the pane
 * store. Where the pane owns the backend there is no third place a default-chat
 * turn can live, so no fallback into stale mirror rows happens.
 */
/** The one field a resumed reply reads off a queued drain turn's user row.
 *  Non-strict: every other stamp the enqueue seam writes is irrelevant here. */
const DrainTurnMetadataSchema = v.object({ drainTurnId: v.optional(v.string()) });

/**
 * The durable answer each named synthetic drain turn received, or nothing when
 * it never got one.
 *
 * What makes a recovery able to finish a reply the answering turn never sent.
 * The link is the store's own parent edge: a queued drain turn's USER row
 * carries `drainTurnId` in its metadata, and the assistant row whose
 * `parent_id` is that user row is the answer to it. Both are the SDK's durable
 * pane rows, so this reads the transcript rather than a live activation's
 * hydrated message list — a recovery has no such list, and that is the whole
 * point of it.
 *
 * An empty answer is ABSENT from the result, never present as `''`. Replying
 * with nothing would close a delivery the sender is still waiting on.
 */
export function answersForDrainTurns(
  sql: SqlExecutor,
  drainTurnIds: readonly string[],
): Map<string, string> {
  const answers = new Map<string, string>();
  if (drainTurnIds.length === 0 || !hasPaneStore(sql)) return answers;
  const wanted = new Set(drainTurnIds);
  const rows = sql<{ ask: string; answer: string }>`
    SELECT u.content AS ask, a.content AS answer
    FROM assistant_messages u JOIN assistant_messages a ON a.parent_id = u.id
    WHERE u.role = 'user' AND a.role = 'assistant'
    ORDER BY a.rowid ASC`;
  for (const row of rows) {
    const parsed = v.safeParse(DrainTurnMetadataSchema, uiMessageRow(row.ask).metadata);
    const drainTurnId = parsed.success ? parsed.output.drainTurnId : undefined;
    if (drainTurnId === undefined || !wanted.has(drainTurnId)) continue;
    const text = uiMessageText(row.answer);
    if (text.trim().length > 0) answers.set(drainTurnId, text);
  }
  return answers;
}

export function conversationTurnPair(
  sql: SqlExecutor,
  messageId: string,
): ConversationTurnPair | undefined {
  if (hasPaneStore(sql)) {
    const row = sql<{
      sessionId: string; responseRaw: string;
      requestRaw: string | null; startedAt: string | null; endedAt: string;
    }>`
      SELECT a.session_id AS sessionId, a.content AS responseRaw,
             u.content AS requestRaw, u.created_at AS startedAt, a.created_at AS endedAt
      FROM assistant_messages a LEFT JOIN assistant_messages u ON u.id = a.parent_id
      WHERE a.id = ${messageId} LIMIT 1`[0];
    if (row) {
      return {
        sessionId: reportedSession(row.sessionId),
        request: row.requestRaw === null ? null : uiMessageText(row.requestRaw),
        responseId: messageId,
        response: uiMessageText(row.responseRaw),
        startedAtMs: row.startedAt === null ? null : paneStampMs(row.startedAt),
        endedAtMs: paneStampMs(row.endedAt),
      };
    }
  }

  // Where the pane store exists, plain `default` rows are the retired mirror —
  // a turn id the pane does not know must not resolve against them.
  const row = (hasPaneStore(sql)
    ? sql<{
        sessionId: string; responseRaw: string;
        requestRaw: string | null; startedAt: number | null; endedAt: number;
      }>`
        SELECT m.session_id AS sessionId, m.content AS responseRaw,
               u.content AS requestRaw, u.created_at AS startedAt, m.created_at AS endedAt
        FROM messages m LEFT JOIN messages u ON u.id = m.parent_id
        WHERE m.id = ${messageId} AND m.session_id <> ${CHAT_SESSION_ID} LIMIT 1`
    : sql<{
        sessionId: string; responseRaw: string;
        requestRaw: string | null; startedAt: number | null; endedAt: number;
      }>`
        SELECT m.session_id AS sessionId, m.content AS responseRaw,
               u.content AS requestRaw, u.created_at AS startedAt, m.created_at AS endedAt
        FROM messages m LEFT JOIN messages u ON u.id = m.parent_id
        WHERE m.id = ${messageId} LIMIT 1`)[0];
  if (!row) return undefined;
  return {
    sessionId: reportedSession(row.sessionId),
    request: row.requestRaw,
    responseId: messageId,
    response: row.responseRaw,
    startedAtMs: row.startedAt === null ? null : Number(row.startedAt),
    endedAtMs: Number(row.endedAt),
  };
}

/**
 * Land a cloud import on the LOCAL authority.
 *
 * A cloud export carries the pane store; a local workspace's default chat
 * lives in `messages` alone. Run once over an imported database before it is
 * exposed: every pane row is projected into the plain store (text flattened,
 * ms stamps) and the pane schema is removed — so "does assistant_messages
 * exist" keeps meaning exactly one thing everywhere else. Returns how many
 * rows moved.
 */
export function normalizeImportedConversation(sql: SqlExecutor): number {
  if (!hasPaneStore(sql)) return 0;
  const rows = sql<ChatPaneRow>`
    SELECT id, session_id, parent_id, role, content, created_at
    FROM assistant_messages ORDER BY rowid ASC`;
  for (const row of rows) {
    void sql`
      INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${row.id}, ${CHAT_SESSION_ID}, ${row.parent_id}, ${row.role},
              ${uiMessageText(row.content)}, ${paneStampMs(row.created_at)})
    `;
  }
  void sql`DROP TABLE assistant_messages`;
  return rows.length;
}

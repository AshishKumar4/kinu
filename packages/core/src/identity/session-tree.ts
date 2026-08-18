/**
 * The session tree — the transcript as a DAG, and the one place that walks it.
 *
 * The transcript has always been a tree. `messages.parent_id` has existed since
 * the schema's first commit (`identity/schema.ts`, whose own comment calls it a
 * "simplified session tree") and is indexed by `idx_msg_parent`; on the
 * Cloudflare backend the SDK's own store — `assistant_messages`, written by
 * `agents`' `AgentSessionProvider` — carries the same edges, defaults a missing
 * parent to the latest leaf so no message is ever edgeless, and already exposes
 * `getHistory(leafId)`, `getBranches(messageId)`, `getLatestLeaf()` and
 * `getPathLength(leafId)`. Proteus called none of those. The tree was written,
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
 *  2. `messages` on the Cloudflare backend was written by a turn-end summary
 *     that recorded the last user message and the final assistant message of
 *     *completed* turns only, with a NULL parent on the user row. Memory search,
 *     the status read model and the evolution outcome window all read that table,
 *     so an interrupted turn was invisible to every one of them.
 *     {@link reconcileSessionTree} replaces the summary with a projection.
 *
 * Which store is authoritative is per backend and is decided in one place here:
 * the SDK's store where it exists (it is the one the chat pane renders, so it is
 * the one whose ids the user can point at), `messages` otherwise — the CLI has
 * no second store and writes its own edges.
 */

import type { SqlExecutor } from '../types/primitives';
import { uiMessageText } from '../utils/ui-message';

/**
 * Bound on an ancestry walk, and the cycle guard. Matches the bound `agents`'
 * own `getPathLength` uses on the same edges, so a Proteus walk and an SDK walk
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

function hasSdkStore(sql: SqlExecutor): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'
  `.length > 0;
}

/**
 * The pane's whole-second `YYYY-MM-DD HH:MM:SS` stamp as UTC ms — the store
 * writes `CURRENT_TIMESTAMP`, which SQLite renders in UTC with no zone marker,
 * so the `Z` is what stops the host's local offset from being applied.
 */
function paneStampMs(createdAt: string): number {
  return Date.parse(`${createdAt.replace(' ', 'T')}Z`);
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

/** The ancestry in `messages` — the CLI's only store, and the fallback for an id
 *  the SDK's store does not have. */
function messagesAncestry(sql: SqlExecutor, messageId: string): SessionTreeNode[] {
  return sql<SessionTreeNode & { depth: number }>`
    WITH RECURSIVE ancestry(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM messages
      WHERE id = ${messageId} AND session_id = ${CHAT_SESSION_ID}
      UNION ALL
      SELECT m.id, m.parent_id, a.depth + 1
      FROM messages m JOIN ancestry a ON m.id = a.parent_id
      WHERE m.session_id = ${CHAT_SESSION_ID} AND a.depth < ${SESSION_TREE_MAX_DEPTH}
    )
    SELECT m.id, m.parent_id, m.role, m.content, m.created_at, a.depth
    FROM ancestry a JOIN messages m ON m.id = a.id
    ORDER BY a.depth DESC
  `.map(({ id, parent_id, role, content, created_at }) => ({
    id, parent_id, role, content, created_at,
  }));
}

/**
 * The chain from the tree's root down to `messageId`, inclusive, root first.
 *
 * A node lives in whichever store owns this backend's tree, so the lookup is
 * "the store that has it, SDK's first" — that store is the one the chat pane
 * offers ids from, so a fork point the operator can click always resolves, with
 * no dependence on {@link reconcileSessionTree} having run. `messages` answers
 * for the CLI, which has no second store and writes its own edges.
 *
 * Empty when the id is in neither, which is the only honest answer and the one a
 * fork reports rather than cutting an arbitrary prefix.
 *
 * Cost is one indexed point lookup per ancestor — both stores key on `id` — so
 * it is linear in the chain and touches nothing else.
 */
export function sessionTreeAncestry(sql: SqlExecutor, messageId: string): SessionTreeNode[] {
  const pane = chatPaneAncestry(sql, messageId);
  if (pane.length > 0) return pane.map(paneRowToNode);
  return messagesAncestry(sql, messageId);
}

/** The ancestry as a fork carries it across a process boundary. */
export interface ForkAncestry {
  /** The chain for the plain `messages` table, root first, with `content` null
   *  wherever {@link ForkAncestry.pane} carries the same id: the plain row is a
   *  flattened projection of the rich one, so carrying both ships one
   *  conversation twice — 14.4 MiB beside 20.5 MiB for a real long session. */
  chain: Array<{
    id: string; parent_id: string | null;
    role: string; content: string | null; created_at: number;
  }>;
  /** The same chain in the SDK's store, verbatim; empty where it has none. */
  pane: ChatPaneRow[];
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
  const pane = chatPaneAncestry(sql, messageId);
  if (pane.length === 0) return { chain: messagesAncestry(sql, messageId), pane };
  return {
    pane,
    chain: pane.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      role: row.role,
      content: null,
      created_at: paneStampMs(row.created_at),
    })),
  };
}

/**
 * UTF-8 bytes of the stored text the ancestry of `messageId` would carry.
 *
 * Computed by SQLite over the same edges, so it costs no JS memory: a caller
 * that has to refuse an over-budget copy must be able to know the size without
 * building the thing it is refusing. `CAST(… AS BLOB)` because `LENGTH` over
 * TEXT counts characters. The recursion is written out again rather than reusing
 * the row walks above for exactly that reason — projecting `content` is the one
 * thing this must not do.
 */
export function sessionTreeAncestryBytes(sql: SqlExecutor, messageId: string): number {
  if (hasSdkStore(sql)) {
    const pane = sql<{ b: number }>`
      WITH RECURSIVE ancestry(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM assistant_messages WHERE id = ${messageId}
        UNION ALL
        SELECT am.id, am.parent_id, a.depth + 1
        FROM assistant_messages am JOIN ancestry a ON am.id = a.parent_id
        WHERE a.depth < ${SESSION_TREE_MAX_DEPTH}
      )
      SELECT COALESCE(SUM(LENGTH(CAST(am.content AS BLOB))), 0) AS b
      FROM ancestry a JOIN assistant_messages am ON am.id = a.id
    `[0]!.b;
    if (pane > 0) return pane;
  }
  return sql<{ b: number }>`
    WITH RECURSIVE ancestry(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM messages
      WHERE id = ${messageId} AND session_id = ${CHAT_SESSION_ID}
      UNION ALL
      SELECT m.id, m.parent_id, a.depth + 1
      FROM messages m JOIN ancestry a ON m.id = a.parent_id
      WHERE m.session_id = ${CHAT_SESSION_ID} AND a.depth < ${SESSION_TREE_MAX_DEPTH}
    )
    SELECT COALESCE(SUM(LENGTH(CAST(m.content AS BLOB))), 0) AS b
    FROM ancestry a JOIN messages m ON m.id = a.id
  `[0]!.b;
}

/**
 * The same chain in the SDK's store, verbatim — the rows the chat pane renders
 * and a fork must therefore carry, since the flattened text cannot rebuild a
 * tool call. Empty where the SDK's store does not exist.
 */
export function chatPaneAncestry(sql: SqlExecutor, messageId: string): ChatPaneRow[] {
  if (!hasSdkStore(sql)) return [];
  return sql<ChatPaneRow & { depth: number }>`
    WITH RECURSIVE ancestry(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM assistant_messages WHERE id = ${messageId}
      UNION ALL
      SELECT am.id, am.parent_id, a.depth + 1
      FROM assistant_messages am JOIN ancestry a ON am.id = a.parent_id
      WHERE a.depth < ${SESSION_TREE_MAX_DEPTH}
    )
    SELECT am.id, am.session_id, am.parent_id, am.role, am.content, am.created_at, a.depth
    FROM ancestry a JOIN assistant_messages am ON am.id = a.id
    ORDER BY a.depth DESC
  `.map(({ id, session_id, parent_id, role, content, created_at }) => ({
    id, session_id, parent_id, role, content, created_at,
  }));
}

/**
 * Project the messages the SDK has appended but `messages` does not have yet,
 * and report how many moved.
 *
 * `messages` is the cross-backend read model: `messages_fts` indexes its
 * `content`, `read-models/status.ts` counts and renders it, and the evolution
 * outcome window and the takes comparison join it to itself over `parent_id`.
 * All of those were reading a table that skipped interrupted turns.
 *
 * **This runs after every turn on the Durable Object that also serves every
 * read, so its cost is bounded by the messages the turn added and not by the
 * size of the transcript.** It walks up from the tree's newest leaf and stops at
 * the first node already projected: one indexed lookup per new message plus one
 * to find the stopping point. It never scans either table and never reads the
 * stored UI message of a row it is not going to write — the transcript's bulk is
 * inline tool output, and a per-turn full read of it would put every subsequent
 * read behind it.
 *
 * The bound has a price, stated rather than hidden: a message appended off the
 * newest leaf's path (a sibling branch) is projected when it becomes an
 * ancestor of a leaf, not before. Nothing load-bearing depends on it sooner —
 * the fork cut reads the SDK's store directly, via {@link sessionTreeAncestry}.
 */
export function reconcileSessionTree(sql: SqlExecutor): number {
  if (!hasSdkStore(sql)) return 0;
  const leaf = sql<{ id: string }>`
    SELECT id FROM assistant_messages ORDER BY rowid DESC LIMIT 1
  `[0];
  if (!leaf) return 0;

  const pending: SessionTreeNode[] = [];
  let cursor: string | null = leaf.id;
  for (let depth = 0; cursor !== null && depth < SESSION_TREE_MAX_DEPTH; depth++) {
    const projected = sql<{ id: string }>`
      SELECT id FROM messages WHERE id = ${cursor} AND session_id = ${CHAT_SESSION_ID}
    `;
    if (projected.length > 0) break;
    const row: ChatPaneRow | undefined = sql<ChatPaneRow>`
      SELECT id, session_id, parent_id, role, content, created_at
      FROM assistant_messages WHERE id = ${cursor}
    `[0];
    if (!row) break;
    pending.push(paneRowToNode(row));
    cursor = row.parent_id;
  }

  // Oldest first, so `messages`' insertion order matches the tree's and the
  // rowid tie-break its readers use agrees with the pane.
  for (let i = pending.length - 1; i >= 0; i--) {
    const node = pending[i]!;
    void sql`
      INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, content, created_at)
      VALUES (${node.id}, ${CHAT_SESSION_ID}, ${node.parent_id}, ${node.role},
              ${node.content}, ${node.created_at})
    `;
  }
  return pending.length;
}

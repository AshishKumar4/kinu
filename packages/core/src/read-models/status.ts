/**
 * The workspace's own status, transcript and tool inventory — the three reads
 * a surface makes before it can show anything.
 *
 * All three are folds over storage the agent already owns (`workspace_identity`,
 * SOUL.md, the message tables, `craft_scores` and the CraftStore), which is why
 * none of them is backend-shaped: what a workspace IS does not depend on where
 * it runs.
 */

import type { AgentConfigStore } from '../config/store';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { readSoul, summarizeSoul } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import type { CraftStore } from '../types/agent-runtime';
import type { VFS, SqlExecutor } from '../types/primitives';
import type { CraftedTool } from '../types/craft';
import type { ReasoningEffort } from '../strategy/effort';
import { transcriptRole, uiMessageRow, type StoredRowProjection } from '../utils/ui-message';
import type { JsonObject } from '../utils/json';
import { mapPage, seekPage, StaleCursorError, type Page, type PageRequest } from './page';

/** Widest transcript page a surface may ask for. */
const MAX_HISTORY_LIMIT = 200;

/** Page size when a caller does not care — one screenful of chat and then
 *  some, small enough that scrolling up stays responsive. */
const DEFAULT_HISTORY_LIMIT = 100;

/** One workspace identifier reaches a surface: `name`, the permanent slug it is
 *  addressed by. `workspace_identity.id` is deliberately NOT here — on the cloud
 *  backend it is `ctx.id.toString()`, i.e. `idFromName(name)`, so showing it
 *  beside the name showed the same fact twice; on the local backend it addresses
 *  nothing. Its one real job is fork provenance
 *  (`fork_lineage.source_workspace_id`), which reads the column directly. */
export interface AgentStatus {
  name: string;
  displayName: string;
  purpose: string;
  soul: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
  messageCount: number;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  forkLineage: ForkLineageRow | null;
}

export interface ChatHistoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string | number;
  /**
   * The stored row's own metadata, where the row carried any.
   *
   * The chat classifies a programmatic turn from written markers — the author
   * stamp, the `kinuEvent` name — and for a row that arrived by this walk
   * rather than over the socket, this is the only place those markers can come
   * from. Dropping them is why a fork-interrupted notice kept its card while it
   * was live and lost it the moment the operator scrolled back to it.
   */
  metadata?: JsonObject;
}

export interface ToolListEntry {
  name: string;
  description: string;
  scope: CraftedTool['scope'];
  qualityScore: number;
  usageCount: number;
}

/** What the identity fold cannot read out of storage: who the caller is when
 *  `workspace_identity` has no row yet, and the transcript length before the
 *  first turn has been mirrored into `messages`. */
export interface AgentStatusDeps {
  readonly sql: SqlExecutor;
  /** The workspace filesystem — SOUL.md is a file in it. */
  readonly vfs: VFS;
  readonly config: AgentConfigStore;
  readonly name: string;
  readonly displayName: string;
  readonly fallbackMessageCount: number;
}


function normalizeUiRole(role: string): 'user' | 'assistant' | 'system' | null {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : null;
}

/** Identity, size and configuration in one round trip. Every table read here is
 *  one `initWorkspaceSchema` creates, so a read that fails means a broken
 *  workspace and says so — answering with a fabricated identity and zeroed
 *  counts would make it indistinguishable from a brand-new agent. */
export async function getAgentStatus(deps: AgentStatusDeps): Promise<AgentStatus> {
  const { sql, config, vfs } = deps;
  const soul = (await readSoul(vfs)) ?? '';
  const purpose = summarizeSoul(soul);
  const identity = sql<{ name: string; created_at: number }>`
    SELECT name, created_at FROM workspace_identity LIMIT 1`;
  const scaffoldVersion = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`;
  const searchNodes = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
  const craftedTools = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
  // Message count reflects the persisted `messages` table, which is the
  // authoritative turn history used for fork cut-points. For non-fork agents
  // it is populated by the turn-settle mirror; for forks by
  // forkWorkspaceStorage's copy.
  const tableCount = sql<{ c: number }>`
    SELECT COUNT(*) as c FROM messages WHERE session_id = 'default'`;
  return {
    name: identity[0]?.name ?? deps.name,
    displayName: deps.displayName,
    purpose,
    soul,
    createdAt: identity[0]?.created_at ?? 0,
    scaffoldVersion: scaffoldVersion[0]?.v ?? 0,
    searchNodeCount: searchNodes[0]?.c ?? 0,
    craftedToolCount: craftedTools[0]?.c ?? 0,
    messageCount: tableCount[0]?.c ?? deps.fallbackMessageCount,
    model: config.getModel(),
    reasoningEffort: config.getReasoningEffort(),
    forkLineage: readForkLineage(sql),
  };
}

/**
 * One page of the conversation, newest page first, each page oldest-first.
 *
 * `assistant_messages` is the richer transcript where a backend keeps one
 * (serialized UI messages, and the table the agents SDK's own session provider
 * writes); `messages` is the plain mirror every backend writes. Reading the
 * rich table first and falling back keeps one shape for both.
 *
 * A row the harness enqueued is reported as `system`, not as the operator's
 * words — see {@link transcriptRole}. Both branches apply it: the rich table
 * carries the author stamp inside its serialized message, and the plain mirror
 * carries the row id the same rule falls back to.
 *
 * ── Why the cursor is rowid and not created_at ───────────────────────────────
 * `assistant_messages.created_at` is `DATETIME DEFAULT CURRENT_TIMESTAMP` —
 * whole seconds — and a turn emits several messages inside one second. That is
 * already written down in `identity/session-tree.ts` as the reason a fork cut
 * cannot be a timestamp comparison, and it disqualifies `created_at` as a
 * pagination key for exactly the same reason: ties have no defined order, so
 * `ORDER BY created_at DESC LIMIT n` does not even have a defined MEMBERSHIP
 * when rows n and n+1 share a second. Paging on it would drop and repeat
 * messages at every page boundary without a single concurrent write.
 *
 * `rowid` is total, is the insertion order, and both tables have one (a `TEXT
 * PRIMARY KEY` does not make a table WITHOUT ROWID). `session-tree.ts` already
 * takes `ORDER BY rowid DESC LIMIT 1` as "the latest message", so this is the
 * order this schema was already being read in, now made explicit.
 */
export function getChatHistoryPage(
  sql: SqlExecutor,
  request: PageRequest = {},
): Page<ChatHistoryEntry> {
  const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(request.limit ?? DEFAULT_HISTORY_LIMIT)));
  const after = request.cursor?.after ?? null;
  const over = limit + 1;
  try {
    const from = after === null ? null : anchorRowid(sql`
      SELECT rowid AS seek FROM assistant_messages WHERE id = ${after}`, after);
    return chronological(seekPage(from === null
      ? sql<TranscriptRow>`
        SELECT id, role, content, created_at FROM assistant_messages
        WHERE role IN ('user', 'assistant', 'system')
        ORDER BY rowid DESC LIMIT ${over}`
      : sql<TranscriptRow>`
        SELECT id, role, content, created_at FROM assistant_messages
        WHERE role IN ('user', 'assistant', 'system') AND rowid < ${from}
        ORDER BY rowid DESC LIMIT ${over}`,
      limit, rowId), uiMessageRow);
  } catch (err) {
    // A stale cursor is this read failing, not the rich table being absent.
    // Falling through would answer the mirror's rows under a cursor minted
    // against the transcript, which is a different sequence.
    if (err instanceof StaleCursorError) throw err;
    const from = after === null ? null : anchorRowid(sql`
      SELECT rowid AS seek FROM messages WHERE id = ${after} AND session_id = ${'default'}`, after);
    return chronological(seekPage(from === null
      ? sql<TranscriptRow>`
        SELECT id, role, content, created_at FROM messages
        WHERE session_id = ${'default'} AND role IN ('user', 'assistant', 'system')
        ORDER BY rowid DESC LIMIT ${over}`
      : sql<TranscriptRow>`
        SELECT id, role, content, created_at FROM messages
        WHERE session_id = ${'default'} AND role IN ('user', 'assistant', 'system') AND rowid < ${from}
        ORDER BY rowid DESC LIMIT ${over}`,
      limit, rowId), (content) => ({ text: content }));
  }
}

interface TranscriptRow {
  id: string;
  role: string;
  content: string;
  created_at: string | number;
}

const rowId = (row: TranscriptRow): string => row.id;

/** The cursor's anchor as a rowid, or the refusal that keeps a vanished anchor
 *  from reading as an exhausted conversation. */
function anchorRowid(found: { seek: number }[], after: string): number {
  const seek = found[0]?.seek;
  if (seek === undefined) throw new StaleCursorError('conversation', after);
  return seek;
}

/**
 * A newest-first traversal page, turned into the oldest-first block the UI
 * prepends.
 *
 * The page is built over the RAW rows and only then mapped, because a row this
 * projection drops must still count against the page and must still be able to
 * be the cursor's anchor. Anchoring on the last SURVIVING entry instead would
 * re-deliver every dropped row on the next page.
 */
function chronological(
  page: Page<TranscriptRow>,
  project: (content: string) => StoredRowProjection,
): Page<ChatHistoryEntry> {
  return mapPage(page, (rows) => rows.flatMap((row) => {
    const role = normalizeUiRole(row.role);
    if (!role) return [];
    // A row the harness enqueued reports as `system`, never as the operator's
    // words. One place, because both the transcript and the mirror branch land
    // here — and one rule, the same `turnAuthor` the chat pane renders from.
    const { text, metadata } = project(row.content);
    const entry: ChatHistoryEntry = {
      id: row.id, role: transcriptRole(row.id, role, metadata),
      content: text, createdAt: row.created_at,
    };
    if (metadata !== undefined) entry.metadata = metadata;
    return [entry];
  }).reverse());
}

/** The agent's tool inventory: the fixed builtins plus every crafted tool with
 *  its live fitness score. */
export function getToolList(sql: SqlExecutor, craftStore: CraftStore) {
  const crafted = craftStore.list().map((t) => {
    const scoreRow = sql<{ score: number; uses: number }>`
      SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
    return {
      name: t.name, description: t.description, scope: t.scope,
      qualityScore: scoreRow[0]?.score ?? 0.5,
      usageCount: scoreRow[0]?.uses ?? 0,
    };
  });
  return { builtIn: [...BUILTIN_TOOLS], crafted };
}

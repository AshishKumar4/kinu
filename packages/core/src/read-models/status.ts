/**
 * The workspace's own status, transcript and tool inventory — the three reads
 * a surface makes before it can show anything.
 *
 * All three are folds over storage the agent already owns (`workspace_identity`,
 * SOUL.md, the message tables, the crafted_tools quality columns and the
 * CraftStore), which is why
 * none of them is backend-shaped: what a workspace IS does not depend on where
 * it runs.
 */

import type { AgentConfigStore } from '../config/store';
import { conversationCount, conversationPageRows, type ConversationPageRow } from '../identity/conversation-store';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { readSoul, summarizeSoul } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import type { CraftStore } from '../types/agent-runtime';
import type { VFS, SqlExecutor } from '../types/primitives';
import type { CraftedTool } from '../types/craft';
import type { ReasoningEffort } from '../strategy/effort';
import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { transcriptRole, uiMessageRow, type StoredRowProjection } from '../utils/ui-message';
import { JsonObjectSchema, parseJsonValue, type JsonObject } from '../utils/json';
import { mapPage, type Page, type PageRequest } from './page';


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
   *
   * The field's one reader is the served transcript: `getChatHistoryPage`
   * feeds `mergeTranscript`, and the pane classifies the restored half from
   * it. The CLI reads stored rows only to rebuild the model's context, and
   * there the markers ride the row's own text, so it has no reader for this
   * field. That asymmetry is declared here on purpose, not omitted.
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
 *  `workspace_identity` has no row yet. */
export interface AgentStatusDeps {
  readonly sql: SqlExecutor;
  /** The workspace filesystem — SOUL.md is a file in it. */
  readonly vfs: VFS;
  readonly config: AgentConfigStore;
  readonly name: string;
  readonly displayName: string;
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
  // Message count reflects the canonical conversation store — the workspace's
  // default-chat authority, whichever table owns it.
  const messageCount = conversationCount(sql);
  const searchNodes = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
  const craftedTools = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
  return {
    name: identity[0]?.name ?? deps.name,
    displayName: deps.displayName,
    purpose,
    soul,
    createdAt: identity[0]?.created_at ?? 0,
    scaffoldVersion: scaffoldVersion[0]?.v ?? 0,
    searchNodeCount: searchNodes[0]?.c ?? 0,
    messageCount,
    craftedToolCount: craftedTools[0]?.c ?? 0,
    model: config.getModel(),
    reasoningEffort: config.getReasoningEffort(),
    forkLineage: readForkLineage(sql),
  };
}

/**
 * One page of the conversation, newest page first, each page oldest-first.
 *
 * The rows come from the canonical conversation store; this is the projection
 * that turns a stored row into what a surface renders. A row the harness
 * enqueued is reported as `system`, not as the operator's words — see
 * {@link transcriptRole}: the pane-encoded rows carry the author stamp inside
 * their serialized message, plain rows carry it in their `metadata` column —
 * with the row id left as the fallback for rows written before either stamp
 * existed.
 *
 * The page is built over the RAW rows and only then mapped, because a row this
 * projection drops must still count against the page and must still be able to
 * be the cursor's anchor. Anchoring on the last SURVIVING entry instead would
 * re-deliver every dropped row on the next page. Why the cursor is rowid and
 * not created_at is written down once, in `identity/conversation-store.ts`.
 */
export function getChatHistoryPage(
  sql: SqlExecutor,
  request: PageRequest = {},
): Page<ChatHistoryEntry> {
  return mapPage(conversationPageRows(sql, request), (rows) => rows.flatMap((row) => {
    const role = normalizeUiRole(row.role);
    if (!role) return [];
    const { text, metadata } = projectStoredRow(row);
    const entry: ChatHistoryEntry = {
      id: row.id, role: transcriptRole(row.id, role, metadata),
      content: text, createdAt: row.createdAt,
    };
    if (metadata !== undefined) entry.metadata = metadata;
    return [entry];
  }).reverse());
}

const MirrorStampSchema = v.optional(JsonObjectSchema);

/** A stored row's display shape: its plain text and provenance from ONE parse.
 *  Pane-encoded rows state provenance inside the serialized message; plain
 *  rows state it in their column. A NULL or unparseable stamp leaves the id-
 *  prefix fallback inside {@link transcriptRole} in charge — the rule for
 *  everything written before stamps existed. */
function projectStoredRow(row: ConversationPageRow): StoredRowProjection {
  const projected = uiMessageRow(row.content);
  if (projected.metadata !== undefined || !row.metadata) return projected;
  const decoded = tolerate(() => parseJsonValue(row.metadata!), 'malformed-input');
  const parsed = decoded === undefined ? undefined : v.safeParse(MirrorStampSchema, decoded);
  return parsed?.success && parsed.output !== undefined
    ? { text: projected.text, metadata: parsed.output }
    : { text: projected.text };
}

/** The agent's tool inventory: the fixed builtins plus every crafted tool with
 *  its live fitness score. */
export function getToolList(sql: SqlExecutor, craftStore: CraftStore) {
  const crafted = craftStore.list().map((t) => {
    const scoreRow = sql<{ score: number; uses: number }>`
      SELECT score, uses FROM crafted_tools WHERE name = ${t.name} LIMIT 1`;
    return {
      name: t.name, description: t.description, scope: t.scope,
      qualityScore: scoreRow[0]?.score ?? 0.5,
      usageCount: scoreRow[0]?.uses ?? 0,
    };
  });
  return { builtIn: [...BUILTIN_TOOLS], crafted };
}

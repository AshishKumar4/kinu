/**
 * The workspace's own status, transcript and tool inventory — the three reads
 * a surface makes before it can show anything.
 *
 * All three are folds over storage the agent already owns (`workspace_identity`,
 * SOUL.md, the message tables, `craft_scores` and the CraftStore), which is why
 * none of them is backend-shaped: what a workspace IS does not depend on where
 * it runs.
 */

import type { AgentConfigStore } from '../config/store.js';
import * as v from 'valibot';
import { readForkLineage, type ForkLineageRow } from '../identity/fork.js';
import { readSoul, summarizeSoul } from '../identity/soul.js';
import { BUILTIN_TOOLS } from '../tools/registry.js';
import type { CraftStore } from '../types/agent-runtime.js';
import type { VFS, SqlExecutor } from '../types/primitives.js';
import type { CraftedTool } from '../types/craft.js';
import type { ReasoningEffort } from '../strategy/effort.js';
import { parseJsonValue } from '../utils/json.js';

const UiMessageSchema = v.object({
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
});

/** Widest transcript page a surface may ask for. */
const MAX_HISTORY_LIMIT = 200;

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

/** Flatten a stored UIMessage-JSON content string to plain text
 *  (`assistant_messages` rows hold the serialized UI message, not text). */
export function uiMessageText(content: string): string {
  try {
    const parsed = v.safeParse(UiMessageSchema, parseJsonValue(content));
    if (parsed.success && parsed.output.parts) {
      return parsed.output.parts
        .flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : [])
        .join('');
    }
  } catch { /* plain text fallback */ }
  return content;
}

function normalizeUiRole(role: string): 'user' | 'assistant' | 'system' | null {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : null;
}

/** Identity, size and configuration in one round trip. Storage this young can
 *  legitimately be missing every table, so an unreadable workspace answers
 *  with what the caller already knows rather than failing the surface. */
export async function getAgentStatus(deps: AgentStatusDeps): Promise<AgentStatus> {
  const { sql, config, vfs } = deps;
  try {
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
  } catch {
    return {
      name: deps.name, displayName: deps.name, purpose: '', soul: '', createdAt: 0,
      scaffoldVersion: 0, searchNodeCount: 0, craftedToolCount: 0, messageCount: 0,
      model: config.getModel(),
      reasoningEffort: config.getReasoningEffort(),
      forkLineage: null,
    };
  }
}

/**
 * The newest page of the conversation, oldest-first.
 *
 * `assistant_messages` is the richer transcript where a backend keeps one
 * (serialized UI messages); `messages` is the plain mirror every backend
 * writes. Reading the rich table first and falling back keeps one shape for
 * both.
 */
export function getChatHistory(sql: SqlExecutor, limit = 100): ChatHistoryEntry[] {
  const bounded = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limit)));
  try {
    const rows = sql<{ id: string; role: string; content: string; created_at: string }>`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM assistant_messages
        WHERE role IN ('user', 'assistant', 'system')
        ORDER BY created_at DESC
        LIMIT ${bounded}
      ) sub
      ORDER BY created_at ASC
    `;
    return rows.flatMap((row) => {
      const role = normalizeUiRole(row.role);
      if (!role) return [];
      return [{ id: row.id, role, content: uiMessageText(row.content), createdAt: row.created_at }];
    });
  } catch {
    const rows = sql<{ id: string; role: string; content: string; created_at: number }>`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ${'default'} AND role IN ('user', 'assistant', 'system')
      ORDER BY created_at ASC
      LIMIT ${bounded}
    `;
    return rows.flatMap((row) => {
      const role = normalizeUiRole(row.role);
      if (!role) return [];
      return [{ id: row.id, role, content: row.content, createdAt: row.created_at }];
    });
  }
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

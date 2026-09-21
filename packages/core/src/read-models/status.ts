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

import type { ActorHandle } from '../identity/actor-handle';
import { conversationCount } from '../identity/conversation-store';
import type { SessionTranscriptReader } from '../orchestrator/session-transcript';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { readSoul, summarizeSoul } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import { CRAFT_NEUTRAL_PRIOR } from '../craft/in-episode';
import type { CraftStore } from '../types/agent-runtime';
import type { VFS, SqlExecutor } from '../types/primitives';
import type { CraftedTool } from '../types/craft';
import type { ReasoningEffort } from '../strategy/effort';
import { transcriptRole } from '../utils/ui-message';
import type { ChatHistoryEntry } from '../types/chat';
import { mapPage, type Page, type PageRequest } from './page';

export type { ChatHistoryEntry } from '../types/chat';

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
  model: string;
  reasoningEffort: ReasoningEffort | null;
  forkLineage: ForkLineageRow | null;
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
  /** Whose workspace this is. The scaffold pointer is per-actor, so the version
   *  a status reports has to be the one this actor runs. */
  readonly actor: ActorHandle;
  /** The workspace filesystem — SOUL.md is a file in it. */
  readonly vfs: VFS;
  /** The spec the NEXT turn runs, as the caller's one resolution spells it — a
   *  claimed tier's model, else the stored spec. Never the stored override
   *  alone: that is null on a workspace running its tier's model, and a status
   *  that reported it painted "no model" beside a turn that just answered. */
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
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
  const { sql, actor, vfs } = deps;
  actor.assertCurrent();
  const soul = (await readSoul(vfs)) ?? '';
  const purpose = summarizeSoul(soul);

  const identity = sql<{ name: string; created_at: number }>`
    SELECT name, created_at FROM workspace_identity LIMIT 1`;

  const scaffoldVersion = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions
    WHERE actor_id = ${actor.actorId}`;

  // Message count reflects the canonical conversation store — the workspace's
  // default-chat authority, whichever table owns it.
  const messageCount = conversationCount(sql, actor);

  const searchNodes = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes
    WHERE actor_id = ${actor.actorId}`;

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
    model: deps.model,
    reasoningEffort: deps.reasoningEffort,
    forkLineage: readForkLineage(sql),
  };
}

/** Newest page first, each page displayed oldest-first; cursors count raw entries. */
export async function getChatHistoryPage(
  transcript: SessionTranscriptReader,
  request: PageRequest = {},
): Promise<Page<ChatHistoryEntry>> {
  return mapPage(await transcript.page(request), rows => rows.flatMap(row => {
    const role = normalizeUiRole(row.role);

    if (!role) return [];

    const entry: ChatHistoryEntry = {
      id: row.id, role: transcriptRole(row.id, role, row.metadata),
      content: row.content, createdAt: row.recordedAt,
    };

    if (row.metadata !== undefined) entry.metadata = row.metadata;

    return [entry];
  }).reverse());
}

/** The agent's tool inventory: the fixed builtins plus every crafted tool with
 *  its live fitness score. */
export function getToolList(sql: SqlExecutor, craftStore: CraftStore) {
  const crafted = craftStore.list().map((t) => {
    const scoreRow = sql<{ score: number; uses: number }>`
      SELECT score, uses FROM crafted_tools WHERE name = ${t.name} LIMIT 1`;

    return {
      name: t.name, description: t.description, scope: t.scope,
      qualityScore: scoreRow[0]?.score ?? CRAFT_NEUTRAL_PRIOR,
      usageCount: scoreRow[0]?.uses ?? 0,
    };
  });

  return { builtIn: [...BUILTIN_TOOLS], crafted };
}

/** Status, transcript and tool inventory: folds over agent-owned storage, so none is backend-shaped. */

import type { ActorHandle } from '../identity/actor-handle';
import { conversationCount } from '../identity/conversation-store';
import type { SessionTranscriptReader } from '../session/transcript';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { readSoul, summarizeSoul } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import { CRAFT_NEUTRAL_PRIOR } from '../craft/in-episode';
import type { CraftStore } from '../types/agent-runtime';
import type { VFS, SqlExecutor } from '../types/primitives';
import type { CraftedTool } from '../types/craft';
import type { ReasoningEffort } from '../providers/effort';
import { transcriptRole } from '../utils/ui-message';
import type { ChatHistoryEntry } from '../types/chat';
import { mapPage, type Page, type PageRequest } from '../session/page';

export type { ChatHistoryEntry } from '../types/chat';

/** Only `name` reaches a surface: `workspace_identity.id` is `idFromName(name)` on cloud and addresses
 * nothing locally; fork provenance reads the column directly. */
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

export interface AgentStatusDeps {
  readonly sql: SqlExecutor;
  /** The scaffold pointer is per-actor, so the status reports this actor's version. */
  readonly actor: ActorHandle;
  readonly vfs: VFS;
  /** The spec the next turn runs (claimed tier's model, else the stored spec); never the stored override
   * alone, which is null on a workspace running its tier's model. */
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly name: string;
  readonly displayName: string;
}

function normalizeUiRole(role: string): 'user' | 'assistant' | 'system' | null {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : null;
}

/** Every table read here is created by `initWorkspaceSchema`, so a failed read means a broken workspace
 * and throws rather than answering with a fabricated identity. */
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
      id: row.id, role: transcriptRole({ id: row.id, role, metadata: row.metadata }),
      content: row.content, createdAt: row.recordedAt,
    };

    if (row.metadata !== undefined) entry.metadata = row.metadata;

    if (row.unavailable === true) entry.unavailable = true;

    return [entry];
  }).reverse());
}

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

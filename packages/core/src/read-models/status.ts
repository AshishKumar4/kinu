/** Status, transcript and tool inventory: folds over agent-owned storage, so none is backend-shaped. */

import type { ActorHandle } from '../identity/actor-handle';
import { getCurrentScaffoldVersion } from '../scaffold/versions';
import { readSessionTranscript, type SessionTranscriptReader } from '../session/transcript';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { missionOf } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import { CRAFT_NEUTRAL_PRIOR } from '../craft/in-episode';
import type { CraftStore } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import type { ReasoningEffort } from '../providers/effort';
import { transcriptRole } from '../utils/ui-message';
import type { ChatHistoryEntry } from '../types/chat';
import { mapPage, type Page, type PositionCursor, type PositionPageRequest } from '../session/page';

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
  messageCount: number;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  forkLineage: ForkLineageRow | null;
}

export interface ToolListEntry {
  name: string;
  description: string;
  qualityScore: number;
  usageCount: number;
}

export interface AgentStatusDeps {
  readonly sql: SqlExecutor;
  /** SOUL.md, whose mission the status names. */
  readonly soul: () => Promise<string | null>;
  /** The scaffold pointer is per-actor, so the status reports this actor's version. */
  readonly actor: ActorHandle;
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
  const { sql, actor } = deps;
  actor.assertCurrent();
  const soul = await deps.soul();
  const purpose = missionOf(soul) ?? '';

  const identity = sql<{ name: string; created_at: number }>`
    SELECT name, created_at FROM workspace_identity LIMIT 1`;


  const messageCount = readSessionTranscript(sql, actor, CHAT_SESSION_ID, null).count();

  const searchNodes = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes
    WHERE actor_id = ${actor.actorId}`;


  return {
    name: identity[0]?.name ?? deps.name,
    displayName: deps.displayName,
    purpose,
    soul: soul ?? '',
    createdAt: identity[0]?.created_at ?? 0,
    scaffoldVersion: getCurrentScaffoldVersion(sql, actor) ?? 0,
    searchNodeCount: searchNodes[0]?.c ?? 0,
    messageCount,
    model: deps.model,
    reasoningEffort: deps.reasoningEffort,
    forkLineage: readForkLineage(sql),
  };
}

/** Newest page first, each page displayed oldest-first; a cursor names a position. */
export async function getChatHistoryPage(
  transcript: SessionTranscriptReader,
  request: PositionPageRequest = {},
): Promise<ChatHistoryPage> {
  const page = await transcript.page(request);

  return mapPage(page, rows => rows.flatMap(row => {
    const role = normalizeUiRole(row.role);

    if (!role) return [];

    const entry: ChatHistoryEntry = {
      id: row.id, position: row.position, role: transcriptRole({ id: row.id, role, metadata: row.metadata }),
      turnId: row.turnId, content: row.content, createdAt: row.recordedAt,
    };

    if (row.metadata !== undefined) entry.metadata = row.metadata;

    if (row.unavailable === true) entry.unavailable = true;

    return [entry];
  }).reverse());
}

export type ChatHistoryPage = Page<ChatHistoryEntry, PositionCursor>;

export function getToolList(sql: SqlExecutor, craftStore: CraftStore) {
  const crafted = craftStore.list().map((t) => {
    const scoreRow = sql<{ score: number; uses: number }>`
      SELECT score, uses FROM crafted_tools WHERE name = ${t.name} LIMIT 1`;

    return {
      name: t.name, description: t.description,
      qualityScore: scoreRow[0]?.score ?? CRAFT_NEUTRAL_PRIOR,
      usageCount: scoreRow[0]?.uses ?? 0,
    };
  });

  return { builtIn: [...BUILTIN_TOOLS], crafted };
}

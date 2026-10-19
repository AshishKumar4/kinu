/** Status, transcript and tool inventory: folds over agent-owned storage, so none is backend-shaped. */

import type { ActorHandle } from '../identity/actor-handle';
import { getCurrentScaffoldVersion } from '../scaffold/versions';
import { readSessionTranscript, type SessionTranscriptReader } from '../session/transcript';
import { CHAT_PAGE_BYTES, CHAT_SESSION_ID } from '../session/transcript-schema';
import { readForkLineage, type ForkLineageRow } from '../identity/fork';
import { missionOf } from '../identity/soul';
import { BUILTIN_TOOLS } from '../tools/registry';
import { CRAFT_NEUTRAL_PRIOR } from '../craft/in-episode';
import type { SqlExecutor } from '../types/primitives';
import type { ReasoningEffort } from '../providers/effort';
import type { TierSource } from '../profiles/resolve';
import type { RoleId } from '../types/profile';
import type { PlanReview } from '../types/plans';
import type { InlineSteer } from './transcript';
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { JsonObjectSchema } from '../utils/json';
import type { MediaUrl } from '../session/chat-media';
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

/**
 * What a chat's pane draws of its agent, the workspace's own or a hosted one alike (`getActorSnapshot`): who it is, the
 * model and thinking its next turn runs and where the model came from, its plan, its length, and the sends it holds.
 */
export interface ActorSnapshot {
  readonly name: string;
  /** The id every frame broadcast for this agent is stamped with; a pane filters frames by it. */
  readonly actorId: string;
  readonly displayName: string;
  readonly role: RoleId;
  readonly mission: string;
  /** The resolution the next turn makes, not the agent's own pin, which may be unset. */
  readonly model: { readonly model: string; readonly source: TierSource };
  readonly reasoningEffort: ReasoningEffort | null;
  readonly activePlan: PlanReview | null;
  /** Counted in the store: a pane holds only a window. */
  readonly messageCount: number;
  /** No live broadcast repeats the queue for a tab that was gone when the steer was taken. */
  readonly pendingSteers: readonly InlineSteer[];
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

/** What a status says of an actor from its workspace's storage and SOUL.md alone, folded the same on every backend and
 * in the CLI's read-only inspection. */
export type AgentStatusFacts = Omit<AgentStatus, 'displayName' | 'model' | 'reasoningEffort'>;

/** Every table read here is created by `initWorkspaceSchema`, so a failed read means a broken workspace and throws
 * rather than answering with a fabricated identity. `name` stands in only for a missing identity row. */
export function agentStatusFacts(sql: SqlExecutor, actor: ActorHandle, soul: string | null, name: string): AgentStatusFacts {
  actor.assertCurrent();

  const identity = sql<{ name: string; created_at: number }>`
    SELECT name, created_at FROM workspace_identity LIMIT 1`;

  const searchNodes = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes
    WHERE actor_id = ${actor.actorId}`;

  return {
    name: identity[0]?.name ?? name,
    purpose: missionOf(soul) ?? '',
    soul: soul ?? '',
    createdAt: identity[0]?.created_at ?? 0,
    scaffoldVersion: getCurrentScaffoldVersion(sql, actor) ?? 0,
    searchNodeCount: searchNodes[0]?.c ?? 0,
    messageCount: readSessionTranscript(sql, actor, CHAT_SESSION_ID, null).count(),
    forkLineage: readForkLineage(sql),
  };
}

export async function getAgentStatus(deps: AgentStatusDeps): Promise<AgentStatus> {
  return {
    ...agentStatusFacts(deps.sql, deps.actor, await deps.soul(), deps.name),
    displayName: deps.displayName, model: deps.model, reasoningEffort: deps.reasoningEffort,
  };
}

/** Newest page first, each page displayed oldest-first and drawn whole, each image an address `media` mints; a cursor
 *  names a position. The same read as the chat's seed ({@link chatSeed}). */
export async function getChatHistoryPage(
  transcript: SessionTranscriptReader,
  request: PositionPageRequest,
  media: MediaUrl,
): Promise<ChatHistoryPage> {
  const page = await transcript.drawnPage({ ...request, bytes: CHAT_PAGE_BYTES, media });

  return mapPage(page, (rows) => rows.flatMap(({ entry, message }) => {
    // The message's own role, as the transcript drew it for the seed too; an unreadable row's, as stored.
    const role = normalizeUiRole(message?.role ?? entry.role);

    if (!role) return [];
    const metadata = v.safeParse(JsonObjectSchema, message?.metadata);
    const parts = message === null ? [] : v.parse(v.array(JsonObjectSchema), message.parts);

    const drawn: ChatHistoryEntry = {
      id: entry.id, position: entry.position, role, turnId: entry.turnId, runId: entry.runId, parts, createdAt: entry.recordedAt,
    };

    if (metadata.success) drawn.metadata = metadata.output;

    if (message === null) drawn.unavailable = true;

    return [drawn];
  }));
}

/** What a tab is sent of a chat as it connects or a turn ends: its newest page, oldest first. */
export async function chatSeed(transcript: SessionTranscriptReader, media: MediaUrl): Promise<UIMessage[]> {
  const page = await transcript.drawnPage({ bytes: CHAT_PAGE_BYTES, media });

  return page.items.flatMap(({ message }) => (message === null ? [] : [message]));
}

export type ChatHistoryPage = Page<ChatHistoryEntry, PositionCursor>;

/** The tools an agent has: the built-ins and what it crafted, newest first, each with its quality and use. */
export function getToolList(sql: SqlExecutor) {
  const crafted = sql<{ name: string; description: string; score: number | null; uses: number | null }>`
    SELECT name, description, score, uses FROM crafted_tools ORDER BY updated_at DESC`.map((row) => ({
    name: row.name, description: row.description,
    qualityScore: row.score ?? CRAFT_NEUTRAL_PRIOR,
    usageCount: row.uses ?? 0,
  }));

  return { builtIn: [...BUILTIN_TOOLS], crafted };
}

/**
 * `experience` — cross-workspace experience transfer, one tool, three actions.
 *
 *   publish — offer what THIS workspace has proven to the owner's library
 *             (no arguments: what it could offer, and why each qualifies).
 *   search  — retrieve what the owner's OTHER workspaces have proven.
 *   import  — stage one library entry here: gated, provisional, returned inline.
 *
 * The tool exists only where a library client is wired — the workspace
 * orchestrator on the cloud backend. Subordinates and local CLI sessions have
 * no cross-workspace reach and therefore no tool, structurally rather than by
 * flag, exactly as the peer transport is gated.
 */
import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { FactsStore } from '../memory/facts.js';
import {
  EXPERIENCE_KINDS,
  describePayload,
  findPublishable,
  listPublishable,
  stageImport,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
} from '../experience/index.js';

/** The owner's library, as reached from a workspace. Every method crosses the
 *  capability boundary on the backend that implements it. */
export interface ExperienceLibraryClient {
  publish(candidate: PublishableCandidate): Promise<ExperienceEntry>;
  search(options: { query?: string; kind?: ExperienceKind; limit?: number }): Promise<ExperienceEntry[]>;
  get(id: string): Promise<ExperienceEntry | null>;
}

export interface ExperienceToolDeps {
  library: ExperienceLibraryClient;
  /** This workspace's own stores — what it publishes from and imports into. */
  rt: AgentRuntime;
  facts: FactsStore;
}

/** The action surface, in the order the docstring introduces it. The schema
 *  enum and the dispatch guard both read this, so they cannot drift. */
const EXPERIENCE_ACTIONS = ['publish', 'search', 'import'] as const;

type ExperienceAction = (typeof EXPERIENCE_ACTIONS)[number];

interface ExperienceToolInput {
  action: ExperienceAction;
  kind?: ExperienceKind;
  key?: string;
  query?: string;
  limit?: number;
  id?: string;
}

function summarize(entry: ExperienceEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    key: entry.key,
    title: entry.title,
    evidence: entry.evidence,
    source_workspace: entry.sourceWorkspace,
    preview: describePayload(entry.payload),
  };
}

function summarizeCandidate(candidate: PublishableCandidate) {
  return {
    kind: candidate.kind,
    key: candidate.key,
    title: candidate.title,
    evidence: candidate.evidence,
  };
}

export function createExperienceTool(deps: ExperienceToolDeps): ToolSet[string] {
  const sources = { sql: deps.rt.storage.sql, craftStore: deps.rt.craftStore, facts: deps.facts };

  return tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.experience,
    inputSchema: jsonSchema<ExperienceToolInput>({
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...EXPERIENCE_ACTIONS],
          description:
            'publish = share one proven artifact from this workspace (omit kind/key to see what qualifies). '
            + 'search = find what the owner\'s other workspaces proved. '
            + 'import = stage one search hit here.',
        },
        kind: {
          type: 'string',
          enum: [...EXPERIENCE_KINDS],
          description: 'craft (a crafted tool), lesson (corroborated reflection prose), or fact (a keyed value). Names what to publish; filters a search.',
        },
        key: {
          type: 'string',
          description: 'For action=publish: the crafted tool name, lesson id, or fact key to share.',
        },
        query: { type: 'string', description: 'For action=search: free-text query. Omit to list the newest entries.' },
        limit: { type: 'number', description: 'For action=search: max hits (default 10, max 25).' },
        id: { type: 'string', description: 'For action=import: the library entry id from a search hit.' },
      },
    }),
    execute: async (input: ExperienceToolInput) => {
      if (!(EXPERIENCE_ACTIONS as readonly string[]).includes(input.action)) {
        return { error: `action "${String(input.action)}" is not available. Available: ${EXPERIENCE_ACTIONS.join(', ')}` };
      }
      try {
        switch (input.action) {
          case 'publish': {
            if (!input.kind || !input.key) {
              const candidates = listPublishable(sources);
              return candidates.length === 0
                ? { publishable: [], note: 'Nothing here has earned publication yet — a craft needs real uses, a lesson needs corroboration, a fact needs confidence.' }
                : { publishable: candidates.map(summarizeCandidate), note: 'Publish one with kind + key.' };
            }
            const candidate = findPublishable(sources, input.kind, input.key);
            if ('refused' in candidate) return { error: candidate.refused };
            return { published: summarize(await deps.library.publish(candidate)) };
          }

          case 'search': {
            const hits = await deps.library.search({
              ...(input.query ? { query: input.query } : {}),
              ...(input.kind ? { kind: input.kind } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            });
            return hits.length === 0
              ? { hits: [], note: 'The owner\'s other workspaces have published nothing matching this yet.' }
              : { hits: hits.map(summarize), note: 'Import one with action:"import" and its id.' };
          }

          case 'import': {
            if (!input.id) return { error: 'import requires the library entry id' };
            const entry = await deps.library.get(input.id);
            if (!entry) return { error: `no library entry with id "${input.id}"` };
            const staged = stageImport(deps.rt, entry);
            if (!staged.ok) return { error: staged.reason };
            return {
              imported: summarize(entry),
              status: 'provisional',
              payload: entry.payload,
              note: 'Use it now — it is in front of you. It becomes part of this workspace only if this turn '
                + 'ends up accepted; a corrected or frustrated turn discards it.',
            };
          }
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

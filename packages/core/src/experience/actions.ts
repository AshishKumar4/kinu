/**
 * The three things anyone can do with the owner's experience library:
 * publish what this workspace has proven, search what the owner's other
 * workspaces proved, and import one entry here.
 *
 * This is the whole behaviour, independent of who asks. It was the body of an
 * `experience` tool until the surface it sat on became the wrong one: sharing
 * proven work across workspaces is a rare, deliberate, owner-shaped decision,
 * not something an agent should be weighing on every turn — and every tool on
 * the model's surface costs attention on all of them. The library kept
 * working; only its caller changed, from the model to the owner's RPCs.
 */
import {
  describePayload,
  findPublishable,
  listPublishable,
  stageImport,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
} from './index.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { FactsStore } from '../memory/facts.js';

/** The owner's library, as reached from a workspace. Every method crosses the
 *  capability boundary on the backend that implements it. */
export interface ExperienceLibraryClient {
  publish(candidate: PublishableCandidate): Promise<ExperienceEntry>;
  search(options: { query?: string; kind?: ExperienceKind; limit?: number }): Promise<ExperienceEntry[]>;
  get(id: string): Promise<ExperienceEntry | null>;
}

export interface ExperienceActionDeps {
  library: ExperienceLibraryClient;
  /** This workspace's own stores — what it publishes from and imports into. */
  rt: AgentRuntime;
  facts: FactsStore;
}

export const EXPERIENCE_ACTIONS = ['publish', 'search', 'import'] as const;

export type ExperienceAction = (typeof EXPERIENCE_ACTIONS)[number];

export interface ExperienceActionInput {
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

/** Dispatch one library action. Errors come back in the result rather than
 *  thrown: every caller is a surface that has to render a refusal ("nothing
 *  here qualifies yet") as an ordinary answer, not as a failure. */
export async function runExperienceAction(
  deps: ExperienceActionDeps,
  input: ExperienceActionInput,
): Promise<Record<string, unknown>> {
  if (!(EXPERIENCE_ACTIONS as readonly string[]).includes(input.action)) {
    return { error: `action "${String(input.action)}" is not available. Available: ${EXPERIENCE_ACTIONS.join(', ')}` };
  }
  const sources = { sql: deps.rt.storage.sql, craftStore: deps.rt.craftStore, facts: deps.facts };
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
          note: 'Staged provisionally: it becomes part of this workspace once this turn is accepted.',
        };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

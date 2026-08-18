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
import * as v from 'valibot';
import {
  describePayload,
  findPublishable,
  listPublishable,
  stageImport,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
} from './index';
import type { AgentRuntime } from '../types/agent-runtime';
import type { FactsStore } from '../memory/facts';

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

const ExperienceActionInputSchema: v.GenericSchema<ExperienceActionInput> = v.object({
  action: v.picklist(EXPERIENCE_ACTIONS),
  kind: v.optional(v.picklist(['craft', 'lesson', 'fact'])),
  key: v.optional(v.string()),
  query: v.optional(v.string()),
  limit: v.optional(v.number()),
  id: v.optional(v.string()),
});

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
export async function runExperienceAction<Input>(
  deps: ExperienceActionDeps,
  input: Input,
) {
  const request = v.safeParse(ExperienceActionInputSchema, input);
  if (!request.success) {
    const attempted = v.safeParse(v.object({ action: v.string() }), input);
    const subject = attempted.success ? `action "${attempted.output.action}"` : 'action';
    return { error: `${subject} is not available. Available: ${EXPERIENCE_ACTIONS.join(', ')}` };
  }
  const sources = { sql: deps.rt.storage.sql, craftStore: deps.rt.craftStore, facts: deps.facts };
  try {
    switch (request.output.action) {
      case 'publish': {
        if (!request.output.kind || !request.output.key) {
          const candidates = listPublishable(sources);
          return candidates.length === 0
            ? { publishable: [], note: 'Nothing here has earned publication yet — a craft needs real uses, a lesson needs corroboration, a fact needs confidence.' }
            : { publishable: candidates.map(summarizeCandidate), note: 'Publish one with kind + key.' };
        }
        const candidate = findPublishable(sources, request.output.kind, request.output.key);
        if ('refused' in candidate) return { error: candidate.refused };
        return { published: summarize(await deps.library.publish(candidate)) };
      }

      case 'search': {
        const hits = await deps.library.search({
          query: request.output.query,
          kind: request.output.kind,
          limit: request.output.limit,
        });
        return hits.length === 0
          ? { hits: [], note: 'The owner\'s other workspaces have published nothing matching this yet.' }
          : { hits: hits.map(summarize), note: 'Import one with action:"import" and its id.' };
      }

      case 'import': {
        if (!request.output.id) return { error: 'import requires the library entry id' };
        const entry = await deps.library.get(request.output.id);
        if (!entry) return { error: `no library entry with id "${request.output.id}"` };
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

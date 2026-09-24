// Publish, search and import against the owner's experience library; called from owner RPCs, not a model tool.
import * as v from 'valibot';
import {
  EXPERIENCE_KINDS,
  describePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
} from './types';
import { findPublishable, listPublishable } from './publishable';
import { stageImport } from './imports';
import { readScaffoldVersion } from '../scaffold/shadow';
import type { AgentRuntime } from '../types/agent-runtime';
import type { FactsStore } from '../memory/facts';
import { renderThrownChain } from '../obs/index';

/** Every method crosses the capability boundary on the implementing backend. */
export interface ExperienceLibraryClient {
  publish(candidate: PublishableCandidate): Promise<ExperienceEntry>;
  search(options: { query?: string; kind?: ExperienceKind; limit?: number }): Promise<ExperienceEntry[]>;
  get(id: string): Promise<ExperienceEntry | null>;
}

export interface ExperienceActionDeps {
  library: ExperienceLibraryClient;
  rt: AgentRuntime;
  facts: FactsStore;
}

const EXPERIENCE_ACTIONS = ['publish', 'search', 'import'] as const;

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
  kind: v.optional(v.picklist(EXPERIENCE_KINDS)),
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

/** Errors are returned, not thrown: callers render refusals as ordinary answers. */
export async function runExperienceAction(
  deps: ExperienceActionDeps,
  input: { readonly value: unknown },
) {
  const request = v.safeParse(ExperienceActionInputSchema, input.value);

  if (!request.success) {
    const attempted = v.safeParse(v.object({ action: v.string() }), input.value);
    const subject = attempted.success ? `action "${attempted.output.action}"` : 'action';

    return { error: `${subject} is not available. Available: ${EXPERIENCE_ACTIONS.join(', ')}` };
  }

  const sources = {
    sql: deps.rt.storage.sql,
    craftStore: deps.rt.craftStore,
    facts: deps.facts,
    actor: deps.rt.actor,
    readScaffoldVersion: (version: number) => readScaffoldVersion(deps.rt, version),
  };

  try {
    switch (request.output.action) {
      case 'publish': {
        if (!request.output.kind || !request.output.key) {
          const candidates = await listPublishable(sources);

          return candidates.length === 0
            ? { publishable: [], note: 'Nothing here has earned publication yet — a craft needs real uses, a lesson needs corroboration, a fact needs confidence, a scaffold needs a promotion it earned and graded turns behind it.' }
            : { publishable: candidates.map(summarizeCandidate), note: 'Publish one with kind + key.' };
        }

        const candidate = await findPublishable(sources, request.output.kind, request.output.key);

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
          note: entry.kind === 'scaffold'
            ? 'Staged provisionally: once this turn is accepted it is PROPOSED as a pending scaffold version here, and it has to win this workspace\'s own shadow trial before it ever runs.'
            : 'Staged provisionally: it becomes part of this workspace once this turn is accepted.',
        };
      }
    }
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

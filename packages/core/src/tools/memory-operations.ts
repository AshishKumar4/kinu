/** The memory operations served over an agent's stores, natively and as `memory.*`. */
import { Effect } from 'effect';
import type { Memory, MemorySearchResult } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { VectorStore } from '../memory/vector-store';
import { reciprocalRankFusion } from '../memory/vector-store';
import { appendMemoryNote } from '../memory/note';
import { normalizeFactKey, searchFacts, type FactSearchHit, type FactsStore } from '../memory/facts';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search';
import type { ConversationRecall } from '../memory/conversation-search';
import { KinuError, renderThrownChain, toKinuError } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import type { CodemodeProvider } from '../types/codemode';
import { MEMORY } from '../operations/memory';

export interface MemoryDeps {
  readonly memory: Memory;
  /** null: no semantic index; search says so. */
  readonly vectorStore?: VectorStore | null;
  /** remember, recall and forget are served only when set. */
  readonly facts?: FactsStore;
  readonly actor: ActorHandle;
  /** Bound to this actor, so recall reads only its rows. */
  readonly conversations: ConversationRecall;
}

/** Read per call, so a rebound store applies; the facts gate is read once, as a FactsStore never changes in a session. */
export function serveMemory(deps: () => MemoryDeps): readonly Served[] {
  const served = [
    serve(MEMORY.note, async ({ content }) => {
      const { memory, actor } = deps();

      await appendMemoryNote(memory, content, { by: actor.name });

      return { saved: true as const };
    }),
    serve(MEMORY.search, async ({ query }) => await searchMemory(deps(), query)),
    serve(MEMORY.searchConversations, ({ query, limit }) => recalled(() => deps().conversations.search(query, limit ?? 5)).pipe(Effect.map((hits) => ({ hits })))),
    serve(MEMORY.readConversation, ({ messageId, window, maxChars }) => recalled(() => deps().conversations.scroll(messageId, window ?? 5, maxChars)).pipe(
      Effect.flatMap((view) => (view === null ? Effect.fail(new KinuError('missing', `no message with id ${messageId}`)) : Effect.succeed(view))),
    )),
    serve(MEMORY.listConversations, ({ limit }) => recalled(() => deps().conversations.browse(limit ?? 10)).pipe(Effect.map((conversations) => ({ conversations })))),
  ];

  const { facts } = deps();

  if (facts === undefined) return served;

  return [
    serve(MEMORY.remember, async ({ key, value, confidence }) => {
      const stored = normalizeFactKey(key);

      facts.upsert(stored, value, { confidence });

      return { key: stored };
    }),
    serve(MEMORY.recall, async ({ key }) => {
      const fact = facts.recall(normalizeFactKey(key));

      return fact === null ? null : { key: fact.key, value: fact.value, confidence: fact.confidence, source: fact.source, lastObservedAt: fact.lastObservedAt };
    }),
    serve(MEMORY.forget, async ({ key }) => {
      const stored = normalizeFactKey(key);
      const existed = facts.recall(stored) !== null;

      facts.forget(stored);

      return { key: stored, existed };
    }),
    ...served,
  ];
}

type SearchHit = { readonly ref: string; readonly text: string; readonly score: number };

async function searchMemory({ memory, vectorStore, facts }: MemoryDeps, query: string): Promise<{ semantic: boolean; hits: SearchHit[] }> {
  if (vectorStore?.available === true) {
    const lexical = async (q: string, k: number): Promise<LexicalHit[]> => (await memory.search(q, k)).map((r) => ({
      // The vector store's chunk id, so RRF fuses both.
      id: `${r.path}:${r.startLine}-${r.endLine}`, path: r.path, startLine: r.startLine, endLine: r.endLine, score: r.score, snippet: r.snippet,
    }));

    const hits = await hybridSearch(query, lexical, vectorStore, { finalK: 10, rehydrate: memorySnippetRehydrator(memory), facts });

    return { semantic: true, hits: hits.map((h) => ({ ref: h.label ?? `${h.path}:${h.startLine}-${h.endLine}`, text: h.snippet, score: h.rrfScore })) };
  }

  const notes = await memory.search(query, 10);
  const noteHit = (r: MemorySearchResult): SearchHit => ({ ref: `${r.path}:${r.startLine}-${r.endLine}`, text: r.snippet, score: r.score });

  if (facts === undefined) return { semantic: false, hits: notes.map(noteHit) };

  // Facts fuse through the same RRF as the hybrid path.
  const merged = reciprocalRankFusion<(MemorySearchResult & { id: string; kind: 'note' }) | (FactSearchHit & { kind: 'fact' })>([
    notes.map((r) => ({ ...r, id: `${r.path}:${r.startLine}-${r.endLine}`, kind: 'note' as const })),
    searchFacts(facts, query, 10).map((f) => ({ ...f, kind: 'fact' as const })),
  ]).slice(0, 10);

  return {
    semantic: false,
    hits: merged.map((m) => {
      const hit = m.sources[0];

      return hit.kind === 'note' ? noteHit(hit) : { ref: `fact: ${hit.key}`, text: hit.snippet, score: m.rrfScore };
    }),
  };
}

/** A recall store that fails is named as unavailable, with its own words. */
function recalled<A>(run: () => Promise<A>): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const failure = toKinuError({ doing: 'conversation search unavailable', cause, otherwise: 'unavailable' });

      failure.message = renderThrownChain({ cause: failure });

      return failure;
    },
  });
}

/** `memory.*` for programs and slates: the operations the native `memory` tool serves. */
export function createMemoryCodemodeProvider(deps: () => MemoryDeps): CodemodeProvider {
  return codemodeNamespace('memory', 'What you remember across conversations: notes, facts, and the conversations themselves.', serveMemory(deps));
}

/** The memory operations served over an agent's stores, natively and as `memory.*`. */
import { Effect } from 'effect';
import type { Memory } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { VectorStore } from '../memory/vector-store';
import { createNoopVectorStore } from '../memory/vector-store';
import { appendMemoryNote } from '../memory/note';
import { normalizeFactKey, type Fact, type FactsStore, type MemoryScope } from '../memory/facts';
import type { AccountMemory } from '../memory/account';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search';
import type { ConversationRecall } from '../memory/conversation-search';
import { KinuError, renderThrownChain, toKinuError } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import type { CodemodeProvider } from '../types/codemode';
import { MEMORY, MEMORY_WITH_ACCOUNT } from '../operations/memory';

export interface MemoryDeps {
  readonly memory: Memory;
  /** null: no semantic index; search says so. */
  readonly vectorStore?: VectorStore | null;
  /** remember, recall and forget are served only when set. */
  readonly facts?: FactsStore;
  readonly actor: ActorHandle;
  /** Bound to this actor, so recall reads only its rows. */
  readonly conversations: ConversationRecall;
  /**
   * The account's memory: reads join both scopes, and a write may ask for the account. Absent, no call names a scope.
   * Cloudflare only: the CLI has no account's user object to hold it, so it leaves this unset
   * (`scripts/capability-parity.lock.json`).
   */
  readonly account?: AccountMemory;
}

/**
 * Read per call, so a rebound store applies; the facts and account gates are read once, as neither changes in a session.
 * Where the account is wired, `MEMORY_WITH_ACCOUNT` is served: reads answer from both scopes and say which.
 */
export function serveMemory(deps: () => MemoryDeps): readonly Served[] {
  const { facts, account } = deps();

  if (facts !== undefined && account !== undefined) return [...servedFacts(deps, facts, account), ...servedRecall(deps)];

  const served = [
    serve(MEMORY.note, async ({ content }) => {
      const { memory, actor } = deps();

      await appendMemoryNote(memory, content, { by: actor.name });

      return { saved: true as const };
    }),
    serve(MEMORY.search, async ({ query }) => unlabelled(await searchMemory(deps(), query))),
    ...servedRecall(deps),
  ];

  if (facts === undefined) return served;

  return [
    serve(MEMORY.remember, async ({ key, value, confidence }) => {
      const stored = normalizeFactKey(key);

      facts.upsert(stored, value, { confidence, origin: { by: 'agent', agent: deps().actor.name } });

      return { key: stored };
    }),
    serve(MEMORY.recall, async ({ key }) => {
      const fact = facts.recall(normalizeFactKey(key));

      return fact === null ? null : factAnswer(fact);
    }),
    serve(MEMORY.forget, async ({ key }) => forgotten(facts, key, deps().actor.name)),
    ...served,
  ];
}

/** The conversation reads, the same in every wiring. */
function servedRecall(deps: () => MemoryDeps): Served[] {
  return [
    serve(MEMORY.searchConversations, ({ query, limit }) => recalled(() => deps().conversations.search(query, limit ?? 5)).pipe(Effect.map((hits) => ({ hits })))),
    serve(MEMORY.readConversation, ({ messageId, window, maxChars }) => recalled(() => deps().conversations.scroll(messageId, window ?? 5, maxChars)).pipe(
      Effect.flatMap((view) => (view === null ? Effect.fail(new KinuError('missing', `no message with id ${messageId}`)) : Effect.succeed(view))),
    )),
    serve(MEMORY.listConversations, ({ limit }) => recalled(() => deps().conversations.browse(limit ?? 10)).pipe(Effect.map((conversations) => ({ conversations })))),
  ];
}

/** Facts and notes where the account is wired: an account write is a proposal, and a read says which scope answered. */
function servedFacts(deps: () => MemoryDeps, facts: FactsStore, account: AccountMemory): Served[] {
  return [
    serve(MEMORY_WITH_ACCOUNT.remember, async ({ key, value, confidence, scope }) => {
      const stored = normalizeFactKey(key);

      if (scope === 'account') return { key: stored, pending: true as const, proposal: await account.propose({ kind: 'fact', key: stored, value }) };
      facts.upsert(stored, value, { confidence, origin: { by: 'agent', agent: deps().actor.name } });

      return { key: stored };
    }),
    serve(MEMORY_WITH_ACCOUNT.recall, async ({ key }) => {
      const stored = normalizeFactKey(key);
      const own = facts.recall(stored);

      if (own !== null) return { ...factAnswer(own), scope: 'workspace' as const };
      const shared = (await account.facts()).find((fact) => fact.key === stored);

      return shared === undefined ? null : { ...factAnswer(shared), scope: 'account' as const };
    }),
    serve(MEMORY_WITH_ACCOUNT.forget, async ({ key }) => forgotten(facts, key, deps().actor.name)),
    serve(MEMORY_WITH_ACCOUNT.note, async ({ content, scope }) => {
      if (scope === 'account') return { pending: true as const, proposal: await account.propose({ kind: 'note', content }) };
      const { memory, actor } = deps();

      await appendMemoryNote(memory, content, { by: actor.name });

      return { saved: true as const };
    }),
    serve(MEMORY_WITH_ACCOUNT.search, async ({ query }) => await searchMemory(deps(), query)),
  ];
}

function factAnswer(fact: Fact) {
  return { key: fact.key, value: fact.value, confidence: fact.confidence, source: fact.source, lastObservedAt: fact.lastObservedAt };
}

function forgotten(facts: FactsStore, key: string, agent: string) {
  const stored = normalizeFactKey(key);
  const existed = facts.recall(stored) !== null;

  facts.forget(stored, { by: 'agent', agent });

  return { key: stored, existed };
}

type SearchHit = { readonly ref: string; readonly text: string; readonly score: number; readonly scope: MemoryScope };

/** A search where no account is wired names no scope: its schema has none. */
function unlabelled(found: { semantic: boolean; hits: SearchHit[] }) {
  return { semantic: found.semantic, hits: found.hits.map(({ ref, text, score }) => ({ ref, text, score })) };
}

/**
 * Both scopes as one ranked list (`unifiedFacts`): an account fact whose key this workspace holds is not a hit. The
 * account is read inside its arm, so a user object that does not answer costs the account's hits, never the search.
 */
async function searchMemory({ memory, vectorStore, facts, account }: MemoryDeps, query: string): Promise<{ semantic: boolean; hits: SearchHit[] }> {

  const accountNotes = account === undefined ? undefined : async (q: string, limit: number) => await account.searchNotes(q, limit);

  // Without a semantic index, the vector arm is skipped and the rest fuse alike.
  const index = vectorStore?.available === true ? vectorStore : createNoopVectorStore();

  const lexical = async (q: string, k: number): Promise<LexicalHit[]> => (await memory.search(q, k)).map((r) => ({
    // The vector store's chunk id, so RRF fuses both.
    id: `${r.path}:${r.startLine}-${r.endLine}`, path: r.path, startLine: r.startLine, endLine: r.endLine, score: r.score, snippet: r.snippet,
  }));

  const hits = await hybridSearch(query, lexical, index, {
    finalK: 10, rehydrate: memorySnippetRehydrator(memory),
    ...(facts !== undefined && { facts: () => facts.all() }),
    ...(account !== undefined && { accountFacts: async () => await account.facts() }),
    ...(accountNotes !== undefined && { accountNotes }),
  });

  return { semantic: index.available, hits: hits.map((h) => ({ ref: h.label ?? `${h.path}:${h.startLine}-${h.endLine}`, text: h.snippet, score: h.rrfScore, scope: h.scope })) };
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

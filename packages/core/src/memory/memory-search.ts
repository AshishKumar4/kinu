/** A memory search as every caller asks it: one composition over `hybridSearch`, its reach beyond notes explicit. */

import type { Memory } from '../types/primitives';
import { createNoopVectorStore, type VectorStore } from './vector-store';
import type { FactsStore } from './facts';
import type { AccountMemory } from './account';
import { hybridSearch, memorySnippetRehydrator, type HybridHit, type LexicalSearchFn } from './hybrid-search';

/** What a memory search reaches beyond the workspace's notes: its facts, and the account's facts, and its notes where
 *  it names them. Absent, not. */
export interface MemorySearchScope {
  readonly facts?: FactsStore;
  readonly account?: Pick<AccountMemory, 'facts'> & Partial<Pick<AccountMemory, 'searchNotes'>>;
}

/**
 * One memory search, ranked once: the workspace's notes by lexical and semantic match, and what `scope` adds; `limit`
 * hits. `semantic` says whether a semantic index answered. Each caller projects these hits into its own shape.
 */
export async function searchMemoryHits(
  memory: Pick<Memory, 'search' | 'chunk'>, vectorStore: VectorStore | null | undefined, query: string, opts: MemorySearchScope & { readonly limit: number },
): Promise<{ readonly semantic: boolean; readonly hits: HybridHit[] }> {
  const { facts, account } = opts;
  const index = vectorStore ?? createNoopVectorStore();

  const lexical: LexicalSearchFn = async (q, k) => (await memory.search(q, k)).map((r) => ({
    // The vector store's chunk id, so RRF fuses both.
    id: `${r.path}:${r.startLine}-${r.endLine}`, path: r.path, startLine: r.startLine, endLine: r.endLine, score: r.score, snippet: r.snippet,
  }));

  const hits = await hybridSearch(query, lexical, index, {
    finalK: opts.limit, rehydrate: memorySnippetRehydrator(memory),
    ...(facts !== undefined && { facts: () => facts.all() }),
    // The account is read inside its arms, so a user object that does not answer costs the account's hits, never the search.
    ...(account !== undefined && { accountFacts: async () => await account.facts() }),
    ...(account?.searchNotes !== undefined && { accountNotes: async (q: string, k: number) => await account.searchNotes?.(q, k) ?? [] }),
  });

  return { semantic: index.available, hits };
}

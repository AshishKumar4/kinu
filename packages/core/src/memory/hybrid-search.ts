/**
 * Hybrid retrieval — combines FTS5 (lexical) with VectorStore (semantic)
 * via Reciprocal Rank Fusion.
 *
 * Use cases where this beats pure-FTS5:
 *   • Paraphrase queries ("how do I cancel" vs stored "abort the call")
 *   • Concept queries ("error handling" finds chunks about try/catch + retries)
 *   • Multi-language or synonym recall
 *
 * Use cases where pure-FTS5 wins (and the FTS5 list dominates RRF):
 *   • Exact-string lookups (identifiers, file paths)
 *   • Very short queries
 *
 * The RRF merge surfaces the best of both regardless.
 */

import type { VectorStore, VectorSearchHit } from './vector-store.js';
import { reciprocalRankFusion } from './vector-store.js';

export interface LexicalHit {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** FTS5 BM25 score (or similar) — relative. */
  readonly score: number;
  /** The chunk text. */
  readonly snippet: string;
}

export interface HybridHit {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  /** RRF-merged score (sum of 1/(k+rank) across sources that surfaced it). */
  readonly rrfScore: number;
  /** Where this hit came from. */
  readonly sources: ReadonlyArray<'lexical' | 'semantic'>;
  /** Underlying lexical score, if it came from FTS5. */
  readonly lexicalScore?: number;
  /** Underlying semantic similarity, if it came from Vectorize. */
  readonly semanticScore?: number;
}

/**
 * Function the caller passes to do the lexical (FTS5) search. Returns a
 * ranked list of hits.
 */
export type LexicalSearchFn = (query: string, limit: number) => Promise<LexicalHit[]>;

export interface HybridSearchOptions {
  /** Per-source candidate count. We take topK from each, then merge. Default 20. */
  perSourceK?: number;
  /** Final hits returned. Default 10. */
  finalK?: number;
  /** RRF constant. Default 60 (Cormack/Lynam). */
  rrfK?: number;
}

/**
 * Hybrid search — runs lexical + semantic in parallel, merges via RRF,
 * returns the top-finalK enriched hits.
 *
 * If the vector store is unavailable, this transparently degrades to
 * lexical-only — the caller doesn't need to feature-detect.
 */
export async function hybridSearch(
  query: string,
  lexicalSearch: LexicalSearchFn,
  vectorStore: VectorStore,
  options: HybridSearchOptions = {},
): Promise<HybridHit[]> {
  const perSourceK = options.perSourceK ?? 20;
  const finalK = options.finalK ?? 10;
  const rrfK = options.rrfK ?? 60;

  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query, perSourceK).catch((err) => {
      console.warn('[hybrid-search] lexical search failed:', err instanceof Error ? err.message : err);
      return [] as LexicalHit[];
    }),
    vectorStore.available
      ? vectorStore.search(query, perSourceK).catch((err) => {
          console.warn('[hybrid-search] semantic search failed:', err instanceof Error ? err.message : err);
          return [] as VectorSearchHit[];
        })
      : Promise.resolve([] as VectorSearchHit[]),
  ]);

  // RRF accepts any { id } shape; we feed both lists.
  const merged = reciprocalRankFusion<{ id: string }>([lexical, semantic], rrfK);

  // Re-enrich with metadata (prefer lexical snippet/text; carry semantic score if present).
  const byIdLex = new Map(lexical.map((h) => [h.id, h]));
  const byIdSem = new Map(semantic.map((h) => [h.id, h]));

  const enriched: HybridHit[] = [];
  for (const m of merged) {
    const l = byIdLex.get(m.id);
    const s = byIdSem.get(m.id);
    const sources: Array<'lexical' | 'semantic'> = [];
    if (l) sources.push('lexical');
    if (s) sources.push('semantic');
    enriched.push({
      id: m.id,
      path: l?.path ?? s?.path ?? '',
      startLine: l?.startLine ?? s?.startLine ?? 0,
      endLine: l?.endLine ?? s?.endLine ?? 0,
      snippet: l?.snippet ?? '',
      rrfScore: m.rrfScore,
      sources,
      lexicalScore: l?.score,
      semanticScore: s?.score,
    });
    if (enriched.length >= finalK) break;
  }
  return enriched;
}

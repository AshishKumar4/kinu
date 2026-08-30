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

import type { Memory } from '../types/primitives';
import type { VectorStore, VectorSearchHit } from './vector-store';
import { reciprocalRankFusion } from './vector-store';
import { diagnostics, toKinuError, type KinuError } from '../obs/index';

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

/**
 * Reads back the text of a hit only the semantic index surfaced. The vector
 * store deliberately stores no chunk text (metadata cost), so without this a
 * semantic-only hit — exactly what semantic search exists to find — renders
 * with an empty snippet and is useless to the agent and the user.
 *
 * Returns null when the text can no longer be read.
 */
export type SnippetRehydrator = (hit: VectorSearchHit) => Promise<string | null>;

/**
 * The standard rehydrator: a memory chunk's `path` + line range IS its address
 * in the file plane, so the text is read straight back from the source file.
 * Reads are memoized per rehydrator, so a page of hits into one file costs one
 * read.
 */
export function memorySnippetRehydrator(memory: Pick<Memory, 'read'>): SnippetRehydrator {
  const reads = new Map<string, Promise<string | null>>();
  return async (hit) => {
    if (!hit.path) return null;
    let content = reads.get(hit.path);
    if (!content) {
      content = memory.read(hit.path);
      reads.set(hit.path, content);
    }
    const text = await content;
    if (text === null) return null;
    // 1-based, inclusive — the line convention memory chunk ids are minted with.
    return text.split('\n').slice(Math.max(0, hit.startLine - 1), hit.endLine).join('\n');
  };
}

export interface HybridSearchOptions {
  /** Per-source candidate count. We take topK from each, then merge. Default 20. */
  perSourceK?: number;
  /** Final hits returned. Default 10. */
  finalK?: number;
  /** RRF constant. Default 60 (Cormack/Lynam). */
  rrfK?: number;
  /** Fills in the snippet for a hit that has no text of its own. Omit only
   *  where the caller has no memory to read back from — semantic-only hits then
   *  carry the score but no text. */
  rehydrate?: SnippetRehydrator;
}

/**
 * What one retrieval arm came back with, held as a value instead of being
 * settled inside the handler that produced it. The decision a failed arm forces
 * — degrade to the other source, or admit the search never ran — depends on what
 * the OTHER arm did, and a `catch` can only see its own.
 */
type ArmOutcome<Hit> =
  | { readonly kind: 'answered'; readonly hits: readonly Hit[] }
  | { readonly kind: 'failed'; readonly error: KinuError };

/**
 * The semantic arm has a third outcome the lexical one does not: no store to
 * ask. `skipped` is deliberately not `answered` with nothing — a vector index
 * that was never consulted has said nothing about whether the corpus holds a
 * match, and folding the two together is exactly how "FTS5 is down, and there
 * was no semantic index to cover for it" reaches a caller spelled "no results".
 */
type SemanticOutcome = ArmOutcome<VectorSearchHit> | { readonly kind: 'skipped' };

/**
 * Hybrid search — runs lexical + semantic in parallel, merges via RRF,
 * returns the top-finalK enriched hits.
 *
 * If the vector store is unavailable, this transparently degrades to
 * lexical-only — the caller doesn't need to feature-detect.
 *
 * ONE arm failing degrades to the other and is recorded rather than raised:
 * covering for a dead source is the whole reason two of them run. Losing every
 * arm raises, because the return type cannot say "the search did not happen" —
 * an empty array here reads as an empty CORPUS, and answering "no matches" for
 * a query that was never executed is the one failure this must not fake.
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

  const lexicalArm = (async (): Promise<ArmOutcome<LexicalHit>> => {
    try {
      return { kind: 'answered', hits: await lexicalSearch(query, perSourceK) };
    } catch (cause) {
      return {
        kind: 'failed',
        error: toKinuError({
          doing: 'run the lexical half of a hybrid search', cause, otherwise: 'io',
        }),
      };
    }
  })();
  const semanticArm: Promise<SemanticOutcome> = vectorStore.available
    ? (async (): Promise<SemanticOutcome> => {
        try {
          return { kind: 'answered', hits: await vectorStore.search(query, perSourceK) };
        } catch (cause) {
          return {
            kind: 'failed',
            error: toKinuError({
              doing: 'run the semantic half of a hybrid search', cause, otherwise: 'unavailable',
            }),
          };
        }
      })()
    : Promise.resolve({ kind: 'skipped' });
  // Both arms are already in flight; awaiting them together keeps a slow source
  // off the other's critical path, exactly as before.
  const [lexical, semantic] = await Promise.all([lexicalArm, semanticArm]);

  // The fallback decision, taken once with both outcomes in hand — the view no
  // handler had. A survivor makes the other arm's failure a degradation worth
  // recording; no survivor makes it the answer.
  if (lexical.kind === 'answered' || semantic.kind === 'answered') {
    if (lexical.kind === 'failed') {
      diagnostics.failure('memory.lexical_search_failed', lexical.error);
    }
    if (semantic.kind === 'failed') {
      diagnostics.failure('memory.semantic_search_failed', semantic.error);
    }
  } else if (semantic.kind === 'failed') {
    // Two chains, and neither is the one that may be dropped: which index broke
    // first is the whole diagnosis when a retrieval tier goes dark at once.
    throw new AggregateError(
      [lexical.error, semantic.error],
      'hybrid search failed: neither the lexical nor the semantic index answered',
      { cause: lexical.error },
    );
  } else {
    // Semantic was never available to cover for it, so the lexical failure IS
    // the result. It is already classified and chained; it travels as it is.
    throw lexical.error;
  }

  // Only now, past the classification, does a lost arm become no candidates.
  const lexicalHits: readonly LexicalHit[] = lexical.kind === 'answered' ? lexical.hits : [];
  const semanticHits: readonly VectorSearchHit[] = semantic.kind === 'answered'
    ? semantic.hits
    : [];

  // RRF accepts any { id } shape; we feed both lists.
  const merged = reciprocalRankFusion<{ id: string }>([lexicalHits, semanticHits], rrfK);

  // Re-enrich with metadata (prefer lexical snippet/text; carry semantic score if present).
  const byIdLex = new Map(lexicalHits.map((h) => [h.id, h]));
  const byIdSem = new Map(semanticHits.map((h) => [h.id, h]));

  return Promise.all(merged.slice(0, finalK).map(async (m): Promise<HybridHit> => {
    const l = byIdLex.get(m.id);
    const s = byIdSem.get(m.id);
    const sources: Array<'lexical' | 'semantic'> = [];
    if (l) sources.push('lexical');
    if (s) sources.push('semantic');
    // A semantic-only hit has no lexical snippet to borrow: read its text back
    // from the chunk's own address, or it arrives blank and unusable.
    let snippet = l?.snippet ?? s?.text ?? '';
    if (!snippet && s && options.rehydrate) snippet = await options.rehydrate(s) ?? '';
    return {
      id: m.id,
      path: l?.path ?? s?.path ?? '',
      startLine: l?.startLine ?? s?.startLine ?? 0,
      endLine: l?.endLine ?? s?.endLine ?? 0,
      snippet,
      rrfScore: m.rrfScore,
      sources,
      lexicalScore: l?.score,
      semanticScore: s?.score,
    };
  }));
}

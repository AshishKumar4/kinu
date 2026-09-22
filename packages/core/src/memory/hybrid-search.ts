/** Hybrid retrieval: lexical arms (FTS5 notes, FactsStore) and VectorStore fused with Reciprocal Rank Fusion. */

import type { Memory } from '../types/primitives';
import type { VectorStore, VectorSearchHit } from './vector-store';
import { reciprocalRankFusion } from './vector-store';
import { searchFacts, type FactSearchHit, type FactsStore } from './facts';
import { diagnostics, toKinuError, type KinuError } from '../obs/index';


export interface LexicalHit {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly snippet: string;
}

export interface HybridHit {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  readonly rrfScore: number;
  readonly sources: ReadonlyArray<'lexical' | 'semantic' | 'fact'>;
  /** Display override for `path:start-end`; fact hits set `fact: <key>`. */
  readonly label?: string;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
}

export type LexicalSearchFn = (query: string, limit: number) => Promise<LexicalHit[]>;

/** The vector store holds no chunk text, so semantic-only hits need their text read back. Null when unreadable. */
export type SnippetRehydrator = (hit: VectorSearchHit) => Promise<string | null>;

/** Reads are memoized per rehydrator: one read per file per page of hits. */
export function memorySnippetRehydrator(memory: Pick<Memory, 'read'>): SnippetRehydrator {
  const reads = new Map<string, Promise<string | null>>();

  return async (hit) => {
    if (!hit.path) return null;
    let content = reads.get(hit.path);

    if (!content) {
      content = memory.read(hit.path);
      reads.set(hit.path, content);
    }

    let text: string | null;

    try {
      text = await content;
    } catch (cause) {
      if (reads.get(hit.path) === content) reads.delete(hit.path);
      throw cause;
    }

    if (text === null) return null;

    // 1-based, inclusive — the line convention memory chunk ids are minted with.
    return text.split('\n').slice(Math.max(0, hit.startLine - 1), hit.endLine).join('\n');
  };
}

export interface HybridSearchOptions {
  /** Per-source candidate count. Default 20. */
  perSourceK?: number;
  /** Final hits returned. Default 10. */
  finalK?: number;
  /** RRF constant. Default 60 (Cormack/Lynam). */
  rrfK?: number;
  /** Facts join the merge as a second lexical source, rendered `[fact: <key>]`. */
  facts?: FactsStore;
  rehydrate?: SnippetRehydrator;
}

/** Arm outcomes are values: whether a failure degrades or is the answer depends on the other arms. */
type ArmOutcome<Hit> =
  | { readonly kind: 'answered'; readonly hits: readonly Hit[] }
  | { readonly kind: 'failed'; readonly error: KinuError };

/** `skipped` is not `answered` with nothing: an unconsulted index says nothing about matches. */
type SemanticOutcome = ArmOutcome<VectorSearchHit> | { readonly kind: 'skipped' };

type FactsOutcome = ArmOutcome<FactSearchHit> | { readonly kind: 'skipped' };

/**
 * Runs every wired source in parallel and merges via RRF. One failed arm degrades and is recorded;
 * losing every arm raises, since an empty array would read as an empty corpus.
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
  const factsStore = options.facts;

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

  const factsArm: Promise<FactsOutcome> = factsStore
    ? (async (): Promise<FactsOutcome> => {
        try {
          return { kind: 'answered', hits: searchFacts(factsStore, query, perSourceK) };
        } catch (cause) {
          return {
            kind: 'failed',
            error: toKinuError({
              doing: 'run the facts half of a hybrid search', cause, otherwise: 'io',
            }),
          };
        }
      })()
    : Promise.resolve({ kind: 'skipped' });

  const [lexical, semantic, factArm] = await Promise.all([lexicalArm, semanticArm, factsArm]);

  const answered = [lexical, semantic, factArm].some((arm) => arm.kind === 'answered');

  if (answered) {
    if (lexical.kind === 'failed') {
      diagnostics.failure('memory.lexical_search_failed', lexical.error);
    }

    if (semantic.kind === 'failed') {
      diagnostics.failure('memory.semantic_search_failed', semantic.error);
    }

    if (factArm.kind === 'failed') {
      diagnostics.failure('memory.fact_search_failed', factArm.error);
    }
  } else {
    const failures = [lexical, semantic, factArm].flatMap((arm) =>
      arm.kind === 'failed' ? [arm.error] : []);

    if (failures.length === 1) {
      throw failures[0];
    }

    throw new AggregateError(
      failures,
      'hybrid search failed: no retrieval source answered',
      { cause: failures[0] },
    );
  }

  const lexicalHits: readonly LexicalHit[] = lexical.kind === 'answered' ? lexical.hits : [];

  const factHits: readonly FactSearchHit[] = factArm.kind === 'answered' ? factArm.hits : [];

  const semanticHits: readonly VectorSearchHit[] = semantic.kind === 'answered'
    ? semantic.hits
    : [];

  // `fact:` ids never collide with note chunk ids.
  const merged = reciprocalRankFusion<{ id: string }>([lexicalHits, factHits, semanticHits], rrfK);

  const byIdLex = new Map(lexicalHits.map((h) => [h.id, h]));
  const byIdFact = new Map(factHits.map((h) => [h.id, h]));
  const byIdSem = new Map(semanticHits.map((h) => [h.id, h]));

  return Promise.all(merged.slice(0, finalK).map(async (m): Promise<HybridHit> => {
    const l = byIdLex.get(m.id);
    const f = byIdFact.get(m.id);
    const s = byIdSem.get(m.id);
    const sources: Array<'lexical' | 'semantic' | 'fact'> = [];

    if (l) sources.push('lexical');

    if (f) sources.push('fact');

    if (s) sources.push('semantic');
    // Fact hits carry their value, so only semantic-only note hits need rehydrating.
    let snippet = l?.snippet ?? f?.snippet ?? s?.text ?? '';

    if (!snippet && s && options.rehydrate) {
      try {
        snippet = await options.rehydrate(s) ?? '';
      } catch (cause) {
        diagnostics.failure(
          'memory.snippet_rehydrate_failed',
          toKinuError({ doing: 'rehydrate a semantic hit snippet', cause, otherwise: 'io' }),
          { id: m.id },
        );
        snippet = '';
      }
    }

    return {
      id: m.id,
      path: l?.path ?? s?.path ?? '',
      startLine: l?.startLine ?? s?.startLine ?? 0,
      endLine: l?.endLine ?? s?.endLine ?? 0,
      snippet,
      rrfScore: m.rrfScore,
      sources,
      label: f ? `fact: ${f.key}` : undefined,
      lexicalScore: l?.score,
      semanticScore: s?.score,
    };
  }));
}

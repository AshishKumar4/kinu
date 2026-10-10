/** Hybrid retrieval: lexical arms (FTS5 notes, both scopes' facts, account notes) and VectorStore fused with Reciprocal Rank Fusion. */

import { Effect } from 'effect';
import type { Memory } from '../types/primitives';
import type { VectorStore, VectorSearchHit } from './vector-store';
import { reciprocalRankFusion } from './vector-store';
import { searchFacts, unifiedFacts, type Fact, type FactSearchHit, type MemoryScope } from './facts';
import type { AccountNoteHit } from './account';
import { attempt, diagnostics, settle, toKinuError, type ErrorCode, type KinuError } from '../obs/index';

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
  readonly sources: ReadonlyArray<'lexical' | 'semantic' | 'fact' | 'account-note'>;
  /** Display override for `path:start-end`: `fact: <key>`, `account fact: <key>` or `account note: <id>`. */
  readonly label?: string;
  readonly scope: MemoryScope;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
}

export type LexicalSearchFn = (query: string, limit: number) => Promise<LexicalHit[]>;

/** The vector store holds no chunk text, so semantic-only hits need their text read back. Null when unreadable. */
export type SnippetRehydrator = (hit: VectorSearchHit) => Promise<string | null>;

/** Remote candidates must still identify the canonical chunk and content. */
export function memorySnippetRehydrator(memory: Pick<Memory, 'chunk'>): SnippetRehydrator {
  return async (hit) => {
    const chunk = await memory.chunk(hit.id);

    if (chunk === null || hit.hash === undefined || chunk.hash !== hit.hash
      || chunk.path !== hit.path || chunk.startLine !== hit.startLine || chunk.endLine !== hit.endLine) return null;

    return chunk.text;
  };
}

export interface HybridSearchOptions {
  /** Per-source candidate count. Default 20. */
  perSourceK?: number;
  /** Final hits returned. Default 10. */
  finalK?: number;
  /** RRF constant. Default 60 (Cormack/Lynam). */
  rrfK?: number;
  /** This workspace's facts, a second lexical source rendered `fact: <key>`, read inside its arm so a failed read
   *  degrades the arm, never the search. */
  facts?: () => readonly Fact[];
  /** The account's facts, joined below the workspace's in the same arm (`unifiedFacts`) and rendered `account fact: <key>`.
   *  A failed read costs only them: the workspace's facts are still searched. */
  accountFacts?: () => Promise<readonly Fact[]>;
  /** The account's notes the query matches, a fourth source that degrades as the others do. */
  accountNotes?: (query: string, limit: number) => Promise<readonly AccountNoteHit[]>;
  rehydrate?: SnippetRehydrator;
}

/** Arm outcomes are values: whether a failure degrades or is the answer depends on the other arms. */
type ArmOutcome<Hit> =
  | { readonly kind: 'answered'; readonly hits: readonly Hit[] }
  | { readonly kind: 'failed'; readonly error: KinuError };

/** `skipped` is not `answered` with nothing: an unconsulted index says nothing about matches. */
type SemanticOutcome = ArmOutcome<VectorSearchHit> | { readonly kind: 'skipped' };

type FactsOutcome = ArmOutcome<FactSearchHit> | { readonly kind: 'skipped' };

type NotesOutcome = ArmOutcome<AccountNoteHit> | { readonly kind: 'skipped' };

/**
 * Runs every wired source in parallel and merges via RRF. One failed arm degrades and is recorded;
 * losing every arm raises, since an empty array would read as an empty corpus.
 */
export function hybridSearch(
  query: string,
  lexicalSearch: LexicalSearchFn,
  vectorStore: VectorStore,
  options: HybridSearchOptions = {},
): Promise<HybridHit[]> {
  const perSourceK = options.perSourceK ?? 20;
  const finalK = options.finalK ?? 10;
  const rrfK = options.rrfK ?? 60;
  const { facts: ownFacts, accountFacts } = options;

  const lexicalArm = armOf(() => lexicalSearch(query, perSourceK), 'run the lexical half of a hybrid search', 'io');

  const semanticArm: Effect.Effect<SemanticOutcome> = (vectorStore.available
    ? armOf(() => vectorStore.search(query, perSourceK), 'run the semantic half of a hybrid search', 'unavailable')
    : Effect.succeed<SemanticOutcome>({ kind: 'skipped' })).pipe(Effect.flatMap((outcome) => {
      const rehydrate = options.rehydrate;
  
      if (outcome.kind !== 'answered' || rehydrate === undefined) return Effect.succeed(outcome);
  
      return Effect.forEach(outcome.hits, (hit) => attempt(
        { doing: 'validate a semantic candidate against canonical memory', otherwise: 'io' }, () => rehydrate(hit),
      ).pipe(
        Effect.catch((error) => Effect.sync(() => {
          diagnostics.failure('memory.snippet_rehydrate_failed', error, { id: hit.id });
  
          return null;
        })),
        Effect.map((text) => text === null ? null : { ...hit, text }),
      )).pipe(Effect.map((hits): SemanticOutcome => ({ kind: 'answered', hits: hits.flatMap((hit) => hit === null ? [] : [hit]) })));
    }));

  const sharedFacts: Effect.Effect<readonly Fact[]> = accountFacts === undefined ? Effect.succeed([]) : attempt(
    { doing: "read the account's facts for a hybrid search", otherwise: 'unavailable' }, accountFacts,
  ).pipe(Effect.catch((error) => Effect.sync(() => {
    diagnostics.failure('memory.account_fact_search_failed', error);

    return [];
  })));

  const factsArm: Effect.Effect<FactsOutcome> = ownFacts === undefined && accountFacts === undefined
    ? Effect.succeed({ kind: 'skipped' })
    : Effect.flatMap(sharedFacts, (shared) => armOf(() => searchFacts(unifiedFacts(ownFacts?.() ?? [], shared), query, perSourceK), 'run the facts half of a hybrid search', 'io'));

  const notesSource = options.accountNotes;

  const notesArm: Effect.Effect<NotesOutcome> = notesSource
    ? armOf(() => notesSource(query, perSourceK), "search the account's notes", 'unavailable')
    : Effect.succeed({ kind: 'skipped' });

  return settle(Effect.gen(function* () {
    const [lexical, semantic, factArm, noteArm] = yield* Effect.all([lexicalArm, semanticArm, factsArm, notesArm], { concurrency: 'unbounded' });
    const answered = [lexical, semantic, factArm, noteArm].some((arm) => arm.kind === 'answered');

    if (answered) {
      if (lexical.kind === 'failed') diagnostics.failure('memory.lexical_search_failed', lexical.error);

      if (semantic.kind === 'failed') diagnostics.failure('memory.semantic_search_failed', semantic.error);

      if (factArm.kind === 'failed') diagnostics.failure('memory.fact_search_failed', factArm.error);

      if (noteArm.kind === 'failed') diagnostics.failure('memory.account_note_search_failed', noteArm.error);
    } else {
      const failures = [lexical, semantic, factArm, noteArm].flatMap((arm) => (arm.kind === 'failed' ? [arm.error] : []));
      const [only] = failures;

      if (failures.length === 1 && only !== undefined) return yield* only;

      return yield* Effect.die(new AggregateError(failures, 'hybrid search failed: no retrieval source answered', { cause: only }));
    }

    return yield* fused({ lexical, semantic, factArm, accountNotes: noteArm.kind === 'answered' ? noteArm.hits : [], finalK, rrfK });
  }));
}

interface FuseInput {
  readonly lexical: ArmOutcome<LexicalHit>;
  readonly semantic: SemanticOutcome;
  readonly factArm: FactsOutcome;
  readonly accountNotes: readonly AccountNoteHit[];
  readonly finalK: number;
  readonly rrfK: number;
}

function armOf<Hit>(
  run: () => Promise<readonly Hit[]> | readonly Hit[],
  doing: string,
  otherwise: ErrorCode,
): Effect.Effect<ArmOutcome<Hit>> {
  return Effect.tryPromise({ try: () => Promise.resolve(run()), catch: (cause) => toKinuError({ doing, cause, otherwise }) }).pipe(
    Effect.match({
      onSuccess: (hits): ArmOutcome<Hit> => ({ kind: 'answered', hits }),
      onFailure: (error): ArmOutcome<Hit> => ({ kind: 'failed', error }),
    }),
  );
}

function fused({ lexical, semantic, factArm, accountNotes, finalK, rrfK }: FuseInput): Effect.Effect<HybridHit[]> {
  const lexicalHits: readonly LexicalHit[] = lexical.kind === 'answered' ? lexical.hits : [];

  const factHits: readonly FactSearchHit[] = factArm.kind === 'answered' ? factArm.hits : [];

  const semanticHits: readonly VectorSearchHit[] = semantic.kind === 'answered'
    ? semantic.hits
    : [];

  const noteHits = accountNotes.map((note) => ({ ...note, id: `account-note:${note.id}` }));
  // `fact:`, `account-fact:` and `account-note:` ids never collide with note chunk ids.
  const merged = reciprocalRankFusion<{ id: string }>([lexicalHits, factHits, semanticHits, noteHits], rrfK);

  const byIdLex = new Map(lexicalHits.map((h) => [h.id, h]));
  const byIdFact = new Map(factHits.map((h) => [h.id, h]));
  const byIdSem = new Map(semanticHits.map((h) => [h.id, h]));
  const byIdNote = new Map(noteHits.map((h) => [h.id, h]));

  return Effect.sync(() => merged.slice(0, finalK).map((m) => {
    const l = byIdLex.get(m.id);
    const f = byIdFact.get(m.id);
    const s = byIdSem.get(m.id);
    const n = byIdNote.get(m.id);
    const sources = hitSources({ l, f, s, n });
    const snippet = l?.snippet ?? f?.snippet ?? n?.text ?? s?.text ?? '';

    const hit: HybridHit = {
      id: m.id,
      path: l?.path ?? s?.path ?? '',
      startLine: l?.startLine ?? s?.startLine ?? 0,
      endLine: l?.endLine ?? s?.endLine ?? 0,
      snippet,
      rrfScore: m.rrfScore,
      sources,
      ...hitScope(f, n),
      lexicalScore: l?.score,
      semanticScore: s?.score,
    };

    return hit;
  }));
}

type HitSource = HybridHit['sources'][number];

/** Which arms found a hit, in the order the merge reads them. */
function hitSources(found: { readonly l?: object; readonly f?: object; readonly s?: object; readonly n?: object }): HitSource[] {
  const arms: ReadonlyArray<readonly [object | undefined, HitSource]> = [[found.l, 'lexical'], [found.f, 'fact'], [found.s, 'semantic'], [found.n, 'account-note']];

  return arms.flatMap(([hit, source]) => (hit === undefined ? [] : [source]));
}

/** A fact or account note hit's label and scope; a note chunk's is the workspace's, labelled by its path. */
function hitScope(fact: FactSearchHit | undefined, note: AccountNoteHit | undefined): Pick<HybridHit, 'label' | 'scope'> {
  if (fact !== undefined) return { label: `${fact.scope === 'account' ? 'account fact' : 'fact'}: ${fact.key}`, scope: fact.scope };

  return note === undefined ? { scope: 'workspace' } : { label: `account note: ${note.id.slice('account-note:'.length)}`, scope: 'account' };
}

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
  /** When its note was last written, as indexed; undefined where nothing dates it. */
  readonly writtenAt?: number | undefined;
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
  /** A fact hit's key. */
  readonly factKey?: string;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
}

export type LexicalSearchFn = (query: string, limit: number) => Promise<LexicalHit[]>;

/** A semantic hit's canonical text and its note's write time, read back. */
interface RehydratedSnippet {
  readonly text: string;
  readonly writtenAt?: number;
}

/** The vector store holds no chunk text, so semantic-only hits need their text read back. Null when unreadable. */
export type SnippetRehydrator = (hit: VectorSearchHit) => Promise<RehydratedSnippet | null>;

/** Remote candidates must still identify the canonical chunk and content. */
export function memorySnippetRehydrator(memory: Pick<Memory, 'chunk'>): SnippetRehydrator {
  return async (hit) => {
    const chunk = await memory.chunk(hit.id);

    if (chunk === null || hit.hash === undefined || chunk.hash !== hit.hash
      || chunk.path !== hit.path || chunk.startLine !== hit.startLine || chunk.endLine !== hit.endLine) return null;

    return { text: chunk.text, ...(chunk.writtenAt !== undefined && { writtenAt: chunk.writtenAt }) };
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
  /** The clock ages are read against. */
  now?: number;
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
  
      return armOf(async () => {
        const hits = await Promise.all(outcome.hits.map(async (hit) => {
          const read = await rehydrate(hit);

          return read === null ? null : { ...hit, ...read };
        }));

        return hits.flatMap((hit) => hit === null ? [] : [hit]);
      }, 'validate semantic candidates against canonical memory', 'unavailable');
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

  // Each arm's wall time, reported once a search (#103: which of them a turn's recall waits on).
  const timing: Record<string, number> = {};
  const began = performance.now();

  const timed = <A>(arm: string, effect: Effect.Effect<A>): Effect.Effect<A> =>
    Effect.tap(effect, () => Effect.sync(() => { timing[`${arm}Ms`] = performance.now() - began; }));

  return settle(Effect.gen(function* () {
    const [lexical, semantic, factArm, noteArm] = yield* Effect.all([
      timed('lexical', lexicalArm), timed('semantic', semanticArm), timed('facts', factsArm), timed('notes', notesArm),
    ], { concurrency: 'unbounded' });

    diagnostics.event('memory.search_timing', { ...timing, semantic: semantic.kind, totalMs: performance.now() - began });
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

    return yield* fused({ lexical, semantic, factArm, accountNotes: noteArm.kind === 'answered' ? noteArm.hits : [], finalK, rrfK, now: options.now ?? Date.now() });
  }));
}

interface FuseInput {
  readonly lexical: ArmOutcome<LexicalHit>;
  readonly semantic: SemanticOutcome;
  readonly factArm: FactsOutcome;
  readonly accountNotes: readonly AccountNoteHit[];
  readonly finalK: number;
  readonly rrfK: number;
  readonly now: number;
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

function fused({ lexical, semantic, factArm, accountNotes, finalK, rrfK, now }: FuseInput): Effect.Effect<HybridHit[]> {
  const lexicalHits: readonly LexicalHit[] = lexical.kind === 'answered' ? lexical.hits : [];

  const factHits: readonly FactSearchHit[] = factArm.kind === 'answered' ? factArm.hits : [];

  const semanticHits: readonly (VectorSearchHit & { readonly writtenAt?: number })[] = semantic.kind === 'answered'
    ? semantic.hits
    : [];

  const noteHits = accountNotes.map((note) => ({ ...note, id: `account-note:${note.id}` }));
  // `fact:`, `account-fact:` and `account-note:` ids never collide with note chunk ids.
  const merged = reciprocalRankFusion<{ id: string }>([lexicalHits, factHits, semanticHits, noteHits], rrfK);

  const byIdLex = new Map(lexicalHits.map((h) => [h.id, h]));
  const byIdFact = new Map(factHits.map((h) => [h.id, h]));
  const byIdSem = new Map(semanticHits.map((h) => [h.id, h]));
  const byIdNote = new Map(noteHits.map((h) => [h.id, h]));

  return Effect.sync(() => {
    const candidates = merged.map((m) => fusedHit(m, { l: byIdLex.get(m.id), f: byIdFact.get(m.id), s: byIdSem.get(m.id), n: byIdNote.get(m.id) }, now));

    return diverse(candidates.sort((a, b) => b.rrfScore - a.rrfScore), finalK);
  });
}

/** What each arm found of one fused id. */
interface Found {
  readonly l: LexicalHit | undefined;
  readonly f: FactSearchHit | undefined;
  readonly s: (VectorSearchHit & { readonly writtenAt?: number }) | undefined;
  readonly n: AccountNoteHit | undefined;
}

function fusedHit(m: { readonly id: string; readonly rrfScore: number }, found: Found, now: number): HybridHit {
  const { l, f, s, n } = found;

  const hit: HybridHit = {
    id: m.id,
    path: l?.path ?? s?.path ?? '',
    startLine: l?.startLine ?? s?.startLine ?? 0,
    endLine: l?.endLine ?? s?.endLine ?? 0,
    snippet: l?.snippet ?? f?.snippet ?? n?.text ?? s?.text ?? '',
    rrfScore: m.rrfScore * kept(found, now),
    sources: hitSources(found),
    ...hitScope(f, n),
    ...(f !== undefined && { factKey: f.key }),
    lexicalScore: l?.score,
    semanticScore: s?.score,
  };

  return hit;
}

/** The share of its fused rank a memory keeps: at least 70%, down to it as it ages (mnemopi `core/beam/recall.ts`). */
function kept({ l, f, s, n }: Found, now: number): number {
  const writtenAt = f?.lastObservedAt ?? n?.at ?? l?.writtenAt ?? s?.writtenAt;

  return 0.7 + 0.3 * survival(memoryKind(f, n), writtenAt === undefined ? null : now - writtenAt);
}

/** What a recalled memory is, which decides how fast it ages. */
type MemoryKind = 'note' | 'fact' | 'account-fact' | 'account-note';

/** Weibull shape and scale in hours per kind, mnemopi's `core/weibull.ts`: a note is a learning, a workspace fact a fact,
 *  and what the owner kept for every workspace a preference or a profile line, which age slowest. */
const AGING: Readonly<Record<MemoryKind, { readonly k: number; readonly etaHours: number }>> = {
  note: { k: 0.7, etaHours: 1440 },
  fact: { k: 0.8, etaHours: 720 },
  'account-fact': { k: 0.4, etaHours: 4380 },
  'account-note': { k: 0.3, etaHours: 8760 },
};

function memoryKind(fact: FactSearchHit | undefined, note: AccountNoteHit | undefined): MemoryKind {
  if (fact !== undefined) return fact.scope === 'account' ? 'account-fact' : 'fact';

  return note === undefined ? 'note' : 'account-note';
}

/** How much of a memory survives `ageMs`: 1 when new or of unknown age, falling toward 0. */
function survival(kind: MemoryKind, ageMs: number | null): number {
  if (ageMs === null || ageMs <= 0) return 1;
  const { k, etaHours } = AGING[kind];

  return Math.exp(-((ageMs / 3_600_000 / etaHours) ** k));
}

/** How much of a recall's ranking is relevance rather than difference from what is already chosen (mnemopi `mmr.ts`). */
const MMR_LAMBDA = 0.7;

/**
 * The best `limit` hits, each next one chosen by maximal marginal relevance: its score, less how much its words repeat a
 * hit already chosen (Jaccard over word sets), so near-copies of one note do not crowd out a different one.
 */
function diverse(ranked: readonly HybridHit[], limit: number): HybridHit[] {
  const top = ranked[0]?.rrfScore ?? 0;

  if (top <= 0) return ranked.slice(0, limit);
  const words = new Map(ranked.map((hit) => [hit.id, new Set(hit.snippet.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))]));
  const chosen: HybridHit[] = [];
  const left = [...ranked];

  while (chosen.length < limit && left.length > 0) {
    let best = 0;
    let bestValue = -Infinity;

    for (const [at, hit] of left.entries()) {
      const own = words.get(hit.id) ?? new Set<string>();
      const repeat = Math.max(0, ...chosen.map((picked) => jaccard(own, words.get(picked.id) ?? new Set())));
      const value = MMR_LAMBDA * (hit.rrfScore / top) - (1 - MMR_LAMBDA) * repeat;

      if (value > bestValue) {
        best = at;
        bestValue = value;
      }
    }

    chosen.push(...left.splice(best, 1));
  }

  return chosen;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;

  for (const word of a) if (b.has(word)) shared += 1;

  return shared / (a.size + b.size - shared);
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

/-
  Proteus.Storage.FTS5Search — FTS5 search model. 0 sorry.
  Models: packages/agent-utils/src/memory/store.ts

  Carries the corpus's single trusted axiom (`fts5_indexed_findable`) — a
  statement about SQLite's FTS5 engine, which is external to the model and
  not provable in Lean. Everything else in this file is proved outright.
-/

namespace Proteus.Storage.FTS5Search

structure Chunk where
  id   : String
  path : String
  text : String
  deriving Repr, BEq, Inhabited

structure SearchResult where
  path    : String
  snippet : String
  score   : Nat
  deriving Repr, BEq, Inhabited

def indexChunks (existing : List Chunk) (path : String) (newChunks : List Chunk) : List Chunk :=
  newChunks ++ existing.filter (fun c => c.path ≠ path)

def boundedSearch (results : List SearchResult) (limit : Nat) : List SearchResult :=
  results.take limit

/-- New chunks appear after indexing. store.ts:126-137 -/
theorem index_includes_new (existing : List Chunk) (path : String) (chunks : List Chunk)
    (c : Chunk) (hc : c ∈ chunks) :
    c ∈ indexChunks existing path chunks := by
  simp [indexChunks, List.mem_append]; left; exact hc

/-- Other-path chunks survive indexing. store.ts:134-139 -/
theorem index_preserves_other (existing : List Chunk) (path : String) (chunks : List Chunk)
    (c : Chunk) (hc : c ∈ existing) (hdiff : c.path ≠ path) :
    c ∈ indexChunks existing path chunks := by
  simp [indexChunks, List.mem_append, List.mem_filter]
  right; exact ⟨hc, hdiff⟩

/-- Search results bounded by limit. store.ts:179 -/
theorem search_bounded (results : List SearchResult) (limit : Nat) :
    (boundedSearch results limit).length ≤ limit :=
  List.length_take_le limit results

/-- The FTS5 MATCH engine, abstract: whether a chunk's text matches a query,
    and the row set SQLite returns for a query over an indexed chunk list
    (store.ts:182-190, `memory_chunks_fts MATCH ?`). Opaque because the real
    tokenizer/matcher lives inside SQLite, outside this model. -/
opaque ftsMatch : Chunk → String → Bool

opaque ftsSearch : List Chunk → String → List SearchResult

/-- TRUSTED MODEL ASSUMPTION about SQLite: FTS5 completeness — every indexed
    chunk whose text matches the query is findable, i.e. SQLite's
    `memory_chunks_fts MATCH` returns a row for it (before the LIMIT is
    applied). TS behavior assumed: MemoryStore.search → runFtsQuery
    (packages/agent-utils/src/memory/store.ts:153-190) surfaces every
    matching row of memory_chunks_fts kept in sync by indexFile
    (store.ts:117-146). Covering test: NONE as of 2026-07-13 —
    packages/agent-utils/tests/memory-append.test.ts exercises appendToFile
    only; no test drives indexFile + search round-trip. Flagged in the WP-F2
    report; enroll in traceability.yaml (WP-F1) as a modelAssumption with
    remainingEvidence = an FTS5 index→search integration test. -/
axiom fts5_indexed_findable
    (chunks : List Chunk) (query : String) (c : Chunk)
    (hmem : c ∈ chunks) (hmatch : ftsMatch c query = true) :
    ∃ r ∈ ftsSearch chunks query, r.path = c.path

/-- Scores are non-negative — by construction in this model (Nat), formerly a
    redundant axiom. The TS counterpart is store.ts:175
    `score: 1 / (1 + Math.abs(r.rank))` ∈ (0, 1], untested; a differential
    fixture (WP-F4) is the right home for that fact. -/
theorem fts5_scores_nonneg (r : SearchResult) : r.score ≥ 0 :=
  Nat.zero_le r.score

end Proteus.Storage.FTS5Search

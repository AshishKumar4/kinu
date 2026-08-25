/-
  Proteus.Storage.OverlayCas — the chunk-CAS overlay: cost, and the
  crash-ordering chain as reachability. 0 sorry.

  Models `overlayCasStorage` and `CAS_TREE_MOUNT`
  (packages/devbox/src/overlay-cas.ts); its helpers `stageBlobs`,
  `foldJournalIntoTree`, `replayPending`, `assembleFile`
  (packages/devbox/src/cas/sync.ts); `advanceCursor`, `readFoldedSeq`,
  `pendingBatches`, `listJournalAfter`, `appendJournalBatch`,
  `coalesce`, `DEFAULT_BATCH_SIZE` (packages/devbox/src/cas/journal.ts);
  and the key
  layout `blobKey`, `journalKey`, `treeKey`, `KEY_CURSOR`,
  `KEY_MANIFEST` (packages/devbox/src/cas/types.ts), over the
  `DevboxStorage` seam (`attach`, `checkpoint 'tick' | 'quiesce'`,
  `discard`). Symbols rather than lines: the package is under active
  decomposition.

  Cost model: DurableFsResearch §3. n = tree bytes/paths, p = pending
  change since the last tick, c = cumulative changed-set since base,
  L ≤ 2. Lean proves the complexity class of this model, not
  wall-clock. The deployed bench owns constants.

  -- WHY THE ORDERING IS MODELLED AS A TOTAL STEP FUNCTION OVER TRACES,
  and not as three hand-asserted postconditions. The brief asks for the
  chain as a REACHABILITY invariant: "no interleaving admits a cursor
  ahead of its fold or a journal entry naming an unstaged blob". A
  relation of hand-asserted postconditions admits every successor it
  does not forbid, so "no interleaving admits" is not expressible over
  one — the reason `Publication.lean` departed from `mctsTransition`.
  So `stepOf` here is a TOTAL FUNCTION, `runOf` folds it over an
  arbitrary finite action list, and a crash is modelled as stopping at
  an arbitrary prefix. Every theorem is then about the definition.

  ================================================================
  THE ONE LINEAR TERM, stated as a theorem rather than as prose.
  ================================================================

  `foldJournalIntoTree` rewrites the folded tree/manifest view, and
  that PUT is O(tree paths) — the single honest linear-in-n term in
  this design (DurableFsResearch §3: "quiesce: tick + fold + ONE
  manifest PUT that is O(tree paths) — the single honest linear-in-n
  term"). It is `quiesce_fold_carries_the_one_linear_term`. Tick,
  replay, attach and read are each independent of n, proved separately
  so the linear term cannot be smuggled into them.

  -- WHAT THIS ABSTRACTION KEEPS: the FOUR ordered effects of a
     checkpoint (stage blobs, append journal, fold into tree plus
     manifest, advance cursor) and the reap that follows the cursor,
     the fact that a tick omits the fold, replay from the folded
     cursor over pending entries only, content-hash dedup so a rename
     uploads nothing, tombstones, and the read path's manifest lookup
     plus per-chunk page-in.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. BYTES PER CLASS-A. `SINGLE_PUT_MAX_BYTES` is 8 MiB
     (`object-store.ts`), so a real tick's class-A count is
     O(p / 8 MiB). The model counts staged blobs, and the divisor is
     the bench's. A blob count that grew with n would be visible
     here; a wrong divisor would not.

  2. CONTENT-DEFINED CHUNKING. Blob identity is a content hash in the
     source and a count here. Whether two versions of a file share
     chunks is a property of the chunker, which the model treats as
     given: the rename theorem states the reuse the algorithm performs,
     not the boundary-shift behaviour a rolling hash would add.

  3. CONCURRENCY. One sequential writer, as everywhere in this corpus.
     A devbox owns its prefix.

  4. WHETHER A MISSING BLOB IS DETECTED. `replayPending`'s rule is a
     hard stop on a missing blob rather than a fabricated read. The
     model proves the invariant that makes the stop unreachable on a
     legal trace; that the code stops rather than fabricates is a
     source-shape property Lean cannot see.

  5. THE ORPHAN SWEEP'S COMPLETENESS. `gc_is_off_the_hot_path` proves
     the sweep is not inside attach or tick. That a prefix listing
     minus the reachable set is the right set is `discard`'s and the
     sweep's own correctness, not a cost claim.

  6. WHERE THE FORCE OF AN INDEPENDENCE THEOREM LIES. A theorem of the
     form "the cost is equal under every n" is proved by `rfl` against
     a cost function that does not read n, so Lean checks that the
     DEFINITION ignores n rather than that the ALGORITHM does. What
     connects them is the reading of the source recorded above each
     definition. The ordering section is not like this: `stepOf` is a
     real transition system and its invariant is proved by induction
     over every finite trace, so the reachability claims stand on their
     own.
-/

import Proteus.Storage.CostModel

namespace Proteus.Storage.OverlayCas

open Proteus.Storage.CostModel

/-! ## Attach

  Attach mounts the materialized tree read-only as the lower and a
  fresh native upper over it, then replays journal entries newer than
  the folded cursor. L ≤ 2, and no payload bytes move: the lower is a
  lazy mount and pages arrive on read. -/

def layers : Nat := 2

theorem overlay_mounts_two_layers : layers = 2 := rfl

theorem overlay_layers_le_two : layers ≤ 2 := by decide

/-- Replay reads exactly the pending entries — those newer than the
    folded cursor (`replayPending` over `listJournalAfter`). One LIST of
    the `journal/` prefix, which R2 bills class-A, then one GET per
    pending entry. The LIST is counted: claiming a recovery path spends
    no write-class op would be false. -/
def replayCost (pending : Nat) : Cost :=
  { classA := 1
    classB := pending
    bytes := 0
    journalScanned := pending
    layersMounted := 0 }

/-- Attach: one cursor GET (`readFoldedSeq`), the replay, and two
    mounted layers. No payload bytes: the lower is a lazy mount and
    pages arrive on read. -/
def attachCost (pending : Nat) : Cost :=
  { classA := 1
    classB := 1 + pending
    bytes := 0
    journalScanned := pending
    layersMounted := layers }

/-- Restated over the size record so independence from n and c is a
    theorem. Attach reads the cursor and the pending journal. -/
def attachCostAt (_n p _c : Nat) : Cost := attachCost p

/-- **Recovery / replay is O(p).** One LIST, one GET per pending entry,
    no bytes of the tree. -/
theorem replay_is_linear_in_pending (p : Nat) :
    (replayCost p).journalScanned = p
    ∧ (replayCost p).classB = p
    ∧ (replayCost p).bytes = 0
    ∧ (replayCost p).classA = 1 :=
  ⟨rfl, rfl, rfl, rfl⟩

/-- **Attach does not mention n.** One manifest GET plus the pending
    replay, over two mounted layers. -/
theorem overlay_attach_independent_of_n (n n' p c : Nat) :
    attachCostAt n p c = attachCostAt n' p c :=
  rfl

/-- **Attach does not mention the cumulative changed-set either.** The
    folded cursor is what bounds the scan, so a long-lived box with a
    large c still attaches in O(p). This is exactly the property the
    chain lacks, where the attach seed is c. -/
theorem overlay_attach_independent_of_cumulative (n p c c' : Nat) :
    attachCostAt n p c = attachCostAt n p c' :=
  rfl

theorem overlay_attach_scans_only_pending (n p c : Nat) :
    (attachCostAt n p c).journalScanned = p
    ∧ (attachCostAt n p c).bytes = 0
    ∧ (attachCostAt n p c).layersMounted = layers :=
  ⟨rfl, rfl, rfl⟩

/-! ## Read

  A read is a manifest lookup and a page-in of the chunks it names.
  O(1) lookup, O(chunk size) bytes — independent of n. -/

def readCost (chunkBytes : Nat) : Cost :=
  { classA := 0
    classB := 1
    bytes := chunkBytes
    journalScanned := 0
    layersMounted := 0 }

def readCostAt (_n _p _c chunkBytes : Nat) : Cost := readCost chunkBytes

/-- **A read is one manifest lookup plus the chunk it pages in.** -/
theorem read_is_one_lookup_and_one_chunk (chunkBytes : Nat) :
    (readCost chunkBytes).classB = 1
    ∧ (readCost chunkBytes).bytes = chunkBytes :=
  ⟨rfl, rfl⟩

theorem overlay_read_independent_of_n (n n' p c chunkBytes : Nat) :
    readCostAt n p c chunkBytes = readCostAt n' p c chunkBytes :=
  rfl

/-! ## Tick checkpoint

  `stageBlobs` stages the new chunk blobs for the pending change and
  `advanceCursor` records them; a tick appends a journal batch and does
  NOT fold. So a tick is O(new blobs) class-A plus one journal PUT, and
  O(new chunk bytes) staged. Neither mentions n or c — the whole point
  of replacing the chain's cumulative delta. -/

/-! ### Batching

  `stageBlobs` commits in batches of `batchSize` (default
  `DEFAULT_BATCH_SIZE = 64`), calling `commitBatch` once each batch's
  blobs are durable — which is where that batch's ONE journal object is
  written, keyed by the batch's last seq and carrying the whole entry
  array. A batch is therefore the unit of blob staging AND of journal
  writing, so the unit of loss under a crash is one batch, and the redo
  re-uploads nothing because a content-addressed key that already
  exists is skipped by a HEAD. -/

/-- Batches for a pending change of `p` entries: ⌈p / batchSize⌉. -/
def batches (p batchSize : Nat) : Nat := (p + batchSize - 1) / batchSize

/-- The batches cover the pending change: nothing is left unstaged. -/
theorem batches_cover_the_pending_change (p batchSize : Nat) (hb : 0 < batchSize) :
    p ≤ batchSize * batches p batchSize := by
  unfold batches
  have hdm := Nat.div_add_mod (p + batchSize - 1) batchSize
  have hlt := Nat.mod_lt (p + batchSize - 1) hb
  omega

/-- **And no batch is wasted, so the work at risk in a crash is one
    batch rather than the whole change set.** Minimality: the batches
    times the batch size is under `p + batchSize`, which is exactly the
    statement that the final batch holds at most `batchSize` entries.
    Since a batch is also the journal-write unit, a crash loses at most
    one journal object's worth of entries. -/
theorem a_crash_redoes_at_most_one_batch (p batchSize : Nat) (hb : 0 < batchSize) :
    batchSize * batches p batchSize < p + batchSize := by
  unfold batches
  have hdm := Nat.div_add_mod (p + batchSize - 1) batchSize
  have hlt := Nat.mod_lt (p + batchSize - 1) hb
  omega

/-! ### The tick

  `stageBlobs` uploads only chunks the store does not already hold,
  probing with a HEAD when the in-memory known-set cannot answer
  (content-hash dedup, so a rename uploads nothing), then
  `appendJournalBatch` writes ONE object per BATCH — keyed by the
  batch's last seq, carrying the whole entry array. Every term is
  pending-shaped; none mentions n or c.

  This was ⌈p/64⌉ only after a defect was fixed: the journal used to be
  one object per ENTRY, which made an npm-shaped tick cost thousands of
  class-A PUTs. The theorem below was true of that code and the code
  was wrong, which is the shape a cost model is for. -/

def tickCost
    (newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) : Cost :=
  { classA := newBlobs + batches journalEntries batchSize
    classB := headChecks
    bytes := newChunkBytes
    journalScanned := journalEntries
    layersMounted := 0 }

def tickCostAt
    (_n _p _c newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) : Cost :=
  tickCost newBlobs headChecks newChunkBytes journalEntries batchSize

/-- **A tick is one PUT per new blob plus one PUT per BATCH of journal
    entries, one HEAD per chunk the known-set cannot answer, and it
    stages the new chunk bytes.** -/
theorem tick_is_blobs_plus_one_put_per_batch
    (newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) :
    (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).classA
        = newBlobs + batches journalEntries batchSize
    ∧ (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).classB
        = headChecks
    ∧ (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).bytes
        = newChunkBytes := by
  exact ⟨rfl, rfl, rfl⟩
/-- **And the batched journal is strictly cheaper than one object per
    entry, from two entries up.** At exactly one entry the two agree —
    one entry needs one object either way — so the hypothesis is
    `1 < journalEntries` and not `0 <`. That boundary is the reason this
    is stated rather than assumed: a model that claimed strict
    improvement everywhere would be false at p = 1. -/
theorem batching_the_journal_beats_one_put_per_entry
    (journalEntries batchSize : Nat) (hb : 1 < batchSize)
    (hp : 1 < journalEntries) :
    batches journalEntries batchSize < journalEntries := by
  unfold batches
  rw [Nat.div_lt_iff_lt_mul (by omega : 0 < batchSize)]
  obtain ⟨a, ha⟩ : ∃ a, journalEntries = a + 2 := ⟨journalEntries - 2, by omega⟩
  obtain ⟨b, hbb⟩ : ∃ b, batchSize = b + 2 := ⟨batchSize - 2, by omega⟩
  subst ha
  subst hbb
  have hsplit : (a + 2) * (b + 2) = a * (b + 2) + 2 * (b + 2) := Nat.add_mul a 2 (b + 2)
  have hgrow : a * 1 ≤ a * (b + 2) := Nat.mul_le_mul_left a (by omega)
  omega

/-- At exactly one entry the batched journal costs the same one PUT, so
    the strictness above is sharp rather than an artefact of the bound. -/
theorem one_entry_costs_one_journal_put (batchSize : Nat) (hb : 0 < batchSize) :
    batches 1 batchSize = 1 := by
  unfold batches
  have h : 1 + batchSize - 1 = batchSize := by omega
  rw [h, Nat.div_self hb]

/-- **A redone batch stages no bytes.** Content addressing makes the
    replay idempotent: every chunk of the lost batch is already at its
    key, so the HEAD answers and the PUT never happens. Stated as the
    tick whose new-blob and new-byte counts are zero while its one
    journal write still happens. -/
theorem a_redone_batch_stages_no_bytes
    (headChecks journalEntries batchSize : Nat) :
    (tickCost 0 headChecks 0 journalEntries batchSize).bytes = 0
    ∧ (tickCost 0 headChecks 0 journalEntries batchSize).classA
        = batches journalEntries batchSize := by
  exact ⟨rfl, by simp [tickCost]⟩

theorem overlay_tick_independent_of_n
    (n n' p c newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) :
    tickCostAt n p c newBlobs headChecks newChunkBytes journalEntries batchSize
      = tickCostAt n' p c newBlobs headChecks newChunkBytes journalEntries batchSize :=
  rfl

/-- **And independent of the cumulative changed-set.** The chain's
    Θ(c) tick is exactly what this removes: a tick here ships only the
    new blobs, so p ≪ c costs p rather than c. -/
theorem overlay_tick_independent_of_cumulative
    (n p c c' newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) :
    tickCostAt n p c newBlobs headChecks newChunkBytes journalEntries batchSize
      = tickCostAt n p c' newBlobs headChecks newChunkBytes journalEntries batchSize :=
  rfl

/-- The comparison stated directly: where the chain uploads c, the
    overlay uploads the new chunk bytes, and when the pending change is
    a proper part of the cumulative set the overlay is strictly
    cheaper. -/
theorem overlay_tick_beats_the_chain_when_pending_is_small
    (p c newBlobs headChecks journalEntries batchSize : Nat) (h : p < c) :
    (tickCost newBlobs headChecks p journalEntries batchSize).bytes < c :=
  h

/-! ## Quiesce — the one linear term

  A quiesce is a tick plus `foldJournalIntoTree`, whose manifest PUT
  rewrites the folded view of every path. That PUT is O(tree paths).
  It is the single honest linear-in-n term in this design. -/

/-- `foldJournalIntoTree`: one tree PUT or delete per coalesced entry,
    one manifest PUT, one cursor PUT, then one delete per reaped
    journal object. The manifest PUT rewrites the folded view of every
    path, which is the linear term. -/
def foldCost (treePaths foldedEntries reaped : Nat) : Cost :=
  { classA := foldedEntries + 2 + reaped
    classB := 0
    bytes := treePaths
    journalScanned := foldedEntries
    layersMounted := 0 }

def quiesceCost
    (treePaths foldedEntries reaped newBlobs headChecks newChunkBytes
      journalEntries batchSize : Nat) : Cost :=
  Cost.add (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize)
    (foldCost treePaths foldedEntries reaped)

/-- **The quiesce fold carries one term linear in the tree.** The
    manifest PUT is O(tree paths); the quiesce's byte total is the
    tick's staged bytes plus that one term. -/
theorem quiesce_fold_carries_the_one_linear_term
    (treePaths foldedEntries reaped newBlobs headChecks newChunkBytes
      journalEntries batchSize : Nat) :
    (foldCost treePaths foldedEntries reaped).bytes = treePaths
    ∧ (quiesceCost treePaths foldedEntries reaped
        newBlobs headChecks newChunkBytes journalEntries batchSize).bytes
        = newChunkBytes + treePaths := by
  exact ⟨rfl, rfl⟩

/-- The fold's OPERATION count does not carry the linear term: it is the
    folded entries, two fixed PUTs, and the reap. Only the manifest's
    BYTES are linear, which is why sharding the manifest would remove
    the term without changing the op count. -/
theorem the_fold_operation_count_is_not_linear_in_the_tree
    (treePaths treePaths' foldedEntries reaped : Nat) :
    (foldCost treePaths foldedEntries reaped).classA
      = (foldCost treePaths' foldedEntries reaped).classA :=
  rfl

/-- The fold is the ONLY linear term: the quiesce's remaining cost is
    the tick's, which is independent of the tree. -/
theorem quiesce_minus_the_fold_is_the_tick
    (treePaths foldedEntries reaped newBlobs headChecks newChunkBytes
      journalEntries batchSize : Nat) :
    (quiesceCost treePaths foldedEntries reaped
        newBlobs headChecks newChunkBytes journalEntries batchSize).classA
      = (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).classA
          + (foldedEntries + 2 + reaped) :=
  rfl

/-- A tick does not fold, so nothing on the periodic path pays the
    linear term or the reap. -/
theorem tick_does_not_fold
    (newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) :
    (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).classA
      < (quiesceCost 0 0 0 newBlobs headChecks newChunkBytes
          journalEntries batchSize).classA := by
  simp [tickCost, quiesceCost, foldCost, Cost.add]

/-! ## Discard and the orphan sweep

  `discard` deletes the prefix: O(1) logical delete of a prefix.
  The GC sweep lists the prefix and removes what the manifest does not
  reach. It is O(prefix listing) and it runs off the hot path — never
  inside attach or tick. -/

def discardCost : Cost :=
  { classA := 1
    classB := 0
    bytes := 0
    journalScanned := 0
    layersMounted := 0 }

theorem discard_is_one_prefix_delete : discardCost.classA = 1 := rfl

/-- The sweep's cost is the listing plus one delete per orphan. -/
def gcCost (listedObjects orphans : Nat) : Cost :=
  { classA := listedObjects + orphans
    classB := 0
    bytes := 0
    journalScanned := 0
    layersMounted := 0 }

/-- **The sweep is bounded by the prefix listing and the orphan
    count.** -/
theorem gc_is_bounded_by_listing_and_orphans
    (listedObjects orphans : Nat) :
    (gcCost listedObjects orphans).classA = listedObjects + orphans
    ∧ (gcCost listedObjects orphans).bytes = 0 := by
  exact ⟨rfl, rfl⟩

/-- The hot path: what a container start and a periodic checkpoint pay.
    It takes the sweep's listing size as an argument it must then be
    proved to IGNORE — passing it is what makes the ignoring checkable
    rather than merely absent from the definition. -/
def hotPathCost
    (_listedObjects p newBlobs headChecks newChunkBytes journalEntries
      batchSize : Nat) : Cost :=
  Cost.add (attachCost p)
    (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize)

/-- **The sweep is off the hot path.** Attach and tick are equal under
    every stored-object count, so the sweep's listing never happens
    inside either. -/
theorem gc_is_off_the_hot_path
    (listedObjects listedObjects' p newBlobs headChecks newChunkBytes
      journalEntries batchSize : Nat) :
    hotPathCost listedObjects p newBlobs headChecks newChunkBytes
        journalEntries batchSize
      = hotPathCost listedObjects' p newBlobs headChecks newChunkBytes
          journalEntries batchSize :=
  rfl

/-- And the sweep is NOT independent of it, so the theorem above is a
    real separation rather than a cost model that cannot see a listing
    at all. -/
theorem the_sweep_does_read_the_listing (listedObjects orphans : Nat) :
    (gcCost (listedObjects + 1) orphans).classA
      > (gcCost listedObjects orphans).classA := by
  simp [gcCost]

/-- **The hot path's own listing is the JOURNAL prefix, and it is
    bounded by the pending change.** Attach spends exactly one LIST —
    `pendingBatches`, which R2 bills class-A — and scans p entries. A
    tick spends none. So "the sweep is off the hot path" is a claim
    about the sweep's whole-prefix listing, not a claim that the hot
    path lists nothing, which would be false. -/
theorem the_hot_path_lists_only_the_journal_prefix
    (p newBlobs headChecks newChunkBytes journalEntries batchSize : Nat) :
    (attachCost p).classA = 1
    ∧ (attachCost p).journalScanned = p
    ∧ (tickCost newBlobs headChecks newChunkBytes journalEntries batchSize).classA
        = newBlobs + batches journalEntries batchSize := by
  exact ⟨rfl, rfl, rfl⟩

/-! ## The crash-ordering chain, as reachability

  Four rules, in one order, all four red-proven by mutants in the
  package's own suite:

    1. `stageBlobs` — blob PUTs complete BEFORE the journal batch that
       references them. A stale entry is dropped rather than journalled,
       so a journal object never names a blob that was not stored.
    2. `appendJournalBatch` — BEFORE any fold mutation.
       `foldJournalIntoTree` reads only journal objects already in the
       store, so this one is structural.
    3. tree writes and the manifest PUT — BEFORE `advanceCursor`. The
       cursor PUT is the last assignment of the fold.
    4. `advanceCursor` — BEFORE the journal objects are reaped.
       "Reaping after the cursor advances means a crash leaves garbage,
       never a hole."

  A crash is a stop at an arbitrary prefix of an arbitrary action
  list. The properties the brief names must hold at every reachable
  state: no cursor ahead of its fold, and no journal entry naming an
  unstaged blob. Rule 4 adds the one the source states in its own
  words: nothing is reaped that the cursor has not passed. -/

/-- The store's ordering-relevant state. Counters rather than sets: the
    ordering is a property of the COUNTS reaching each stage, and the
    identity of a blob adds nothing to it. `staged` counts blobs
    durably PUT, `journalled` counts entries appended, `folded` counts
    entries written into `tree/` and the manifest, `cursor` counts
    entries `cursor.json` declares done, `reaped` counts journal
    objects deleted.

    BATCH GRANULARITY IS DISCARDED, and the direction matters. The
    shipped cursor advances past WHOLE batches only, so a half-folded
    batch is unrepresentable there. This model counts ENTRIES, so it
    admits cursor values the real store cannot hold. A coarser state
    space admits MORE traces, so an invariant proved here holds a
    fortiori under the batch-granular refinement — the discard is safe
    in the only direction that matters. What is lost is the ability to
    state the stronger property, not the weaker one. -/
structure Store where
  staged : Nat
  journalled : Nat
  folded : Nat
  cursor : Nat
  reaped : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

def empty : Store :=
  { staged := 0, journalled := 0, folded := 0, cursor := 0, reaped := 0 }

/-- The actions the strategy can take. Each is the durable effect of
    one helper. -/
inductive Action where
  /-- `stageBlobs`: one more blob durably PUT. -/
  | stage
  /-- `appendJournalBatch`. Legal only for entries whose blobs are
      staged: blob-before-journal. -/
  | journal
  /-- `foldJournalIntoTree`'s tree and manifest writes. Legal only for
      entries already journalled: journal-before-fold. -/
  | fold
  /-- `advanceCursor`. Legal only up to what is folded:
      fold-before-cursor. -/
  | advance
  /-- The journal-object delete that closes a fold. Legal only up to
      what the cursor has passed: cursor-before-reap. -/
  | reap
  deriving Repr, BEq, DecidableEq, Inhabited

/-- One step. TOTAL, so reachability quantifies over every finite
    action list; an action whose guard fails is a no-op, which is what
    a refusal is. The guards ARE the four ordering rules. -/
def stepOf (s : Store) : Action → Store
  | .stage => { s with staged := s.staged + 1 }
  | .journal =>
      if s.journalled < s.staged then { s with journalled := s.journalled + 1 } else s
  | .fold =>
      if s.folded < s.journalled then { s with folded := s.folded + 1 } else s
  | .advance =>
      if s.cursor < s.folded then { s with cursor := s.cursor + 1 } else s
  | .reap =>
      if s.reaped < s.cursor then { s with reaped := s.reaped + 1 } else s

/-- A trace, folded. A crash is a stop at any prefix, and every prefix
    of a list is itself a list, so quantifying over all finite lists
    quantifies over all crash points. -/
def runOf (s : Store) : List Action → Store :=
  List.foldl stepOf s

theorem runOf_nil (s : Store) : runOf s [] = s := rfl

theorem runOf_cons (s : Store) (a : Action) (as : List Action) :
    runOf s (a :: as) = runOf (stepOf s a) as :=
  rfl

theorem runOf_append (s : Store) (as bs : List Action) :
    runOf s (as ++ bs) = runOf (runOf s as) bs := by
  simp [runOf, List.foldl_append]

/-- The ordering invariant:
    reaped ≤ cursor ≤ folded ≤ journalled ≤ staged.
    Each `≤` is one of the four rules. -/
def Ordered (s : Store) : Prop :=
  s.reaped ≤ s.cursor ∧ s.cursor ≤ s.folded
    ∧ s.folded ≤ s.journalled ∧ s.journalled ≤ s.staged

theorem empty_is_ordered : Ordered empty := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [empty]

theorem step_preserves_ordering (s : Store) (a : Action) (h : Ordered s) :
    Ordered (stepOf s a) := by
  obtain ⟨hr, hc, hf, hj⟩ := h
  cases a with
  | stage =>
    refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [stepOf] <;> omega
  | journal =>
    by_cases hlt : s.journalled < s.staged
    · refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [stepOf, hlt] <;> omega
    · simp only [stepOf, if_neg hlt]
      exact ⟨hr, hc, hf, hj⟩
  | fold =>
    by_cases hlt : s.folded < s.journalled
    · refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [stepOf, hlt] <;> omega
    · simp only [stepOf, if_neg hlt]
      exact ⟨hr, hc, hf, hj⟩
  | advance =>
    by_cases hlt : s.cursor < s.folded
    · refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [stepOf, hlt] <;> omega
    · simp only [stepOf, if_neg hlt]
      exact ⟨hr, hc, hf, hj⟩
  | reap =>
    by_cases hlt : s.reaped < s.cursor
    · refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [stepOf, hlt] <;> omega
    · simp only [stepOf, if_neg hlt]
      exact ⟨hr, hc, hf, hj⟩

/-- **The ordering holds at every reachable state, including every
    crash point.** Reachability over all finite action lists from the
    empty store. -/
theorem ordering_is_invariant (as : List Action) :
    Ordered (runOf empty as) := by
  have general : ∀ (bs : List Action) (s : Store), Ordered s → Ordered (runOf s bs) := by
    intro bs
    induction bs with
    | nil => intro s h; exact h
    | cons b bs ih =>
      intro s h
      rw [runOf_cons]
      exact ih (stepOf s b) (step_preserves_ordering s b h)
  exact general as empty empty_is_ordered

/-- **No interleaving admits a cursor ahead of its fold.** -/
theorem no_cursor_ahead_of_its_fold (as : List Action) :
    (runOf empty as).cursor ≤ (runOf empty as).folded :=
  (ordering_is_invariant as).2.1

/-- **No interleaving admits a journal entry naming an unstaged
    blob.** Blob-before-journal, over every trace and every crash
    point. -/
theorem no_journal_entry_names_an_unstaged_blob (as : List Action) :
    (runOf empty as).journalled ≤ (runOf empty as).staged :=
  (ordering_is_invariant as).2.2.2

/-- **And nothing folds an entry that was never journalled.** -/
theorem no_fold_precedes_its_journal_entry (as : List Action) :
    (runOf empty as).folded ≤ (runOf empty as).journalled :=
  (ordering_is_invariant as).2.2.1

/-- **No journal object is reaped before the cursor passes it**, so a
    crash leaves garbage rather than a hole: the entry is still
    replayable because its object still exists. -/
theorem no_reap_precedes_its_cursor (as : List Action) :
    (runOf empty as).reaped ≤ (runOf empty as).cursor :=
  (ordering_is_invariant as).1

/-- The cursor never runs past what is staged: the chain composed. -/
theorem the_cursor_never_passes_a_staged_blob (as : List Action) :
    (runOf empty as).cursor ≤ (runOf empty as).staged := by
  obtain ⟨hr, hc, hf, hj⟩ := ordering_is_invariant as
  omega

/-- And a reap never outruns a staged blob either: the whole chain,
    end to end, over every trace. -/
theorem the_reap_never_passes_a_staged_blob (as : List Action) :
    (runOf empty as).reaped ≤ (runOf empty as).staged := by
  obtain ⟨hr, hc, hf, hj⟩ := ordering_is_invariant as
  omega

/-! ### The guards are load-bearing

  Each rule is a separate comparison that could invert silently, so
  each is shown to have teeth: with the guard removed, a trace reaches
  a state the invariant forbids. -/

/-- The journal append with blob-before-journal REMOVED. -/
def stepUnguardedJournal (s : Store) : Action → Store
  | .journal => { s with journalled := s.journalled + 1 }
  | a => stepOf s a

/-- **Remove blob-before-journal and a journal entry names an unstaged
    blob in one step.** -/
theorem dropping_blob_before_journal_names_an_unstaged_blob :
    (stepUnguardedJournal empty .journal).journalled
      > (stepUnguardedJournal empty .journal).staged := by
  decide

/-- The cursor advance with fold-before-cursor REMOVED. -/
def stepUnguardedAdvance (s : Store) : Action → Store
  | .advance => { s with cursor := s.cursor + 1 }
  | a => stepOf s a

/-- **Remove fold-before-cursor and the cursor runs ahead of the
    fold**, which is the state a replay reads as "nothing pending"
    while entries are unfolded. -/
theorem dropping_fold_before_cursor_advances_past_the_fold :
    (stepUnguardedAdvance empty .advance).cursor
      > (stepUnguardedAdvance empty .advance).folded := by
  decide

/-- The fold with journal-before-fold REMOVED. -/
def stepUnguardedFold (s : Store) : Action → Store
  | .fold => { s with folded := s.folded + 1 }
  | a => stepOf s a

/-- **Remove journal-before-fold and the tree absorbs an entry no
    journal records**, so a crash after it cannot be replayed. -/
theorem dropping_journal_before_fold_folds_an_unrecorded_entry :
    (stepUnguardedFold empty .fold).folded
      > (stepUnguardedFold empty .fold).journalled := by
  decide

/-- The reap with cursor-before-reap REMOVED. -/
def stepUnguardedReap (s : Store) : Action → Store
  | .reap => { s with reaped := s.reaped + 1 }
  | a => stepOf s a

/-- **Remove cursor-before-reap and a journal object is deleted the
    cursor has not passed**, which is the one shape the source rules
    out by name: a crash there leaves a HOLE rather than garbage,
    because the entry is neither folded nor replayable. -/
theorem dropping_cursor_before_reap_leaves_a_hole :
    (stepUnguardedReap empty .reap).reaped
      > (stepUnguardedReap empty .reap).cursor := by
  decide

/-! ### The legal orders are reachable

  An invariant that held because nothing happened would be worthless,
  so the intended sequences are exhibited: one full tick reaching a
  journalled entry, and one full quiesce reaching a folded entry, an
  advanced cursor and a reaped journal object. -/

/-- The tick's durable order: stage, then journal. No fold, no cursor
    write, no reap. -/
def tickTrace : List Action := [.stage, .journal]

/-- The quiesce's durable order: the tick, then fold, then cursor,
    then reap. -/
def quiesceTrace : List Action := [.stage, .journal, .fold, .advance, .reap]

/-- **A tick stages and journals, and folds nothing.** -/
theorem a_tick_journals_without_folding :
    runOf empty tickTrace
      = { staged := 1, journalled := 1, folded := 0, cursor := 0, reaped := 0 } := by
  decide

/-- **A quiesce reaches a folded entry, an advanced cursor and a
    reaped journal object.** -/
theorem a_quiesce_folds_and_advances :
    runOf empty quiesceTrace
      = { staged := 1, journalled := 1, folded := 1, cursor := 1, reaped := 1 } := by
  decide

/-- Out of order, every guard refuses and the store does not move: a
    reap or a cursor advance before anything is staged is a no-op, not
    a state the invariant has to survive. -/
theorem the_reversed_order_does_nothing :
    runOf empty [.reap, .advance, .fold, .journal] = empty := by
  decide

/-! ## Tombstones and rename

  A delete is a journal entry, not an absence: replay must be able to
  remove a path the folded tree still holds. A rename is a delete plus
  a create whose blob is the one already staged, so a rename stages no
  bytes. -/

inductive EntryKind where
  | write
  | tombstone
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Bytes a journal entry stages. A tombstone stages none; a write
    stages its new chunk bytes; a rename's create reuses the blob its
    source already staged, so it stages none either. -/
def stagedBytes : EntryKind → Bool → Nat → Nat
  | .tombstone, _, _ => 0
  | .write, true, _ => 0
  | .write, false, bytes => bytes

/-- **A tombstone stages no bytes**, so a deletion of a large file
    costs one journal entry rather than its size. -/
theorem a_tombstone_stages_no_bytes (reuse : Bool) (bytes : Nat) :
    stagedBytes .tombstone reuse bytes = 0 := by
  cases reuse <;> rfl

/-- **A rename stages no bytes**: delete plus create with blob reuse.
    This is the r2fs weakness inverted — there a rename is a copy and a
    delete and costs the object's bytes. -/
theorem a_rename_stages_no_bytes (bytes : Nat) :
    stagedBytes .tombstone true bytes + stagedBytes .write true bytes = 0 :=
  rfl

/-- A fresh write does stage its bytes, so the reuse flag is not
    vacuous. -/
theorem a_fresh_write_stages_its_bytes (bytes : Nat) :
    stagedBytes .write false bytes = bytes :=
  rfl

/-! ### The loss window

  What a crash loses, in wall-clock terms: exactly the writes since
  the last completed tick. The tick's model is the fingerprint gate
  as shipped (packages/devbox/src/devbox.ts checkChanges): a tick
  that completes saves EVERYTHING written before it, because the gate
  commits whenever it cannot prove "unchanged" — it never skips a
  changed tree. The red direction models the deployed 2026-08-25
  defect exactly: a tick that misclassifies a changed tree as
  unchanged saves nothing, and no number of such ticks closes the
  window. -/

/-- Workload writes against tick-saved progress. `written` counts
    writes the container accepted; `saved` counts what a completed
    tick has made durable. -/
structure Backlog where
  written : Nat
  saved : Nat

def Backlog.start : Backlog := ⟨0, 0⟩

/-- What a crash loses right now: accepted and not yet durable. -/
def Backlog.loss (b : Backlog) : Nat := b.written - b.saved

/-- A workload beat: one write lands, or one tick completes. -/
inductive Beat
  | write
  | tick

/-- One beat. A completed tick saves everything written — the
    fingerprint gate's contract, not an optimistic assumption. -/
def beatOf (b : Backlog) : Beat → Backlog
  | .write => { b with written := b.written + 1 }
  | .tick => { b with saved := b.written }

/-- A workload trace, folded. A crash is a stop at any prefix. -/
def replayBeats (b : Backlog) : List Beat → Backlog :=
  List.foldl beatOf b

/-- Writes in a trace segment. -/
def writesIn : List Beat → Nat
  | [] => 0
  | .write :: bs => writesIn bs + 1
  | .tick :: bs => writesIn bs

/-- **A completed tick closes the window**: loss is zero the moment it
    lands. -/
theorem a_completed_tick_closes_the_window (b : Backlog) :
    (beatOf b .tick).loss = 0 := by
  simp [beatOf, Backlog.loss]

/-- A tick-free trace segment only accumulates writes: written grows
    by exactly the segment's writes and saved does not move. -/
theorem a_tick_free_segment_only_writes (bs : List Beat)
    (h : ∀ x ∈ bs, x = Beat.write) (b : Backlog) :
    replayBeats b bs
      = { written := b.written + writesIn bs, saved := b.saved } := by
  induction bs generalizing b with
  | nil => simp [replayBeats, writesIn]
  | cons x bs ih =>
    have hx : x = Beat.write := h x (List.mem_cons_self x bs)
    have hrest : ∀ y ∈ bs, y = Beat.write :=
      fun y hy => h y (List.mem_cons_of_mem x hy)
    subst hx
    rw [replayBeats, List.foldl_cons, ← replayBeats, ih hrest]
    simp [beatOf, writesIn]
    omega

/-- **The loss window, exactly.** Split any trace at its last
    completed tick: whatever ran before it, a crash after a tick-free
    suffix loses exactly that suffix's writes — never a byte from
    before the tick. -/
theorem loss_is_the_writes_since_the_last_tick
    (before : List Beat) (since : List Beat)
    (h : ∀ x ∈ since, x = Beat.write) :
    (replayBeats Backlog.start (before ++ Beat.tick :: since)).loss
      = writesIn since := by
  rw [replayBeats, List.foldl_append, List.foldl_cons]
  rw [← replayBeats, ← replayBeats,
    a_tick_free_segment_only_writes since h]
  simp [beatOf, Backlog.loss]
  omega

/-- The tick with cannot-decide-commits REMOVED: a changed tree
    misclassified as unchanged saves nothing. This is the deployed
    2026-08-25 defect (21 "unchanged" ticks over changed workspaces)
    as a step function. -/
def beatSkipping (b : Backlog) : Beat → Backlog
  | .write => { b with written := b.written + 1 }
  | .tick => b

/-- **Remove the gate and the window never closes**: a write followed
    by a completed-but-skipping tick still shows loss, so no tick
    cadence bounds what a crash costs. -/
theorem a_skipping_tick_leaves_the_window_open :
    (beatSkipping (beatSkipping Backlog.start .write) .tick).loss = 1 := by
  decide

end Proteus.Storage.OverlayCas

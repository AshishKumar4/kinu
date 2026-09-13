/-
  Kinu.Storage.SnapshotChain — chunked publication and eager restore.

  Source: packages/devbox/src/chunked-delta.ts#planDeltaPublication,
  #buildDeltaStageOps, #buildDeltaMaterializeOps; and
  packages/devbox/src/snapshot-chain.ts#snapshotChainStorage,
  #shouldRebase, #supersedeGeneration.

  Each tick compares the cumulative upper AGAINST THE BASE, not the previous
  tick. Small, unhashable, nonregular, linked or more-than-half-hole files
  travel whole; other files carry nonzero changed 16 KiB blocks and records.
  The per-file sum is an uncompressed, block-rounded accounting bound.
  Digest deduplication, zero overrides and short final blocks can reduce it.
  Squashfs framing/compression is separate: no raw-byte theorem asserts an
  unconditional wire bound. C3 proves the five-block geometry and the numeric
  bound with explicit metadata/encoding premises; the bench measures those.

  Attach mounts at most two images, then reads M manifest records and
  materializes the whole base of each changed chunked file plus carried
  payload and zero overrides. In the design note's notation that is O(M)
  metadata and O(L + D) payload, with L the full changed-file bases. Below,
  baseBytes and deltaBytes name those two terms to avoid confusing L with
  layersMounted. A tiny overwrite can therefore require a whole-tree copy.
  No theorem here claims O(1) attach or O(pending-since-last-tick) publication.

  The generation model retains the current generation, one proven fallback,
  and named orphans. A successful attach releases the fallback to the orphan
  list; a completed sweep leaves the current AND any retained fallback.
  Filesystem operations, compression, crash cuts inside a storage write and
  concurrent container writes remain outside these sequential models.
-/

import Kinu.Storage.CostModel

namespace Kinu.Storage.SnapshotChain

open Kinu.Storage.CostModel

inductive Kind where
  | tick
  | quiesce
  deriving Repr, BEq, DecidableEq, Inhabited

def layers (hasDelta : Bool) : Nat := if hasDelta then 2 else 1

theorem layers_le_two (hasDelta : Bool) : layers hasDelta ≤ 2 := by
  cases hasDelta <;> simp [layers]

/-! ## Publication accounting after excludes -/

def blockBytes : Nat := 16384
def wholeThreshold : Nat := 65536

/-- One changed file. `wholeRequired` combines nonregular, linked and absent
    hash-index cases. Zero overrides carry records but no chunk blob.
    Base size is needed at restore even when only one block changed. -/
structure FileDelta where
  size : Nat
  baseBytes : Nat
  holes : Nat
  changedChunks : Nat
  zeroOverrides : Nat
  recordBytes : Nat
  wholeRequired : Bool := false
  deriving Repr, DecidableEq

def blockCount (f : FileDelta) : Nat := (f.size + blockBytes - 1) / blockBytes

def travelsWhole (f : FileDelta) : Bool :=
  f.wholeRequired || decide (f.size < wholeThreshold) ||
    decide (blockCount f < 2 * f.holes)

def filePayload (f : FileDelta) : Nat :=
  if travelsWhole f then f.size else f.changedChunks * blockBytes

def filePublication (f : FileDelta) : Nat := filePayload f + f.recordBytes

/-- Files have already passed `deltaProbeCommand`'s exclude walk. Records
    not owned by one file (directories, deletions, links, JSON framing) are
    accounted separately in `tickCost`. -/
def tickUpload (files : List FileDelta) : Nat :=
  (files.map filePublication).sum

theorem small_file_travels_whole (f : FileDelta) (h : f.size < wholeThreshold) :
    filePublication f = f.size + f.recordBytes := by
  simp [filePublication, filePayload, travelsWhole, h]

theorem sparse_file_travels_whole (f : FileDelta)
    (h : blockCount f < 2 * f.holes) :
    filePublication f = f.size + f.recordBytes := by
  simp [filePublication, filePayload, travelsWhole, h]

theorem unavailable_hashes_travel_whole (f : FileDelta) (h : f.wholeRequired = true) :
    filePublication f = f.size + f.recordBytes := by
  simp [filePublication, filePayload, travelsWhole, h]

theorem chunked_file_publishes_blocks_and_record (f : FileDelta)
    (h : travelsWhole f = false) :
    filePublication f = f.changedChunks * blockBytes + f.recordBytes := by
  simp [filePublication, filePayload, h]

theorem chain_tick_is_sum_of_file_publications (files : List FileDelta) :
    tickUpload files = (files.map fun f =>
      (if travelsWhole f then f.size else f.changedChunks * blockBytes) + f.recordBytes).sum :=
  rfl

theorem chain_tick_append (xs ys : List FileDelta) :
    tickUpload (xs ++ ys) = tickUpload xs + tickUpload ys := by
  induction xs with
  | nil => simp [tickUpload]
  | cons x xs ih =>
    simp only [tickUpload, List.cons_append, List.map_cons, List.sum_cons] at *
    rw [ih, Nat.add_assoc]

/-- Same base and upper yield the same publication at the next tick: no
    prior-tick state is an input to the planner. This is NOT pending-only. -/
theorem identical_upper_republishes_same_blocks (files : List FileDelta) :
    tickUpload (files ++ files) = 2 * tickUpload files := by
  rw [chain_tick_append]
  omega

/-- The sum bounds a stage with deduplicated blobs, shared inodes, and short
    final blocks. `saved` counts bytes those mechanisms actually omit. -/
def stagedBytes (files : List FileDelta) (saved : Nat) : Nat :=
  tickUpload files - saved

theorem deduplicated_stage_le_file_sum (files : List FileDelta) (saved : Nat) :
    stagedBytes files saved ≤ tickUpload files := by
  simp [stagedBytes]

def tickCost (files : List FileDelta) (metadata : Nat) : Cost :=
  { classA := 1, classB := 0, bytes := tickUpload files + metadata, layersMounted := 0 }

/-- A host that cannot stage the package explicitly falls back to a full
    upper archive. The C3 chunked-path bound does not cover that branch. -/
def publicationBytes (chunked : Bool) (files : List FileDelta)
    (metadata cumulative excluded : Nat) : Nat :=
  if chunked then tickUpload files + metadata else cumulative - excluded

theorem unavailable_chunking_uses_full_upper (files : List FileDelta)
    (metadata cumulative excluded : Nat) :
    publicationBytes false files metadata cumulative excluded = cumulative - excluded := rfl

/-- A nonempty write of length w starting r bytes into a block touches this
    many blocks. At w = 64 KiB, both an aligned and unaligned offset are covered. -/
def touchedBlocks (offset length : Nat) : Nat :=
  if length = 0 then 0 else (offset % blockBytes + length + blockBytes - 1) / blockBytes

theorem c3_overwrite_touches_at_most_five_blocks (offset : Nat) :
    touchedBlocks offset 65536 ≤ 5 := by
  have h := Nat.mod_lt offset (by decide : 0 < blockBytes)
  simp [touchedBlocks, blockBytes] at *
  omega

theorem c3_aligned_overwrite_touches_four_blocks :
    touchedBlocks 8388608 65536 = 4 := by decide

def c3File (offset recordBytes : Nat) : FileDelta :=
  { size := 67108864, baseBytes := 67108864, holes := 0,
    changedChunks := touchedBlocks offset 65536, zeroOverrides := 0,
    recordBytes := recordBytes }

theorem c3_uses_chunked_publication (offset recordBytes : Nat) :
    travelsWhole (c3File offset recordBytes) = false := by
  simp [travelsWhole, c3File, wholeThreshold]

/-- Raw file payload plus its manifest record, under an explicit 4 KiB
    record budget. The record budget is evidence the bench must supply,
    not a consequence of unrestricted path lengths. -/
theorem c3_publication_bound (offset recordBytes : Nat) (hrecord : recordBytes ≤ 4096) :
    tickUpload [c3File offset recordBytes] ≤ 86016 := by
  have h := c3_overwrite_touches_at_most_five_blocks offset
  simp only [tickUpload, List.map_cons, List.map_nil, List.sum_cons, List.sum_nil, Nat.add_zero]
  rw [chunked_file_publishes_blocks_and_record _ (c3_uses_chunked_publication offset recordBytes)]
  simp only [c3File, blockBytes]
  omega

/-- The conformance harness encodes payload; production squashfs has its own
    framing. Even 3/2 expansion plus 64 KiB of total extra records/framing
    stays STRICTLY under the bench's 196608-byte bound. The explicit wire
    premise must be checked by the bench, never inferred from this model. -/
theorem c3_wire_bound (offset recordBytes wireBytes : Nat)
    (hrecord : recordBytes ≤ 4096)
    (hwire : wireBytes ≤ (3 * tickUpload [c3File offset recordBytes]) / 2 + 65536) :
    wireBytes < 196608 := by
  have h := c3_publication_bound offset recordBytes hrecord
  omega

theorem c3_is_strictly_cheaper_than_whole_file (offset recordBytes : Nat)
    (hrecord : recordBytes ≤ 4096) :
    tickUpload [c3File offset recordBytes] < 67108864 := by
  have h := c3_publication_bound offset recordBytes hrecord
  omega

/-! ## Attach: manifests plus eager whole-base materialization -/

def fileBaseCopy (f : FileDelta) : Nat :=
  if travelsWhole f then 0 else f.baseBytes

def fileDeltaCopy (f : FileDelta) : Nat :=
  filePayload f + if travelsWhole f then 0 else f.zeroOverrides * blockBytes

def baseCopies (files : List FileDelta) : Nat := (files.map fileBaseCopy).sum
def deltaCopies (files : List FileDelta) : Nat := (files.map fileDeltaCopy).sum

/-- M counts manifest records including overrides and metadata-only entries,
    not merely paths. These are local records, not M separate R2 GETs.
    classB counts layer probes only; lazy FUSE GETs are not predicted. -/
def attachCost (hasDelta : Bool) (records : Nat) (files : List FileDelta) : Cost :=
  { classA := 0, classB := layers hasDelta,
    bytes := if hasDelta then baseCopies files + deltaCopies files else 0,
    layersMounted := layers hasDelta,
    manifestRecords := if hasDelta then records else 0 }

def attachCostAt (_treeBytes _pending : Nat) (hasDelta : Bool)
    (records : Nat) (files : List FileDelta) : Cost :=
  attachCost hasDelta records files

theorem chain_attach_layer_setup (hasDelta : Bool)
    (records : Nat) (files : List FileDelta) :
    (attachCost hasDelta records files).layersMounted = layers hasDelta
      ∧ (attachCost hasDelta records files).classB = layers hasDelta := by
  simp [attachCost]

theorem chain_attach_reads_manifest (records : Nat) (files : List FileDelta) :
    (attachCost true records files).manifestRecords = records := rfl

theorem chain_attach_materializes_base_plus_delta (records : Nat) (files : List FileDelta) :
    (attachCost true records files).bytes = baseCopies files + deltaCopies files := rfl

theorem chain_attach_independent_of_n (n n' p : Nat) (hasDelta : Bool)
    (records : Nat) (files : List FileDelta) :
    attachCostAt n p hasDelta records files = attachCostAt n' p hasDelta records files := rfl

theorem chain_attach_independent_of_pending (n p p' : Nat) (hasDelta : Bool)
    (records : Nat) (files : List FileDelta) :
    attachCostAt n p hasDelta records files = attachCostAt n p' hasDelta records files := rfl

theorem attach_without_delta_materializes_nothing (records : Nat) (files : List FileDelta) :
    (attachCost false records files).bytes = 0
      ∧ (attachCost false records files).manifestRecords = 0 := by simp [attachCost]

theorem chunked_restore_copies_full_base (f : FileDelta) (h : travelsWhole f = false) :
    fileBaseCopy f = f.baseBytes := by simp [fileBaseCopy, h]

theorem c3_attach_copies_the_whole_64mib_base (offset recordBytes : Nat) :
    baseCopies [c3File offset recordBytes] = 67108864 := by
  simp only [baseCopies, List.map_cons, List.map_nil, List.sum_cons, List.sum_nil, Nat.add_zero]
  rw [chunked_restore_copies_full_base _ (c3_uses_chunked_publication offset recordBytes)]
  rfl

/-- A family of dense one-block edits with arbitrarily large bases defeats
    every proposed constant byte bound. Larger untouched-file populations
    are not needed for the counterexample. -/
theorem attach_materialization_has_no_constant_bound (bound : Nat) :
    ∃ f : FileDelta, bound < (attachCost true 1 [f]).bytes := by
  let f : FileDelta :=
    { size := bound + 65536, baseBytes := bound + 65536, holes := 0,
      changedChunks := 1, zeroOverrides := 0, recordBytes := 100 }
  refine ⟨f, ?_⟩
  have hw : travelsWhole f = false := by
    simp [travelsWhole, f, wholeThreshold]
  simp [attachCost, baseCopies, deltaCopies, fileBaseCopy, fileDeltaCopy,
    filePayload, hw, f, blockBytes]
  omega

def extractAttachCost (n : Nat) : Cost :=
  { classA := 0, classB := 1, bytes := n, layersMounted := 0 }

theorem extract_attach_is_linear_in_n (n : Nat) :
    (extractAttachCost n).bytes = n := rfl

def firstBaseCost (n excluded : Nat) : Cost :=
  { classA := 1, classB := 0, bytes := n - excluded, layersMounted := 0 }

theorem first_base_uploads_unexcluded_bytes (n excluded : Nat) :
    (firstBaseCost n excluded).bytes = n - excluded := rfl

theorem first_base_upper_bound (n excluded : Nat) :
    (firstBaseCost n excluded).bytes ≤ n := by simp [firstBaseCost]

/-! ## Rebase
    The trigger compares STORED archive bytes, not logical changed bytes.
    The amortization theorem remains conditional on n ≤ base + c in those
    same units; chunking/compression do not establish that premise. -/

def shouldRebase : Kind → Bool → Nat → Nat → Nat → Bool
  | .quiesce, true, c, base, k => decide (k * base < c)
  | _, _, _, _, _ => false

theorem tick_never_rebases (hasDelta : Bool) (c base k : Nat) :
    shouldRebase .tick hasDelta c base k = false :=
  rfl

theorem rebase_requires_the_delta_to_outgrow_k_base (c base k : Nat) :
    shouldRebase .quiesce true c base k = true ↔ k * base < c := by
  simp [shouldRebase]

/-- **The O(n) fold amortizes to fewer than `(1+k)/k` uploaded bytes per
    changed byte — AT A QUIESCE.**

    The hypothesis is `shouldRebase` itself, not the bare ratio, and
    that is the point: the predicate carries the quiesce condition, so
    the theorem cannot be read as "the amortization applies whenever the
    ratio trips". It applies when the rebase FIRES, and a rebase fires
    only at a quiesce. `n ≤ base + c` is an explicit bound in the same
    stored-byte units as the trigger; chunking and compression do not prove
    that premise. `n·k < c·(k+1)` states `n/c < (1+k)/k` without leaving Nat. -/
theorem rebase_amortizes_at_a_quiesce (base c n k : Nat)
    (_hk : 0 < k) (hfires : shouldRebase .quiesce true c base k = true)
    (hn : n ≤ base + c) :
    n * k < c * (k + 1) := by
  have htrig : k * base < c :=
    (rebase_requires_the_delta_to_outgrow_k_base c base k).mp hfires
  calc
    n * k ≤ (base + c) * k := Nat.mul_le_mul_right k hn
    _ = k * base + k * c := by
      rw [Nat.add_mul, Nat.mul_comm base, Nat.mul_comm c]
    _ < c + k * c := Nat.add_lt_add_right htrig (k * c)
    _ = c * (k + 1) := by
      rw [Nat.mul_comm k c, Nat.add_comm c (c * k)]
      exact (Nat.mul_succ c k).symm

/-- The rebase trigger does not change a tick's publication representation. -/
theorem a_tick_past_the_ratio_still_publishes_changed_blocks
    (c base k metadata : Nat) (files : List FileDelta) (_htrig : k * base < c) :
    shouldRebase .tick true c base k = false
      ∧ (tickCost files metadata).bytes = tickUpload files + metadata := ⟨rfl, rfl⟩

/-! ## Current generation, retained fallback, and named orphans -/

def referencedGenerations (fallback : Bool) : Nat :=
  if fallback then 2 else 1

theorem retained_generations_le_two (fallback : Bool) :
    referencedGenerations fallback ≤ 2 := by
  cases fallback <;> simp [referencedGenerations]

structure Generations where
  fallback : Bool := false
  named : Nat
  stored : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

def freshGenerations : Generations := { named := 0, stored := 1 }

inductive GenAction where
  | tick
  | rebase
  /-- A successful attach proves the current generation, retiring the fallback. -/
  | proveAttach
  | sweepOne
  deriving Repr, BEq, DecidableEq, Inhabited

/-- `supersedeGeneration` fills an empty fallback slot, never evicting the
    proven occupant merely because another unproven generation arrived. -/
def genStep (g : Generations) : GenAction → Generations
  | .tick => g
  | .rebase =>
      if g.fallback then { g with named := g.named + 1, stored := g.stored + 1 }
      else { g with fallback := true, stored := g.stored + 1 }
  | .proveAttach =>
      if g.fallback then { g with fallback := false, named := g.named + 1 } else g
  | .sweepOne =>
      if 0 < g.named then { g with named := g.named - 1, stored := g.stored - 1 } else g

def genRun (g : Generations) : List GenAction → Generations := List.foldl genStep g

def GenBounded (g : Generations) : Prop :=
  g.stored ≤ referencedGenerations g.fallback + g.named

theorem fresh_retention_is_bounded : GenBounded freshGenerations := by
  simp [GenBounded, freshGenerations, referencedGenerations]

theorem genStep_preserves_retention_bound (g : Generations) (a : GenAction)
    (h : GenBounded g) : GenBounded (genStep g a) := by
  cases a <;> cases hf : g.fallback <;>
    simp [genStep, hf, GenBounded, referencedGenerations] at h ⊢
  all_goals first | omega | (split <;> simp_all [GenBounded, referencedGenerations] <;> omega)

private theorem genRun_preserves (as : List GenAction) (g : Generations)
    (h : GenBounded g) : GenBounded (genRun g as) := by
  induction as generalizing g with
  | nil => exact h
  | cons a as ih => exact ih (genStep g a) (genStep_preserves_retention_bound g a h)

theorem stored_is_bounded_by_current_fallback_and_orphans (as : List GenAction) :
    GenBounded (genRun freshGenerations as) :=
  genRun_preserves as freshGenerations fresh_retention_is_bounded

theorem first_rebase_retains_a_fallback (g : Generations) (h : g.fallback = false) :
    (genStep g .rebase).fallback = true
      ∧ (genStep g .rebase).named = g.named
      ∧ (genStep g .rebase).stored = g.stored + 1 := by simp [genStep, h]

theorem further_rebase_names_one_generation (g : Generations) (h : g.fallback = true) :
    (genStep g .rebase).fallback = true
      ∧ (genStep g .rebase).named = g.named + 1
      ∧ (genStep g .rebase).stored = g.stored + 1 := by simp [genStep, h]

theorem proven_attach_retires_the_fallback (g : Generations) (h : g.fallback = true) :
    (genStep g .proveAttach).fallback = false
      ∧ (genStep g .proveAttach).named = g.named + 1
      ∧ (genStep g .proveAttach).stored = g.stored := by simp [genStep, h]

private theorem genRun_cons (g : Generations) (a : GenAction) (as : List GenAction) :
    genRun g (a :: as) = genRun (genStep g a) as := rfl

private theorem genRun_append (g : Generations) (as bs : List GenAction) :
    genRun g (as ++ bs) = genRun (genRun g as) bs := by
  simp [genRun, List.foldl_append]

theorem a_completed_sweep_leaves_current_and_fallback (m : Nat) (fallback : Bool) :
    genRun { fallback := fallback, named := m, stored := m + referencedGenerations fallback }
      (List.replicate m .sweepOne)
      = { fallback := fallback, named := 0, stored := referencedGenerations fallback } := by
  induction m with
  | zero => simp [genRun]
  | succ m ih =>
    rw [List.replicate_succ, genRun_cons]
    have hs : genStep { fallback := fallback, named := m + 1, stored := m + 1 + referencedGenerations fallback }
        GenAction.sweepOne =
        { fallback := fallback, named := m, stored := m + referencedGenerations fallback } := by
      simp [genStep]
      omega
    rw [hs]
    exact ih

theorem a_partial_sweep_preserves_retained_generations (m j : Nat) (fallback : Bool) :
    GenBounded (genRun { fallback := fallback, named := m, stored := m + referencedGenerations fallback }
      (List.replicate j .sweepOne)) := by
  apply genRun_preserves
  simp [GenBounded, Nat.add_comm]

/-- After the first rebase fills the fallback, every further unswept rebase
    names one more orphan. Keeping a fallback does not impose a total cap. -/
theorem without_a_sweep_current_fallback_and_orphans_grow (m : Nat) :
    genRun freshGenerations (List.replicate (m + 1) .rebase)
      = { fallback := true, named := m, stored := m + 2 } := by
  induction m with
  | zero => rfl
  | succ m ih =>
    rw [List.replicate_succ', genRun_append, ih]
    rfl

/-- `shouldCheckpoint`: an unchanged work directory costs no archive. -/
def shouldCheckpoint (unchanged : Bool) : Bool := !unchanged

theorem unchanged_tick_uploads_nothing :
    shouldCheckpoint true = false :=
  rfl

/-! ### The loss window

  What a crash loses, in wall-clock terms: exactly the writes since
  the last completed tick. The tick's model is the fingerprint gate
  as shipped (packages/devbox/src/snapshot-chain.ts#shouldCheckpoint): a tick
  that completes saves the model's eligible writes before it, because the gate
  commits whenever it cannot prove "unchanged" — it never skips a
  changed tree. The red direction models the deployed 2026-08-25
  defect exactly: a tick that misclassifies a changed tree as
  unchanged saves nothing, and no number of such ticks closes the
  window. -/

/-- Workload writes against tick-saved progress. `written` counts writes to
    included durable paths, not deliberately excluded trees; `saved` counts what a completed
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

def replaySkipping (b : Backlog) : List Beat → Backlog :=
  List.foldl beatSkipping b

/-- Any number of skipping ticks leaves the crash loss unchanged. -/
theorem skipped_ticks_preserve_loss (b : Backlog) (ticks : Nat) :
    (replaySkipping b (List.replicate ticks Beat.tick)).loss = b.loss := by
  induction ticks with
  | zero => simp [replaySkipping]
  | succ ticks ih =>
    rw [List.replicate_succ, replaySkipping, List.foldl_cons, ← replaySkipping]
    exact ih

/-- **No cadence of skipping ticks closes the window.** Once one write
    is accepted, any finite number of ticks that lie about unchanged
    state leave that write exposed to a crash. -/
theorem no_number_of_skipping_ticks_closes_the_window (ticks : Nat) :
    (replaySkipping (beatSkipping Backlog.start .write)
      (List.replicate ticks Beat.tick)).loss = 1 := by
  rw [skipped_ticks_preserve_loss]
  decide

/-- **Remove the gate and the window never closes**: a write followed
    by a completed-but-skipping tick still shows loss, so no tick
    cadence bounds what a crash costs. -/
theorem a_skipping_tick_leaves_the_window_open :
    (beatSkipping (beatSkipping Backlog.start .write) .tick).loss = 1 := by
  decide
end Kinu.Storage.SnapshotChain

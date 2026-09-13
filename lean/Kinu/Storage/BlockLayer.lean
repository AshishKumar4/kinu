/-
  Read-only v2 block composition. Source: devbox/src/delta-index.ts,
  chunked-delta.ts#buildDeltaAttachOps, snapshot-chain.ts#attachChainOnce,
  and block-lower/src/{index,model,storage,main}.rs.

  Counted work is record/page processing, not elapsed time or kernel IO.
  Metadata costs have explicit bounded-record premises (platform path limits).
  Authentication assumes a page accepted by the digest check is the named
  immutable page; this model does not prove SHA-256 collision resistance.
  Service-demanded reads, writable opens and unsynced mappings are outside
  storage attachment. Publication keeps SnapshotChain's conditional bounds.
-/
import Kinu.Storage.SnapshotChain
import Init.Data.Nat.Log2

namespace Kinu.Storage.BlockLayer

inductive Operation where
  | metadata (work : Nat)
  | payload (bytes : Nat)
  deriving DecidableEq

def metadataWork : List Operation → Nat
  | [] => 0
  | .metadata n :: rest => n + metadataWork rest
  | .payload _ :: rest => metadataWork rest

def payloadBytes : List Operation → Nat
  | [] => 0
  | .metadata _ :: rest => payloadBytes rest
  | .payload n :: rest => n + payloadBytes rest

def attachPlan (setup : Nat) (files names layers : List Nat) : List Operation :=
  .metadata setup :: (files ++ names ++ layers).map Operation.metadata

private theorem metadata_map (xs : List Nat) :
    metadataWork (xs.map Operation.metadata) = xs.sum := by
  induction xs with
  | nil => rfl
  | cons x xs ih => simp [metadataWork, ih]

private theorem bounded_sum (xs : List Nat) (b : Nat) (h : ∀ x ∈ xs, x ≤ b) :
    xs.sum ≤ b * xs.length := by
  induction xs with
  | nil => simp
  | cons x xs ih =>
    have hx := h x (by simp)
    have hr := ih (fun y hy => h y (by simp [hy]))
    simp only [List.sum_cons, List.length_cons, Nat.mul_add, Nat.mul_one]
    omega

private theorem append_sum (xs ys : List Nat) : (xs ++ ys).sum = xs.sum + ys.sum := by
  induction xs with
  | nil => simp
  | cons x xs ih => simp [ih, Nat.add_assoc]

theorem attach_metadata_bound (a b c : Nat) (files names layers : List Nat)
    (hf : ∀ n ∈ files, n ≤ b) (hh : ∀ n ∈ names, n ≤ b)
    (hl : ∀ n ∈ layers, n ≤ c) :
    metadataWork (attachPlan a files names layers)
      ≤ a + b * (files.length + names.length) + c * layers.length := by
  have f := bounded_sum files b hf
  have h := bounded_sum names b hh
  have l := bounded_sum layers c hl
  change a + metadataWork ((files ++ names ++ layers).map Operation.metadata) ≤ _
  rw [metadata_map, append_sum, append_sum]
  simp only [Nat.mul_add]
  omega

theorem attach_payload_bytes (a : Nat) (files names layers : List Nat) :
    payloadBytes (attachPlan a files names layers) = 0 := by
  have zero (xs : List Nat) : payloadBytes (xs.map Operation.metadata) = 0 := by
    induction xs with
    | nil => rfl
    | cons x xs ih => simp [payloadBytes, ih]
  exact zero (files ++ names ++ layers)

/-- Maximum median-search depth: each visited page halves the rank interval. -/
def depth (k : Nat) : Nat :=
  if k = 0 then 0 else depth (k / 2) + 1
termination_by k
decreasing_by exact Nat.div_lt_self (by omega) (by decide)

private theorem depth_mono (n : Nat) : ∀ m, m ≤ n → depth m ≤ depth n := by
  induction n using Nat.strongRecOn with
  | ind n ih =>
    intro m hmn
    by_cases hn : n = 0
    · have hm : m = 0 := by omega
      simp [hn, hm]
    by_cases hm : m = 0
    · rw [hm, depth, if_pos rfl]
      exact Nat.zero_le _
    conv => lhs; rw [depth, if_neg hm]
    conv => rhs; rw [depth, if_neg hn]
    have half : n / 2 < n := Nat.div_lt_self (by omega) (by decide)
    have hmhalf : m / 2 ≤ n / 2 := by omega
    have hr := ih (n / 2) half (m / 2) hmhalf
    omega

private theorem depth_log (k : Nat) (hk : k > 0) : depth k = Nat.log2 k + 1 := by
  induction k using Nat.strongRecOn with
  | ind k ih =>
    by_cases small : k < 2
    · have one : k = 1 := by omega
      subst k
      rw [depth, if_neg (by decide : ¬1 = 0)]
      change depth 0 + 1 = Nat.log2 1 + 1
      rw [depth, if_pos rfl, Nat.log2, if_neg (by decide : ¬1 ≥ 2)]
    have half : k / 2 < k := Nat.div_lt_self hk (by decide)
    have positive : k / 2 > 0 := by omega
    rw [depth, if_neg (by omega), ih (k / 2) half positive]
    conv => rhs; rw [Nat.log2, if_pos (by omega)]

/-- The integer ceiling of log₂(n), written using Lean's floor logarithm. -/
def ceilLog2 (n : Nat) : Nat := if n ≤ 1 then 0 else Nat.log2 (n - 1) + 1

inductive LookupTrace : Nat → Nat → Prop where
  | empty : LookupTrace 0 0
  | stop (k : Nat) (positive : k > 0) : LookupTrace k 1
  | next (k child reads : Nat) (positive : k > 0) (half : child ≤ k / 2)
      (tail : LookupTrace child reads) : LookupTrace k (reads + 1)

private theorem trace_bound (k reads : Nat) (trace : LookupTrace k reads) :
    reads ≤ ceilLog2 (k + 1) := by
  have bounded : reads ≤ depth k := by
    induction trace with
    | empty => simp [depth]
    | stop k hp => rw [depth, if_neg (by omega)]; omega
    | next k child reads hp hh tail ih =>
      have hm := depth_mono (k / 2) child hh
      rw [depth, if_neg (by omega)]
      omega
  by_cases hk : k = 0
  · simpa [hk, ceilLog2, depth] using bounded
  · simpa [ceilLog2, hk, depth_log k (by omega)] using bounded

inductive Source where
  | hole
  | chunk (id : Nat)
  deriving DecidableEq

structure Entry where
  offset : Nat
  source : Source
  deriving DecidableEq

inductive Index where
  | empty
  | page (entry : Entry) (left right : Index)

def entries : Index → List Entry
  | .empty => []
  | .page e left right => entries left ++ e :: entries right

def linearLookup (key : Nat) : List Entry → Option Source
  | [] => none
  | e :: rest => if key = e.offset then some e.source else linearLookup key rest

def lookup (key : Nat) : Index → Option Source
  | .empty => none
  | .page e left right =>
    if key = e.offset then some e.source
    else if key < e.offset then lookup key left else lookup key right

def treeCount : Index → Nat
  | .empty => 0
  | .page _ left right => treeCount left + treeCount right + 1

def pageReads (key : Nat) : Index → Nat
  | .empty => 0
  | .page e left right =>
    if key = e.offset then 1
    else if key < e.offset then pageReads key left + 1 else pageReads key right + 1

def Balanced : Index → Prop
  | .empty => True
  | .page _ left right => Balanced left ∧ Balanced right ∧
      treeCount left ≤ (treeCount left + treeCount right + 1) / 2 ∧
      treeCount right ≤ (treeCount left + treeCount right + 1) / 2

theorem median_children_half (k : Nat) : k / 2 ≤ k / 2 ∧ k - k / 2 - 1 ≤ k / 2 := by omega

private theorem lookup_trace (tree : Index) (key : Nat) (balanced : Balanced tree) :
    LookupTrace (treeCount tree) (pageReads key tree) := by
  induction tree with
  | empty => exact LookupTrace.empty
  | page e left right il ir =>
    obtain ⟨hl, hr, leftHalf, rightHalf⟩ := balanced
    simp only [pageReads, treeCount]
    split
    · exact LookupTrace.stop _ (by omega)
    · split
      · exact LookupTrace.next _ _ _ (by omega) leftHalf (il hl)
      · exact LookupTrace.next _ _ _ (by omega) rightHalf (ir hr)

theorem block_lookup_bound (tree : Index) (key : Nat) (balanced : Balanced tree) :
    pageReads key tree ≤ ceilLog2 (treeCount tree + 1) :=
  trace_bound _ _ (lookup_trace tree key balanced)

def Ordered : Index → Prop
  | .empty => True
  | .page e left right => Ordered left ∧ Ordered right ∧
      (∀ x ∈ entries left, x.offset < e.offset) ∧
      (∀ x ∈ entries right, e.offset < x.offset)

private theorem lookup_append (key : Nat) (xs ys : List Entry) :
    linearLookup key (xs ++ ys) = (linearLookup key xs).orElse (fun _ => linearLookup key ys) := by
  induction xs with
  | nil => rfl
  | cons x xs ih => simp [linearLookup]; split <;> simp_all [Option.orElse]

private theorem missing_lookup (key : Nat) (xs : List Entry)
    (h : ∀ x ∈ xs, key ≠ x.offset) : linearLookup key xs = none := by
  induction xs with
  | nil => rfl
  | cons x xs ih =>
    have hx := h x (by simp)
    have hr := ih (fun y hy => h y (by simp [hy]))
    simp [linearLookup, hx, hr]

private theorem lookup_correct (tree : Index) (key : Nat) (ordered : Ordered tree) :
    lookup key tree = linearLookup key (entries tree) := by
  induction tree with
  | empty => rfl
  | page e left right il ir =>
    obtain ⟨hl, hr, less, greater⟩ := ordered
    rw [entries, lookup_append]
    by_cases equal : key = e.offset
    · have noLeft := missing_lookup key (entries left) (by
        intro x hx; have h := less x hx; omega)
      rw [noLeft]
      simp [lookup, linearLookup, equal, Option.orElse]
    by_cases lower : key < e.offset
    · have noRight := missing_lookup key (entries right) (by
        intro x hx; have h := greater x hx; omega)
      simp [lookup, linearLookup, equal, lower, noRight, il hl, Option.orElse]
      cases linearLookup key (entries left) <;> rfl
    · have noLeft := missing_lookup key (entries left) (by
        intro x hx; have h := less x hx; omega)
      simp [lookup, linearLookup, equal, lower, noLeft, ir hr, Option.orElse]

def byteAt (base : Nat → UInt8) (baseSize : Nat) (blobs : Nat → Nat → UInt8)
    (source : Option Source) (position : Nat) : UInt8 :=
  match source with
  | some .hole => 0
  | some (.chunk id) => blobs id (position % SnapshotChain.blockBytes)
  | none => if position < baseSize then base position else 0

def composedRead (tree : Index) (base : Nat → UInt8) (baseSize size : Nat)
    (blobs : Nat → Nat → UInt8) (offset length : Nat) : List UInt8 :=
  (List.range (min length (size - offset))).map fun n =>
    byteAt base baseSize blobs (lookup ((offset + n) / SnapshotChain.blockBytes) tree) (offset + n)

def specifiedRead (records : List Entry) (base : Nat → UInt8) (baseSize size : Nat)
    (blobs : Nat → Nat → UInt8) (offset length : Nat) : List UInt8 :=
  (List.range (min length (size - offset))).map fun n =>
    byteAt base baseSize blobs (linearLookup ((offset + n) / SnapshotChain.blockBytes) records) (offset + n)

theorem composed_read_correct (tree : Index) (ordered : Ordered tree)
    (base : Nat → UInt8) (baseSize size : Nat) (blobs : Nat → Nat → UInt8) (offset length : Nat) :
    composedRead tree base baseSize size blobs offset length =
      specifiedRead (entries tree) base baseSize size blobs offset length := by
  simp only [composedRead, specifiedRead, lookup_correct tree _ ordered]

theorem hole_is_zero (base : Nat → UInt8) (baseSize position : Nat) (blobs : Nat → Nat → UInt8) :
    byteAt base baseSize blobs (some .hole) position = 0 := rfl

theorem absent_override_reads_base (base : Nat → UInt8) (baseSize position : Nat) (blobs : Nat → Nat → UInt8) :
    byteAt base baseSize blobs none position = (if position < baseSize then base position else 0) := rfl

structure Mounts where
  generation : Nat
  store : Option Nat := none
  base : Option Nat := none
  delta : Option Nat := none
  block : Option Nat := none
  overlay : Option Nat := none
  ready : Bool := false
  deriving DecidableEq

def Complete (s : Mounts) : Prop :=
  s.store = some s.generation ∧ s.base = some s.generation ∧
  s.delta = some s.generation ∧ s.block = some s.generation ∧ s.overlay = some s.generation

instance (s : Mounts) : Decidable (Complete s) := inferInstanceAs (Decidable (_ ∧ _ ∧ _ ∧ _ ∧ _))

inductive Action where
  | store (generation : Nat)
  | base (generation : Nat)
  | delta (generation : Nat)
  | block (generation : Nat)
  | overlay (generation : Nat)
  | replace (generation : Nat)
  | prove

def step (s : Mounts) : Action → Mounts
  | .store g => { s with store := some g, ready := false }
  | .base g => { s with base := some g, ready := false }
  | .delta g => { s with delta := some g, ready := false }
  | .block g => { s with block := some g, ready := false }
  | .overlay g => { s with overlay := some g, ready := false }
  | .replace g => { generation := g }
  | .prove => { s with ready := decide (Complete s) }

private theorem ready_step (s : Mounts) (a : Action) :
    (step s a).ready = true → Complete (step s a) := by
  cases a <;> simp [step, Complete]

theorem ready_implies_all_composed_mounted (generation : Nat) (actions : List Action) :
    (actions.foldl step { generation := generation }).ready = true →
      Complete (actions.foldl step { generation := generation }) := by
  have go (s : Mounts) (as : List Action) (h : s.ready = true → Complete s) :
      (as.foldl step s).ready = true → Complete (as.foldl step s) := by
    induction as generalizing s with
    | nil => exact h
    | cons a as ih => exact ih (step s a) (ready_step s a)
  exact go _ _ (by simp)

def copyupBytes (fileSize requested : Nat) : Nat := min requested fileSize

theorem copyup_is_file_local (fileSize largest requested : Nat) (h : fileSize ≤ largest) :
    copyupBytes fileSize requested ≤ fileSize ∧ copyupBytes fileSize requested ≤ largest := by
  have fileLocal := Nat.min_le_right requested fileSize
  exact ⟨fileLocal, Nat.le_trans fileLocal h⟩

theorem publication_accounting_unchanged (f : SnapshotChain.FileDelta)
    (h : SnapshotChain.travelsWhole f = false) :
    SnapshotChain.filePublication f = f.changedChunks * SnapshotChain.blockBytes + f.recordBytes :=
  SnapshotChain.chunked_file_publishes_blocks_and_record f h

theorem c3_publication_stays_bounded (offset recordBytes wireBytes : Nat)
    (recordBound : recordBytes ≤ 4096)
    (wireBound : wireBytes ≤ (3 * SnapshotChain.tickUpload [SnapshotChain.c3File offset recordBytes]) / 2 + 65536) :
    wireBytes < 196608 := SnapshotChain.c3_wire_bound offset recordBytes wireBytes recordBound wireBound

end Kinu.Storage.BlockLayer

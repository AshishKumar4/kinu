/-
  Kinu.Storage.SqliteFSCorrectness — VFS write/read roundtrip. 0 sorry, 0 axioms.
  Models: packages/agent-utils/src/vfs/sqlite.ts

  -- Model assumption:
  The list-based `FS` below models the `vfs_files` SQLite table (newest row
  wins per path; DO SQLite executes statements serially, so there are no
  interleaved partial writes). That table↔model correspondence is trusted, not
  proved; it is exercised by packages/agent-utils/tests/vfs-interop.test.ts
  ("writeVfsFileSync ↔ SqliteFS interop") and
  packages/cli-backend/tests/vfs-blob.test.ts ("SqliteFS BLOB round-trip").
  Everything stated in this file is proved outright — the former
  `chunk_reassembly` and `writes_commute` axioms are now theorems. (The old
  String-based chunk_reassembly axiom was in fact false — it mixed char-count
  String.length with byte-offset String.Pos; see
  scratch-verification/BoomChunkReassembly.lean, which still tries to state that
  counterexample against the theorem below and must never compile. The TS slices
  bytes, so the faithful model below chunks a byte list.)
-/

namespace Kinu.Storage.SqliteFSCorrectness

inductive Entry where
  | dir
  | file (data : String)
  deriving Repr, BEq, Inhabited

abbrev FS := List (String × Entry)

def writeFile (fs : FS) (path data : String) : FS :=
  (path, Entry.file data) :: fs.filter (fun p => p.1 ≠ path)

def readFile (fs : FS) (path : String) : Option String :=
  match fs.find? (fun p => p.1 == path) with
  | some (_, .file data) => some data
  | _ => none

def mkdir (fs : FS) (path : String) : FS :=
  if fs.any (fun p => p.1 == path) then fs
  else (path, Entry.dir) :: fs

def unlink (fs : FS) (path : String) : FS :=
  fs.filter (fun p => p.1 ≠ path)

/-- Write then read roundtrip. sqlite.ts:105-151 → 71-103 -/
theorem write_read_roundtrip (fs : FS) (path data : String) :
    readFile (writeFile fs path data) path = some data := by
  simp [writeFile, readFile, List.find?, BEq.beq]

/-- mkdir is idempotent. sqlite.ts:252 INSERT OR IGNORE -/
theorem mkdir_idempotent (fs : FS) (path : String) :
    mkdir (mkdir fs path) path = mkdir fs path := by
  simp [mkdir]; split <;> simp_all [List.any, BEq.beq, decide_eq_true_eq]

/-! ## Chunked storage (sqlite.ts:17-18, 93-104 write; 93-98 read reassembly)

Files larger than CHUNK_SIZE are stored as byte slices
`bytes.slice(i·CS, min((i+1)·CS, totalSize))` for `i < ⌈totalSize/CS⌉` and
reassembled by concatenation in chunk_index order. Bytes are modeled as
`List UInt8`; `take` clamps at the end of the list, which is exactly the
`min(·, totalSize)` in the TS.

Test-coverage note (2026-07-13): no TS test actually writes more than
CHUNK_SIZE (1.8 MB) — packages/cli-backend/tests/vfs-blob.test.ts:33
("large content spanning multiple chunks round-trips") writes only 200 KB,
which fits in one chunk. The multi-chunk read path is exercised in
production only; flagged in the WP-F2 report. -/

/-- ⌈len / k⌉ — the number of chunks written for a file of `len` bytes.
    (The TS `Math.max(1, ·)` writes one empty chunk for an empty file so that
    chunk 0 exists to carry metadata; reassembly is unaffected.) -/
def chunkCount (len k : Nat) : Nat := (len + k - 1) / k

/-- The i-th chunk: bytes.slice(i·k, min((i+1)·k, len)). -/
def chunkAt (bytes : List UInt8) (k i : Nat) : List UInt8 :=
  (bytes.drop (i * k)).take k

def chunksOf (bytes : List UInt8) (k : Nat) : List (List UInt8) :=
  (List.range (chunkCount bytes.length k)).map (chunkAt bytes k)

theorem chunkCount_drop (len k n : Nat) (hk : 0 < k)
    (h : chunkCount len k = n + 1) : chunkCount (len - k) k = n := by
  unfold chunkCount at *
  have hlen : 0 < len := by
    rcases Nat.eq_zero_or_pos len with hz | hp
    · subst hz; rw [Nat.div_eq_of_lt (by omega)] at h; omega
    · exact hp
  by_cases hlk : len ≤ k
  · have h1 : len + k - 1 = (len - 1) + k := by omega
    rw [h1, Nat.add_div_right _ hk, Nat.div_eq_of_lt (by omega)] at h
    have hn : n = 0 := by omega
    have h2 : len - k = 0 := by omega
    rw [h2, hn, Nat.div_eq_of_lt (by omega)]
  · have h1 : len + k - 1 = (len - 1) + k := by omega
    rw [h1, Nat.add_div_right _ hk] at h
    have h2 : len - k + k - 1 = len - 1 := by omega
    rw [h2]
    omega

/-- Multi-chunk reassembly (formerly an axiom — and a false one, stated over
    String byte-positions): slicing a byte list into ⌈len/k⌉ chunks of k bytes
    and concatenating them in order reproduces the original bytes exactly. -/
theorem chunk_reassembly (k : Nat) (hk : 0 < k) :
    ∀ (n : Nat) (bytes : List UInt8), chunkCount bytes.length k = n →
      (chunksOf bytes k).flatten = bytes := by
  intro n
  induction n with
  | zero =>
    intro bytes h
    have hz : bytes.length = 0 := by
      rcases Nat.eq_zero_or_pos bytes.length with hz | hp
      · exact hz
      · exfalso
        unfold chunkCount at h
        have h1 : bytes.length + k - 1 = (bytes.length - 1) + k := by omega
        rw [h1, Nat.add_div_right _ hk] at h
        exact Nat.succ_ne_zero _ h
    have hnil : bytes = [] := List.eq_nil_of_length_eq_zero hz
    subst hnil
    have hc : chunkCount 0 k = 0 := Nat.div_eq_of_lt (by omega)
    simp [chunksOf, hc]
  | succ n ih =>
    intro bytes h
    have hcount : chunkCount (bytes.drop k).length k = n := by
      rw [List.length_drop]
      exact chunkCount_drop bytes.length k n hk h
    have hrange : List.range (n + 1) = 0 :: (List.range n).map (· + 1) :=
      List.range_succ_eq_map n
    have hshift : ∀ i, chunkAt bytes k (i + 1) = chunkAt (bytes.drop k) k i := by
      intro i
      simp only [chunkAt, List.drop_drop]
      rw [Nat.succ_mul, Nat.add_comm (i * k) k]
    have hlist : chunksOf bytes k
        = chunkAt bytes k 0 :: (List.range n).map (chunkAt (bytes.drop k) k) := by
      simp only [chunksOf, h, hrange, List.map_cons, List.map_map, Function.comp_def]
      exact congrArg _ (List.map_congr_left fun i _ => hshift i)
    calc (chunksOf bytes k).flatten
        = bytes.take k ++ ((List.range n).map (chunkAt (bytes.drop k) k)).flatten := by
          rw [hlist, List.flatten_cons]
          simp [chunkAt]
      _ = bytes.take k ++ (chunksOf (bytes.drop k) k).flatten := by
          rw [chunksOf, hcount]
      _ = bytes.take k ++ bytes.drop k := by rw [ih (bytes.drop k) hcount]
      _ = bytes := List.take_append_drop k bytes

/-- Distinct-path writes do not clobber each other (formerly the
    "DO SQLite serialized writes" axiom — provable outright in the model;
    the serialization itself is part of the file-header model assumption). -/
theorem writes_commute (fs : FS) (p1 p2 d1 d2 : String) (h : p1 ≠ p2) :
    readFile (writeFile (writeFile fs p1 d1) p2 d2) p1 = some d1 := by
  simp [writeFile, readFile, List.find?, List.filter, h, Ne.symm h]

end Kinu.Storage.SqliteFSCorrectness

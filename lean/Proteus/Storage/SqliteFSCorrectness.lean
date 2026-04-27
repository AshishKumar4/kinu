/-
  Proteus.Storage.SqliteFSCorrectness — VFS write/read roundtrip.
  Models: packages/agent-utils/src/vfs/sqlite.ts
-/

namespace Proteus.Storage.SqliteFSCorrectness

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

/-- Multi-chunk reassembly axiom. sqlite.ts:137-150, 93-98 -/
axiom chunk_reassembly (data : String) (chunkSize : Nat) (hpos : chunkSize > 0) :
  let n := (data.length + chunkSize - 1) / chunkSize
  let chunks := (List.range n).map fun i =>
    data.extract ⟨i * chunkSize⟩ ⟨min ((i + 1) * chunkSize) data.length⟩
  String.join chunks = data

/-- DO SQLite serialized writes axiom. -/
axiom writes_commute (fs : FS) (p1 p2 d1 d2 : String) (h : p1 ≠ p2) :
  readFile (writeFile (writeFile fs p1 d1) p2 d2) p1 = some d1

end Proteus.Storage.SqliteFSCorrectness

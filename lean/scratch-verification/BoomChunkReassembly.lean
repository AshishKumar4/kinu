/-
  Negative regression probe — CHUNK REASSEMBLY FAMILY. This file must NEVER
  compile.

  The theorem below is a machine-checked proof of `False` derived from the
  String-based `chunk_reassembly` axiom that once lived in
  `Kinu/Storage/SqliteFSCorrectness.lean` (removed in WP-F2, 2026-07-13). That
  axiom was not merely convenient, it was FALSE: it mixed char-count
  `String.length` with byte-offset `String.Pos`, so for data = "éé" and
  chunkSize = 2 it claimed `join ["é"] = "éé"`. (Also refuted by e.g. ("éab", 1)
  and ("héllo wörld", 1).)

  ITS SUBJECT MODULE STILL EXISTS, which is why this family needs its own file
  and is the reason the split was not cosmetic. `Kinu.Storage.SqliteFSCorrectness`
  is present and still exports a `chunk_reassembly` — now a theorem, stated over
  a `List UInt8` with a `(k : Nat) (hk : 0 < k)` signature that is true. While
  this proof sat in `Boom.lean` beside the Float probes, `lake env lean` never
  reached it: the file's first import named the deleted
  `Kinu/Safety/FloatAxioms.lean` and elaboration stopped there. So a
  reintroduced String-based axiom would have derived `False` here and
  `check-no-false.sh` would still have reported OK, on the strength of an import
  error about an unrelated family.

  THE EXPECTED FAILURE IS DECLARED. This must fail as an APPLICATION TYPE
  MISMATCH on `chunk_reassembly` — the current theorem takes a `Nat` where the
  old axiom took a `String`, so the old counterexample cannot even be stated
  against it. `check-no-false.sh` holds the diagnostic to that, so a probe that
  fails for some other reason is reported as stale rather than counted as
  evidence.

  Historical record: this proof compiled against the library as of origin/main
  f9f6551.
-/

import Kinu.Storage.SqliteFSCorrectness

theorem boom_chunk_reassembly : False := by
  have h := Kinu.Storage.SqliteFSCorrectness.chunk_reassembly "éé" 2 (by decide)
  have hb := congrArg String.data h
  have hne : (String.join ((List.range ((("éé" : String).length + 2 - 1) / 2)).map fun i =>
      ("éé" : String).extract ⟨i * 2⟩ ⟨min ((i + 1) * 2) ("éé" : String).length⟩)).data
      ≠ ("éé" : String).data := by native_decide
  exact hne hb

/-
  Negative regression gate — this file must NEVER compile.

  Each theorem below is a machine-checked proof of `False` derived from an
  axiom that once lived in the Proteus corpus (removed in WP-F2, 2026-07-13).
  If this file compiles, the library is inconsistent again — every theorem in
  the corpus becomes vacuously derivable. `check-no-false.sh` runs this file
  and fails CI the moment it starts compiling.

  Historical record: all four proofs compiled against the library as of
  origin/main f9f6551 (Safety/FloatAxioms.lean + the String-based
  chunk_reassembly axiom in Storage/SqliteFSCorrectness.lean).
-/

import Proteus.Safety.FloatAxioms
import Proteus.Storage.SqliteFSCorrectness
open Proteus.Safety.FloatAxioms

-- Counterexample 1: x + 0 = x is false for x = -0.0 (IEEE: -0.0 + +0.0 = +0.0)
theorem boom_add_zero : False := by
  have h : (-0.0 : Float) + (0 : Float) = (-0.0 : Float) := float_add_zero (-0.0)
  have hb : ((-0.0 : Float) + (0 : Float)).toBits = (-0.0 : Float).toBits := congrArg Float.toBits h
  have hne : ((-0.0 : Float) + (0 : Float)).toBits ≠ (-0.0 : Float).toBits := by native_decide
  exact hne hb

-- Counterexample 2: x / y * y = x is false under rounding (x=1, y=49)
theorem boom_div_mul : False := by
  have h : (1.0 : Float) / (49.0 : Float) * (49.0 : Float) = (1.0 : Float) :=
    float_div_mul_cancel 1.0 49.0 (fun h => absurd (congrArg Float.toBits h) (by native_decide))
  have hb := congrArg Float.toBits h
  have hne : ((1.0 : Float) / (49.0 : Float) * (49.0 : Float)).toBits ≠ (1.0 : Float).toBits := by native_decide
  exact hne hb

-- Counterexample 3: 0 / x = 0 is false for x = 0 (0/0 = NaN)
theorem boom_zero_div : False := by
  have h : (0 : Float) / (0 : Float) = (0 : Float) := float_zero_div 0
  have hb := congrArg Float.toBits h
  have hne : ((0 : Float) / (0 : Float)).toBits ≠ (0 : Float).toBits := by native_decide
  exact hne hb

-- Counterexample 4: the String-based chunk_reassembly axiom mixed char-count
-- String.length with byte-offset String.Pos; for data = "éé", chunkSize = 2 it
-- claims join ["é"] = "éé". (Also refuted by e.g. ("éab", 1), ("héllo wörld", 1).)
theorem boom_chunk_reassembly : False := by
  have h := Proteus.Storage.SqliteFSCorrectness.chunk_reassembly "éé" 2 (by decide)
  have hb := congrArg String.data h
  have hne : (String.join ((List.range ((("éé" : String).length + 2 - 1) / 2)).map fun i =>
      ("éé" : String).extract ⟨i * 2⟩ ⟨min ((i + 1) * 2) ("éé" : String).length⟩)).data
      ≠ ("éé" : String).data := by native_decide
  exact hne hb

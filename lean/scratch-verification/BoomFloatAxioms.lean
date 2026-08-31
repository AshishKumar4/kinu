/-
  Negative regression probe — FLOAT AXIOM FAMILY. This file must NEVER compile.

  Each theorem below is a machine-checked proof of `False` derived from one of
  the IEEE-754 Float axioms that once lived in `Kinu/Safety/FloatAxioms.lean`
  (removed in WP-F2, 2026-07-13). If this file compiles, someone reintroduced a
  convenient Float axiom and the corpus is inconsistent again — every theorem in
  it becomes vacuously derivable.

  ONE FAMILY PER FILE, and that split is the point. All four counterexamples
  used to live in `Boom.lean` behind two imports, and
  `Kinu/Safety/FloatAxioms.lean` no longer exists — so `lake env lean` failed at
  line 15 resolving that import and checked NOTHING after it. The
  chunk_reassembly counterexample, whose subject module is still present and
  still exports a `chunk_reassembly`, had been unreachable ever since: a
  reintroduced String-based axiom would have derived `False` and the gate would
  still have reported OK, because the file "did not compile". A negative proof
  that cannot be reached is not a negative proof.

  THE EXPECTED FAILURE IS DECLARED, not merely awaited. `check-no-false.sh`
  requires this file to fail AND requires the diagnostic to be the missing
  `Kinu.Safety.FloatAxioms` module. A failure for any other reason — a typo, a
  renamed lemma, a syntax error introduced while editing — is a STALE PROBE and
  fails the gate by name, because "it didn't compile" was satisfied by all of
  those equally.

  Historical record: all three proofs compiled against the library as of
  origin/main f9f6551.
-/

import Kinu.Safety.FloatAxioms
open Kinu.Safety.FloatAxioms

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

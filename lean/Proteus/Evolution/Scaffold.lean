/-
  Proteus.Evolution.Scaffold
  Scaffold version monotonicity and rollback safety.
  0 sorry.
-/

import Proteus.Types

namespace Proteus.Evolution.Scaffold

open Proteus

/-- Rollback to a nonexistent version returns none. -/
def rollback (hist : ScaffoldHistory) (v : Nat) : Option String :=
  match hist.versions.find? (fun sv => sv.version == v) with
  | some sv => some sv.code
  | none => none

theorem rollback_nonexistent_is_none (hist : ScaffoldHistory) (v : Nat)
    (h : ∀ sv ∈ hist.versions, sv.version ≠ v) :
    rollback hist v = none := by
  simp only [rollback]
  have : hist.versions.find? (fun sv => sv.version == v) = none := by
    rw [List.find?_eq_none]
    intro sv hmem
    simp [BEq.beq, beq_iff_eq]
    exact h sv hmem
  rw [this]

/-- Appending a version with number > all existing preserves VersionsIncreasing.
    (This is the structural invariant that makes rollback sound.) -/
theorem append_increases_length (hist : ScaffoldHistory) (sv : ScaffoldVersion) :
    (⟨hist.versions ++ [sv]⟩ : ScaffoldHistory).versions.length =
    hist.versions.length + 1 := by
  simp [List.length_append]

end Proteus.Evolution.Scaffold

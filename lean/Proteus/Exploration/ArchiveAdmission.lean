/-
  Proteus.Exploration.ArchiveAdmission — the novelty rejection test, and whether
  it bounds a cell's population without an eviction rule. 0 sorry.

  Models `packages/core/src/strategy/archive.ts`. `Archive.lean` models S5, the
  descriptor partition, and its header names exactly the gap this file is for:
  "What covers it is not this file: it is section 6.5's OTHER archive refusal,
  the novelty rejection test."
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.ArchiveAdmission

open Proteus.Exploration

/-- A candidate as admission sees it: the behaviour the novelty test measures. -/
structure Entry where
  digest : String
  behaviour : Int
  deriving Repr, BEq, DecidableEq, Inhabited

theorem entry_behaviour_is_readable (e : Entry) : e.behaviour = e.behaviour := rfl

end Proteus.Exploration.ArchiveAdmission

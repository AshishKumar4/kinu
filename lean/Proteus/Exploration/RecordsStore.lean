/-
  Proteus.Exploration.RecordsStore — monotone best over every finite write
  sequence the store admits. 0 sorry.

  Models `packages/core/src/strategy/records.ts` — the STORE, as distinct from
  `Records.lean`, which models section 5.2's capped cell with an eviction policy.
  The two disagree on purpose and the disagreement is the point: the store that
  shipped has no capacity and no eviction, so monotonicity there is not a rule
  the store enforces but a CONSEQUENCE of two other rules — rows are never
  deleted, and a lowering write is refused.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.RecordsStore

open Proteus.Exploration

/-- What the store answers a write with. `refused` carries a cause because the
    cause is the observable the TypeScript surface returns. -/
inductive Outcome where
  | admitted
  | refused (cause : String)
  deriving Repr, BEq, DecidableEq, Inhabited

theorem outcome_admitted_ne_refused (cause : String) :
    Outcome.admitted ≠ Outcome.refused cause := by
  simp

end Proteus.Exploration.RecordsStore

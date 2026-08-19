/-
  Proteus.Exploration.Rebase — a stale verdict never applies. 0 sorry.

  Models the sequential rebase in `packages/core/src/strategy/merge-back.ts`: a
  verdict binds the PAIR `(memberDigest, baseDigest)`, so a moved base forces
  re-verification through the verifier registry.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.Rebase

open Proteus.Exploration

/-- The key a verdict is filed under. Both components, because the member digest
    alone does not move when the base does. -/
structure VerdictKey where
  memberDigest : String
  baseDigest : String
  deriving Repr, BEq, DecidableEq, Inhabited

theorem key_is_the_pair (k : VerdictKey) :
    k = { memberDigest := k.memberDigest, baseDigest := k.baseDigest } := rfl

end Proteus.Exploration.Rebase

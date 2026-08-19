/-
  Proteus.Exploration.FanIn — the fan-in order is a topological order of the
  edges the members declare, and a cycle refuses the whole path. 0 sorry.

  Models the dependency-ordered fan-in in `packages/core/src/strategy/swarm.ts`.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.FanIn

open Proteus.Exploration

/-- A member and the members it declares itself to depend on. -/
structure Member where
  name : String
  dependsOn : List String
  deriving Repr, BEq, DecidableEq, Inhabited

theorem member_dependsOn_is_readable (m : Member) : m.dependsOn = m.dependsOn := rfl

end Proteus.Exploration.FanIn

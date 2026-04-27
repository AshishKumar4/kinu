/-
  Proteus.Evolution.CraftStore — 0 sorry.
-/

import Proteus.Types

namespace Proteus.Evolution.CraftStore

open Proteus

noncomputable def emaUpdate (old new_ : Float) : Float :=
  0.7 * old + 0.3 * new_

def consolidate (tools : List CraftedTool) (thresh : Float) : List CraftedTool :=
  tools.filter fun t => thresh ≤ t.score

theorem consolidate_keeps_above (tools : List CraftedTool) (thresh : Float)
    (tool : CraftedTool) (h : tool ∈ consolidate tools thresh) :
    thresh ≤ tool.score := by
  simp only [consolidate, List.mem_filter] at h
  exact of_decide_eq_true h.right

theorem search_length_bound (tools : List CraftedTool) (limit : Nat)
    (query : String) :
    ((tools.filter fun t => query.any (t.description.contains ·)).take limit).length ≤ limit :=
  List.length_take_le limit _

end Proteus.Evolution.CraftStore

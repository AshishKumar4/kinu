/-
  Proteus.MCTS.Backpropagation — 0 sorry.
-/

import Proteus.Types
import Proteus.Safety.FloatAxioms

namespace Proteus.MCTS.Backpropagation

open Proteus
open Proteus.Safety.FloatAxioms

def BackpropState.Valid (s : BackpropState) : Prop :=
  s.visits = 0 → s.value = 0 ∧ s.rewardSum = 0

theorem initial_valid : BackpropState.Valid ⟨0, 0, 0⟩ :=
  fun _ => ⟨rfl, rfl⟩

theorem init_values_equal_at_first_step (r : Float) :
    runningMean 0.5 0 r = runningMean 0 0 r := by
  simp only [runningMean]
  rw [float_ofNat_zero, float_mul_zero, float_mul_zero]

theorem backprop_preserves_ids (nodes : List NodeData) (reward : Float) :
    (nodes.map fun nd => { nd with
      visits := nd.visits + 1
      value := runningMean nd.value nd.visits reward
    }).map (·.id) = nodes.map (·.id) := by
  induction nodes with
  | nil => rfl
  | cons _ _ ih => simp [List.map, ih]

end Proteus.MCTS.Backpropagation

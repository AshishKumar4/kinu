-- SelfEvolvingAgent.Backpropagation
-- Running mean invariant.
-- BUG-1: 0.5 and 0 initialization are observationally equivalent at first step.

import SelfEvolvingAgent.Types

namespace SelfEvolvingAgent.Backprop

def runningMean (v : Float) (n : Nat) (r : Float) : Float :=
  (v * Float.ofNat n + r) / Float.ofNat (n + 1)

structure BackpropState where
  visits    : Nat
  rewardSum : Float
  value     : Float

def BackpropState.Valid (s : BackpropState) : Prop :=
  (s.visits = 0 → s.value = 0 ∧ s.rewardSum = 0) ∧
  (0 < s.visits → s.value * Float.ofNat s.visits = s.rewardSum)

def BackpropState.initial : BackpropState := { visits := 0, rewardSum := 0, value := 0 }

theorem initial_valid : BackpropState.initial.Valid := by
  constructor <;> simp [BackpropState.initial]

def BackpropState.step (s : BackpropState) (r : Float) : BackpropState :=
  { visits := s.visits + 1, rewardSum := s.rewardSum + r,
    value  := runningMean s.value s.visits r }

/-- SORRY-6: Float algebra for step_preserves_valid. -/
theorem step_preserves_valid (s : BackpropState) (r : Float) (hv : s.Valid) :
    (s.step r).Valid := by
  simp only [BackpropState.Valid, BackpropState.step]
  constructor
  · intro h; omega
  · intro _; sorry

def backpropPath (nodes : List NodeData) (reward : Float) : List NodeData :=
  nodes.map fun nd => { nd with visits := nd.visits + 1,
                                value  := runningMean nd.value nd.visits reward }

theorem backprop_preserves_ids (nodes : List NodeData) (reward : Float) :
    (backpropPath nodes reward).map NodeData.id = nodes.map NodeData.id := by
  simp [backpropPath, List.map_map]

theorem backprop_increases_visits (nodes : List NodeData) (reward : Float) (nd : NodeData)
    (h : nd ∈ nodes) :
    ∃ nd' ∈ backpropPath nodes reward, nd'.id = nd.id ∧ nd'.visits = nd.visits + 1 := by
  exact ⟨_, List.mem_map.mpr ⟨nd, h, rfl⟩, rfl, rfl⟩

/-- BUG-1: 0.5 init = 0 init at first step.
    Mathematical content: v * 0 = 0 for any Float v, so (v*0 + r)/1 = r regardless of v.
    SORRY-BUG1: Float.mul_zero not in Lean 4.29 core without Mathlib. -/
theorem init_05_eq_init_0_first_step (r : Float) :
    runningMean 0.5 0 r = runningMean 0 0 r := by
  simp only [runningMean]
  sorry  -- SORRY-BUG1: 0.5 * 0.0 = 0.0 * 0.0 in Float (x*0=0 needs Float.mul_zero)

end SelfEvolvingAgent.Backprop

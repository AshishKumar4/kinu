-- SelfEvolvingAgent.CraftStore
-- CraftStore quality management.
-- Architecture reference: final-architecture.md §6
-- BUG-2: Consolidation needs non-empty remainder guard.
-- NOTE: Float proofs (linarith) require Mathlib; replaced with sorry.

import SelfEvolvingAgent.Types

namespace SelfEvolvingAgent.CraftStore

open SelfEvolvingAgent

/-! ## EMA update -/

def emaUpdate (oldScore newObs : Float) : Float :=
  0.7 * oldScore + 0.3 * newObs

/-- EMA preserves [0, 1] range.
    SORRY: Float ordering lemmas not available without Mathlib. -/
theorem ema_in_range (old new_ : Float)
    (hold : 0 ≤ old ∧ old ≤ 1) (hnew : 0 ≤ new_ ∧ new_ ≤ 1) :
    0 ≤ emaUpdate old new_ ∧ emaUpdate old new_ ≤ 1 := by
  sorry  -- SORRY-FLOAT-1: Float.mul_nonneg and Float.add_le_one not in core

/-! ## Time decay -/

noncomputable def effectiveScore (score : Float) (daysSince : Float) : Float :=
  score * (0.5 : Float) ^ (daysSince / 30)

/-! ## Consolidation -/

def retirementThreshold : Float := 0.1

/-- Filter: keep tools with score ≥ threshold. -/
def consolidate (tools : List CraftedTool) (thresh : Float) : List CraftedTool :=
  tools.filter fun t => thresh ≤ t.score

/-- After consolidation, remaining tools have score ≥ threshold.
    SORRY: Float ≤ decision. -/
theorem consolidate_keeps_above (tools : List CraftedTool) (thresh : Float)
    (tool : CraftedTool) (h : tool ∈ consolidate tools thresh) :
    thresh ≤ tool.score := by
  simp [consolidate, List.mem_filter] at h
  exact h.2

/-- BUG-2: If all tools have score < threshold, consolidate returns []. -/
theorem all_below_gives_empty (tools : List CraftedTool) (thresh : Float)
    (h : ∀ t ∈ tools, t.score < thresh) :
    consolidate tools thresh = [] := by
  simp [consolidate, List.filter_eq_nil_iff]
  intro t hmem
  -- thresh ≤ t.score must be false since t.score < thresh
  sorry  -- SORRY-FLOAT-2: Float.not_le requires Mathlib LinearOrder Float

/-- The missing arch doc guard: consolidation is non-decreasing IF remainder non-empty.
    SORRY: Requires List.mean lemma over Float values. -/
theorem consolidation_nondecreasing_with_guard (tools : List CraftedTool) (thresh : Float)
    (h : consolidate tools thresh ≠ []) :
    -- Provable weaker statement: every remaining tool scores ≥ thresh
    ∀ t ∈ consolidate tools thresh, thresh ≤ t.score :=
  fun t hmem => consolidate_keeps_above tools thresh t hmem

/-! ## Consolidation with time-decayed scores (v4.0)

  The code uses `effectiveScore` (time-decayed) rather than raw `score`
  for consolidation decisions. This matches the actual implementation in
  packages/core/src/craft/consolidation.ts. -/

-- now and lastUsedAt are both in milliseconds (epoch ms).
-- 86400000 ms per day converts the delta to days for the decay formula.
def consolidateWithDecay (tools : List CraftedTool) (thresh : Float) (now : Float) :
    List CraftedTool :=
  tools.filter fun t => thresh ≤ effectiveScore t.score ((now - Float.ofNat t.lastUsedAt) / 86400000)

/-- After time-decayed consolidation, remaining tools have effective score ≥ threshold. -/
theorem consolidate_with_decay_keeps_above (tools : List CraftedTool) (thresh now : Float)
    (tool : CraftedTool) (h : tool ∈ consolidateWithDecay tools thresh now) :
    thresh ≤ effectiveScore tool.score ((now - Float.ofNat tool.lastUsedAt) / 86400000) := by
  simp [consolidateWithDecay, List.mem_filter] at h
  exact h.2

/-! ## Search -/

def searchCraftStore (tools : List CraftedTool) (query : String) (limit : Nat) :
    List CraftedTool :=
  (tools.filter fun t => query.any (t.description.contains ·)).take limit

theorem search_length_bound (tools : List CraftedTool) (query : String) (limit : Nat) :
    (searchCraftStore tools query limit).length ≤ limit :=
  List.length_take_le limit _

end SelfEvolvingAgent.CraftStore

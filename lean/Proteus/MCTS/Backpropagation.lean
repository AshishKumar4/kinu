/-
  Proteus.MCTS.Backpropagation — exact-arithmetic model of the MCTS
  running-mean backpropagation. 0 sorry, 0 axioms.

  Models: packages/core/src/mcts/backpropagation.ts:47-51
    visits = visits + 1
    value  = (value * visits + reward) / (visits + 1)

  -- Model assumption:
  The TS executes that formula in IEEE-754 doubles (SQLite REAL column). This
  model is exact instead: a node's statistic is the pair (scaledSum, visits),
  where rewards are integers scaled by a fixed positive factor S (TS reward
  r ∈ [0,1] — clamped at backpropagation.ts:37 — corresponds to a scaled
  reward in [0, S]), and the stored float `value` corresponds to
  scaledSum / (S · visits). Every statement below is division-free
  (numerator/denominator or inequality form), so no rounding is modeled away.
  The (sum, count) pair is the more faithful representation: the TS mean is a
  derived quantity, and bounds proved here transfer to the float
  implementation within accumulated rounding error. Differential fixtures
  (WP-F4) will check actual TS/SQLite outputs against this model.
-/

namespace Proteus.MCTS.Backpropagation

/-- A node row as touched by the backprop UPDATE: its id, how many rewards it
    has received (`visits`), and their exact scaled sum (`scaledSum`). The TS
    row's REAL `value` column is the derived mean scaledSum / (S · visits). -/
structure NodeStats where
  id        : String
  visits    : Nat
  scaledSum : Int
  deriving Repr, BEq, Inhabited

/-- One backprop touch (backpropagation.ts:49-50): visits+1, and the mean
    numerator value·visits + r becomes, exactly, scaledSum + r. -/
def update (s : NodeStats) (r : Int) : NodeStats :=
  { s with visits := s.visits + 1, scaledSum := s.scaledSum + r }

/-- A node's whole reward history, applied in order. -/
def applyRewards (s : NodeStats) (rs : List Int) : NodeStats :=
  rs.foldl update s

/-- Numerator of the TS running-mean formula: value·visits + reward. -/
def meanNum (value : Int) (visits : Nat) (reward : Int) : Int :=
  value * visits + reward

/-- (a) Init-equivalence: at the first visit (visits = 0) the update is
    independent of the node's initialization value — the prior is erased.
    (Successor of the old Float-axiom theorem of the same name.) -/
theorem init_values_equal_at_first_step (v₁ v₂ r : Int) :
    meanNum v₁ 0 r = meanNum v₂ 0 r := by
  simp [meanNum]

/-- The pair update agrees with the TS formula: if `value` is the exact stored
    mean (value·visits = scaledSum), one update produces exactly the TS
    numerator, over the incremented denominator. -/
theorem update_matches_ts_numerator (value : Int) (s : NodeStats) (r : Int)
    (h : value * s.visits = s.scaledSum) :
    (update s r).scaledSum = meanNum value s.visits r ∧
    (update s r).visits = s.visits + 1 := by
  simp [update, meanNum, h]

/-- Mean-in-range, division-free: scaledSum/visits ∈ [0, S] iff
    0 ≤ scaledSum ∧ scaledSum ≤ S·visits. -/
def InRange (S : Int) (s : NodeStats) : Prop :=
  0 ≤ s.scaledSum ∧ s.scaledSum ≤ S * s.visits

theorem initial_in_range (S : Int) (id : String) :
    InRange S ⟨id, 0, 0⟩ := by
  constructor <;> simp [InRange]

/-- (b) Bounds preservation: a scaled reward in [0, S] keeps the value in
    [0, S] (TS: rewards clamped to [0,1] keep node values in [0,1]). -/
theorem update_preserves_range (S : Int) (s : NodeStats) (r : Int)
    (hs : InRange S s) (hr0 : 0 ≤ r) (hrS : r ≤ S) :
    InRange S (update s r) := by
  obtain ⟨h0, h1⟩ := hs
  refine ⟨Int.add_nonneg h0 hr0, ?_⟩
  show s.scaledSum + r ≤ S * ((s.visits + 1 : Nat) : Int)
  calc s.scaledSum + r ≤ S * s.visits + S := Int.add_le_add h1 hrS
    _ = S * ((s.visits + 1 : Nat) : Int) := by
        rw [Int.natCast_add, Int.natCast_one, Int.mul_add, Int.mul_one]

/-- (b), lifted to a whole reward history. -/
theorem applyRewards_preserves_range (S : Int) (rs : List Int)
    (hrs : ∀ r ∈ rs, 0 ≤ r ∧ r ≤ S) :
    ∀ s : NodeStats, InRange S s → InRange S (applyRewards s rs) := by
  induction rs with
  | nil => intro s hs; exact hs
  | cons r t ih =>
    intro s hs
    have hr := hrs r (List.mem_cons_self ..)
    exact ih (fun x hx => hrs x (List.mem_cons_of_mem r hx))
      (update s r) (update_preserves_range S s r hs hr.1 hr.2)

/-- (c) Sum invariant: after any reward history, scaledSum is exactly the sum
    of all rewards received and visits counts them — i.e. value·visits = Σ
    rewards is maintained by the update. -/
theorem applyRewards_sum_invariant (s : NodeStats) (rs : List Int) :
    (applyRewards s rs).scaledSum = s.scaledSum + rs.sum ∧
    (applyRewards s rs).visits = s.visits + rs.length := by
  induction rs generalizing s with
  | nil => simp [applyRewards]
  | cons r t ih =>
    have := ih (update s r)
    simp only [applyRewards, List.foldl_cons] at *
    constructor
    · rw [this.1]; simp [update, List.sum_cons]; omega
    · rw [this.2]; simp [update]; omega

/-- (c) specialized to a fresh node: value·visits = Σ rewards from zero. -/
theorem sum_invariant (id : String) (rs : List Int) :
    (applyRewards ⟨id, 0, 0⟩ rs).scaledSum = rs.sum ∧
    (applyRewards ⟨id, 0, 0⟩ rs).visits = rs.length := by
  have h := applyRewards_sum_invariant ⟨id, 0, 0⟩ rs
  simpa using h

/-- The ancestor-walk UPDATE touches visits/value only; row IDs are unchanged
    (cited from backpropagation.ts:29). -/
theorem backprop_preserves_ids (nodes : List NodeStats) (r : Int) :
    (nodes.map (update · r)).map (·.id) = nodes.map (·.id) := by
  induction nodes with
  | nil => rfl
  | cons _ _ ih => simp [List.map, update, ih]

end Proteus.MCTS.Backpropagation

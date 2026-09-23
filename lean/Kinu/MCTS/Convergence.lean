/-
  Kinu.MCTS.Convergence — which candidate a search converges on. 0 sorry,
  0 axioms.

  Models `packages/core/src/mcts/convergence.ts#converge` over the tree
  `packages/core/src/mcts/engine.ts#runMCTS` leaves behind: every evaluated
  candidate was backpropagated from itself to the root, so a node's `value` is
  the mean reward of the evaluations in its subtree
  (`backprop_accumulates_the_evaluations_through_a_node`), and `converge` takes
  the open or terminal node first under `ORDER BY value DESC, depth DESC`.

  A candidate is a complete answer, and `converge` returns the winner's own
  proposal, so it ranks a candidate by its own reward, the score its evaluation
  measured, never by the subtree mean `value` holds once refinements
  backpropagate. Then every winner carries the best reward a population
  candidate reached (`the_winner_carries_the_best_reward`), the search's best
  candidate survives its own weak refinements
  (`the_search_expands_its_best_candidate_and_converges_on_it`), and that reward
  never falls as the tree grows, so it stabilizes
  (`a_bounded_rising_reward_stabilizes`). No ancestor is a rival of its
  descendant, whatever lies between them (`an_ancestor_is_never_a_rival`).

  Rewards are scaled integers, as in `Backpropagation.lean`. Every statement is
  pathwise: it holds for each realisation of the judges, so a probabilistic
  judge adds nothing a theorem here depends on. The near-tie test selection
  (`selectWinnerByTest`) is outside the model; it only reorders rivals within
  `takesEpsilon`, and plan mode skips it.
-/

import Kinu.Types
import Kinu.MCTS.Backpropagation
import Kinu.MCTS.Uct

namespace Kinu.MCTS.Convergence

open Kinu

/-! ## The tree `runMCTS` leaves -/

/-- An evaluated candidate. `path` lists its ancestors' ids from the root down to
    its parent, so its depth is the path's length. -/
structure Cand where
  id : String
  path : List String
  reward : Int
  status : NodeStatus
  text : String
  deriving Repr, DecidableEq

def Cand.depth (c : Cand) : Nat := c.path.length

/-- An evaluation of `e` passes through `n` when `n` is `e` or an ancestor of `e`:
    the rows the backprop CTE walks from `e`. -/
def touches (n : String) (e : Cand) : Bool := e.id == n || e.path.contains n

/-- The rewards backpropagated through `n`, in evaluation order. -/
def through (es : List Cand) (n : String) : List Int := (es.filter (touches n)).map (·.reward)

/-- **`value` is the mean of the rewards through the node.** Backpropagating them
    in order (`Backpropagation.applyRewards`) from the row's fresh state leaves
    exactly their sum over their count. -/
theorem backprop_accumulates_the_evaluations_through_a_node (es : List Cand) (n : String) :
    (Backpropagation.applyRewards ⟨n, 0, 0⟩ (through es n)).scaledSum = (through es n).sum ∧
    (Backpropagation.applyRewards ⟨n, 0, 0⟩ (through es n)).visits = (through es n).length :=
  Backpropagation.sum_invariant n (through es n)

/-! ## What `converge` reads -/

/-- One population row: its id, depth, the exact numerator and count of its
    `value`, and what `findNearTiedRivals` compares. -/
structure Member where
  id : String
  depth : Nat
  sum : Int
  cnt : Nat
  path : List String
  text : String
  deriving Repr, DecidableEq

/-- A candidate ranks by its own reward, a mean over its one evaluation. -/
def memberOf (c : Cand) : Member := ⟨c.id, c.depth, c.reward, 1, c.path, c.text⟩

/-- The root row. Its proposal is the task text `runMCTS` records it with. -/
def rootMember (es : List Cand) (rootId : String) : Member :=
  ⟨rootId, 0, (through es rootId).sum, (through es rootId).length, [], "task"⟩

/-- `status IN ('terminal', 'open')`. -/
def inPopulation (s : NodeStatus) : Bool := s == .open_ || s == .terminal

def population (es : List Cand) (rootId : String) (rootStatus : NodeStatus) : List Member :=
  (if inPopulation rootStatus then [rootMember es rootId] else []) ++
    (es.filter (fun c => inPopulation c.status)).map memberOf

/-- The denominator of `value`; an unvisited row keeps its default `value` 0. -/
def Member.den (m : Member) : Int := ((max 1 m.cnt : Nat) : Int)

/-- value(a) < value(b), exactly. -/
def valueLt (a b : Member) : Prop := a.sum * b.den < b.sum * a.den

def valueEq (a b : Member) : Prop := a.sum * b.den = b.sum * a.den

instance (a b : Member) : Decidable (valueLt a b) := inferInstanceAs (Decidable (_ < _))
instance (a b : Member) : Decidable (valueEq a b) := inferInstanceAs (Decidable (_ = _))

/-- `a` sorts strictly before `b` under `ORDER BY value DESC, depth DESC`. -/
def ranksAbove (a b : Member) : Prop := valueLt b a ∨ (valueEq a b ∧ b.depth < a.depth)

instance (a b : Member) : Decidable (ranksAbove a b) := inferInstanceAs (Decidable (_ ∨ _))

/-- A row `converge` can take as `population[0]`: nothing sorts strictly before it.
    Among rows tied on both keys SQLite's order is unspecified, so every such row
    is a possible winner. -/
def IsWinner (pop : List Member) (w : Member) : Prop := w ∈ pop ∧ ∀ x ∈ pop, ¬ ranksAbove x w

instance (pop : List Member) (w : Member) : Decidable (IsWinner pop w) :=
  inferInstanceAs (Decidable (_ ∧ _))

/-- **No row has a greater value than the winner.** -/
theorem the_winner_has_the_greatest_value (pop : List Member) (w : Member) (h : IsWinner pop w) :
    ∀ x ∈ pop, ¬ valueLt w x :=
  fun x hx hlt => h.2 x hx (Or.inl hlt)

/-! ## What `converge` answers -/

/-- A row and every ancestor it descends from, whatever their status. -/
def lineage (m : Member) : List String := m.id :: m.path

/-- `findNearTiedRivals(population, winner, 0)` kept to exact ties: another row,
    off depth 0, neither an ancestor nor a descendant of the winner, with a
    non-empty proposal the winner's differs from, and the winner's value. -/
def tiedRival (w x : Member) : Bool :=
  x.id != w.id && x.depth != 0 && decide (valueEq x w) &&
    !((lineage w).contains x.id) && !((lineage x).contains w.id) &&
    x.text != "" && x.text != w.text

inductive Outcome where
  | converged (winner : String)
  | undifferentiated (winner : String)
  | noAcceptable (winner : String)
  deriving Repr, DecidableEq

/-- `converge` in plan mode once `w` heads the population. Rewards are on the scale
    `scale`, and `minNum / minDen` is `minAcceptableScore`. -/
def outcomeOf (pop : List Member) (scale minNum minDen : Nat) (w : Member) : Outcome :=
  if pop.any (tiedRival w) then .undifferentiated w.id
  else if w.sum * minDen < minNum * scale * w.den then .noAcceptable w.id
  else .converged w.id

/-- A search converges only on a winner with no exact tie among unrelated rows and
    a value at or above the bar. -/
theorem a_converged_winner_is_undisputed_and_acceptable (pop : List Member)
    (scale minNum minDen : Nat) (w : Member)
    (h : outcomeOf pop scale minNum minDen w = .converged w.id) :
    (∀ x ∈ pop, tiedRival w x = false) ∧ ¬ (w.sum * minDen < minNum * scale * w.den) := by
  unfold outcomeOf at h
  by_cases ht : pop.any (tiedRival w) = true
  · rw [if_pos ht] at h; cases h
  · rw [if_neg ht] at h
    refine ⟨fun x hx => ?_, fun hlt => ?_⟩
    · cases hx' : tiedRival w x with
      | false => rfl
      | true => exact absurd (List.any_eq_true.mpr ⟨x, hx, hx'⟩) ht
    · rw [if_pos hlt] at h; cases h

/-- **No ancestor is a rival of its descendant**, whatever the rows between them
    became: the lineage is the whole path, not the part still in the population. -/
theorem an_ancestor_is_never_a_rival (w x : Member) (h : x.id ∈ w.path) :
    tiedRival w x = false := by
  have hc : (lineage w).contains x.id = true :=
    List.elem_eq_true_of_mem (List.mem_cons_of_mem _ h)
  unfold tiedRival
  rw [hc]
  simp

/-! ## Means over lists -/

private theorem sum_le_of_all_le (L : List Int) (x : Int) (h : ∀ y ∈ L, y ≤ x) :
    L.sum ≤ x * L.length := by
  induction L with
  | nil => simp
  | cons y ys ih =>
    have hy := h y (List.mem_cons_self _ _)
    have hys := ih (fun z hz => h z (List.mem_cons_of_mem _ hz))
    simp only [List.sum_cons, List.length_cons, Int.natCast_add, Int.mul_add, Int.mul_one]
    omega

private theorem sum_lt_of_all_le_of_lt (L : List Int) (x : Int) (h : ∀ y ∈ L, y ≤ x)
    (hs : ∃ y ∈ L, y < x) : L.sum < x * L.length := by
  induction L with
  | nil => obtain ⟨y, hy, _⟩ := hs; cases hy
  | cons y ys ih =>
    have hy := h y (List.mem_cons_self _ _)
    have hys := sum_le_of_all_le ys x (fun z hz => h z (List.mem_cons_of_mem _ hz))
    simp only [List.sum_cons, List.length_cons, Int.natCast_add, Int.mul_add, Int.mul_one]
    obtain ⟨z, hz, hzx⟩ := hs
    rcases List.mem_cons.mp hz with rfl | hz
    · omega
    · have := ih (fun w hw => h w (List.mem_cons_of_mem _ hw)) ⟨z, hz, hzx⟩
      omega

private theorem all_eq_of_sum_eq (L : List Int) (x : Int) (h : ∀ y ∈ L, y ≤ x)
    (hs : x * L.length ≤ L.sum) : ∀ y ∈ L, y = x := by
  intro y hy
  apply Classical.byContradiction
  intro hne
  have := sum_lt_of_all_le_of_lt L x h ⟨y, hy, by have := h y hy; omega⟩
  omega

private theorem sum_eq_of_all_eq (L : List Int) (x : Int) (h : ∀ y ∈ L, y = x) :
    L.sum = x * L.length := by
  induction L with
  | nil => simp
  | cons y ys ih =>
    have hy := h y (List.mem_cons_self _ _)
    have hys := ih (fun z hz => h z (List.mem_cons_of_mem _ hz))
    simp only [List.sum_cons, List.length_cons, Int.natCast_add, Int.mul_add, Int.mul_one]
    omega

private theorem touches_self (e : Cand) : touches e.id e = true := by
  simp [touches]

private theorem touches_of_path (n : String) (e : Cand) (h : e.path.contains n = true) :
    touches n e = true := by
  unfold touches; rw [h, Bool.or_true]

private theorem den_of_pos (m : Member) (h : 1 ≤ m.cnt) : m.den = m.cnt := by
  simp [Member.den, Nat.max_eq_right h]

/-- A row whose mean is below `r` sorts after a row whose mean is exactly `r`. -/
private theorem valueLt_of_mean (x m : Member) (r : Int) (hx : 1 ≤ x.cnt) (hm : 1 ≤ m.cnt)
    (hmr : m.sum = r * m.cnt) (hxr : x.sum < r * x.cnt) : valueLt x m := by
  unfold valueLt
  rw [den_of_pos x hx, den_of_pos m hm, hmr]
  have hpos : (0 : Int) < m.cnt := by omega
  have := Int.mul_lt_mul_of_pos_right hxr hpos
  rw [Int.mul_assoc, Int.mul_comm (x.cnt : Int), ← Int.mul_assoc] at this
  exact this

private theorem through_mem (es : List Cand) (n : String) (e : Cand) (he : e ∈ es)
    (ht : touches n e = true) : e.reward ∈ through es n :=
  List.mem_map.mpr ⟨e, List.mem_filter.mpr ⟨he, ht⟩, rfl⟩

private theorem through_cases (es : List Cand) (n : String) (y : Int) (hy : y ∈ through es n) :
    ∃ e ∈ es, touches n e = true ∧ e.reward = y := by
  obtain ⟨e, he, rfl⟩ := List.mem_map.mp hy
  exact ⟨e, (List.mem_filter.mp he).1, (List.mem_filter.mp he).2, rfl⟩

/-! ## The winner carries the best reward -/

/-- **Every winner is a candidate with the best reward any candidate reached**,
    provided that candidate is in the population and every candidate descends
    from the root. A candidate ranks by its own reward, and the root's mean over
    all rewards reaches the best only when every reward is the best, where it
    loses the depth tie. -/
theorem the_winner_carries_the_best_reward (es : List Cand) (rootId : String)
    (rootStatus : NodeStatus) (l : Cand) (hl : l ∈ es) (hlp : inPopulation l.status = true)
    (hmax : ∀ e ∈ es, e.reward ≤ l.reward) (hroot : ∀ e ∈ es, e.path.contains rootId = true) :
    ∀ w, IsWinner (population es rootId rootStatus) w →
      ∃ e ∈ es, w = memberOf e ∧ e.reward = l.reward := by
  have hle : ∀ y ∈ through es rootId, y ≤ l.reward := by
    intro y hy
    obtain ⟨e, he, _, rfl⟩ := through_cases es rootId y hy
    exact hmax e he
  have hlcnt : 1 ≤ (memberOf l).cnt := Nat.le_refl 1
  have hlsum : (memberOf l).sum = l.reward * (memberOf l).cnt := by simp [memberOf]
  have hlmem : memberOf l ∈ population es rootId rootStatus := by
    unfold population
    exact List.mem_append_right _ (List.mem_map.mpr ⟨l, List.mem_filter.mpr ⟨hl, hlp⟩, rfl⟩)
  intro w hw
  have hwmem := hw.1
  unfold population at hwmem
  rcases List.mem_append.mp hwmem with hx | hx
  · exfalso
    split at hx
    · rw [List.mem_singleton] at hx
      subst hx
      have hrcnt : 1 ≤ (rootMember es rootId).cnt :=
        List.length_pos.mpr (List.ne_nil_of_mem
          (through_mem es rootId l hl (touches_of_path _ _ (hroot l hl))))
      by_cases hlow : ∃ y ∈ through es rootId, y < l.reward
      · exact hw.2 _ hlmem (Or.inl (valueLt_of_mean _ _ l.reward hrcnt hlcnt hlsum
          (sum_lt_of_all_le_of_lt _ _ hle hlow)))
      · have heq : ∀ y ∈ through es rootId, y = l.reward := by
          intro y hy
          have := hle y hy
          apply Classical.byContradiction
          intro hne
          exact hlow ⟨y, hy, by omega⟩
        have hrsum : (rootMember es rootId).sum = l.reward * (rootMember es rootId).cnt :=
          sum_eq_of_all_eq _ _ heq
        apply hw.2 _ hlmem
        refine Or.inr ⟨?_, ?_⟩
        · unfold valueEq
          rw [den_of_pos _ hlcnt, den_of_pos _ hrcnt, hlsum, hrsum]
          simp only [Int.mul_assoc, Int.mul_comm, Int.mul_left_comm]
        · show 0 < l.path.length
          have := hroot l hl
          cases hp : l.path with
          | nil => rw [hp] at this; simp at this
          | cons _ _ => simp
    · cases hx
  · obtain ⟨e, he, rfl⟩ := List.mem_map.mp hx
    have he' := (List.mem_filter.mp he).1
    refine ⟨e, he', rfl, ?_⟩
    have hnlt := the_winner_has_the_greatest_value _ _ hw _ hlmem
    simp [valueLt, memberOf, Member.den] at hnlt
    have := hmax e he'
    omega

/-! ## The search keeps its best candidate -/

/-- Before the second iteration: the root and two children scored 90 and 70. -/
def firstLevel : List (Uct.Row Int) :=
  [ ⟨"R", none, "R", .open_, 0, 2, 80⟩,
    ⟨"a", some "R", "R", .open_, 1, 1, 90⟩,
    ⟨"b", some "R", "R", .open_, 1, 1, 70⟩ ]

/-- After `a` was expanded into two refinements that scored 10 each. -/
def afterExpandingA : List Cand :=
  [ ⟨"a", ["R"], 90, .open_, "approach a"⟩,
    ⟨"b", ["R"], 70, .open_, "approach b"⟩,
    ⟨"a1", ["R", "a"], 10, .open_, "refinement a1"⟩,
    ⟨"a2", ["R", "a"], 10, .open_, "refinement a2"⟩ ]

/-- **The search expands its best candidate and still converges on it.** For any
    score that rises strictly with the value and with the bonus, the UCT argmax
    over the first level is `a`, which scored 90. After its two refinements score
    10, `a` is still the only possible winner: its mean fell to 110/3, and ranking
    by that mean returned `b` until `converge` ranked by the candidate's own reward. -/
theorem the_search_expands_its_best_candidate_and_converges_on_it {S : Type}
    (ge : S → S → Bool) (score : Int → Uct.Bonus → S)
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true)
    (hv : ∀ v v' k, v < v' → ge (score v k) (score v' k) = false)
    (hk : ∀ v k k', k < k' → ge (score v k) (score v k') = false) :
    Uct.select ge score firstLevel "R" 5 = some ⟨"a", some "R", "R", .open_, 1, 1, 90⟩ ∧
    (population afterExpandingA "R" .open_).filter (fun w => decide (IsWinner (population afterExpandingA "R" .open_) w))
      = [memberOf ⟨"a", ["R"], 90, .open_, "approach a"⟩] := by
  refine ⟨?_, by decide⟩
  -- the three scores, as the SQL joins them
  have sR : Uct.scoreIn score firstLevel ⟨"R", none, "R", .open_, 0, 2, 80⟩ = score 80 ⟨2, 2⟩ := rfl
  have sA : Uct.scoreIn score firstLevel ⟨"a", some "R", "R", .open_, 1, 1, 90⟩ = score 90 ⟨1, 2⟩ := rfl
  have sB : Uct.scoreIn score firstLevel ⟨"b", some "R", "R", .open_, 1, 1, 70⟩ = score 70 ⟨1, 2⟩ := rfl
  have up : ∀ x y, ge x y = false → ge y x = true := fun x y h => by
    rcases htotal x y with h' | h'
    · rw [h] at h'; cases h'
    · exact h'
  have kLt : (⟨2, 2⟩ : Uct.Bonus) < ⟨1, 2⟩ := by decide
  -- a outranks R: 80 < 90 at R's bonus, and R's bonus is below a's
  have hRa : ge (score 80 ⟨2, 2⟩) (score 90 ⟨1, 2⟩) = false := by
    cases h : ge (score 80 ⟨2, 2⟩) (score 90 ⟨1, 2⟩) with
    | false => rfl
    | true =>
      have := htrans _ _ _ h (up _ _ (hk 90 _ _ kLt))
      rw [hv 80 90 ⟨2, 2⟩ (by decide)] at this
      cases this
  have hBa : ge (score 70 ⟨1, 2⟩) (score 90 ⟨1, 2⟩) = false := hv 70 90 _ (by decide)
  cases hsel : Uct.select ge score firstLevel "R" 5 with
  | none =>
    have := (Uct.select_none_iff ge score firstLevel "R" 5).mp hsel
      ⟨"a", some "R", "R", .open_, 1, 1, 90⟩ (by simp [firstLevel])
    exact absurd this (by decide)
  | some r =>
    have hmax := Uct.select_is_maximal ge score htotal htrans firstLevel "R" 5 r hsel
      ⟨"a", some "R", "R", .open_, 1, 1, 90⟩ (by simp [firstLevel]) (by decide)
    have hmem := (Uct.select_is_eligible ge score firstLevel "R" 5 r hsel).1
    simp only [firstLevel, List.mem_cons, List.mem_singleton, List.not_mem_nil, or_false] at hmem
    rcases hmem with rfl | rfl | rfl
    · rw [sR, sA, hRa] at hmax; cases hmax
    · rfl
    · rw [sB, sA, hBa] at hmax; cases hmax

/-- **A reward that never falls and never passes a bound is eventually constant.**
    By `the_winner_carries_the_best_reward` the winner's reward is the best reward
    the tree reached; that can only rise as candidates are added, and rewards are
    clamped, so the reward of what the search converges on stops changing. -/
theorem a_bounded_rising_reward_stabilizes (f : Nat → Int) (B : Int)
    (hmono : ∀ k, f k ≤ f (k + 1)) (hbound : ∀ k, f k ≤ B) :
    ∃ N, ∀ k, N ≤ k → f k = f N := by
  have hstep : ∀ i d, f i ≤ f (i + d) := by
    intro i d
    induction d with
    | zero => exact Int.le_refl _
    | succ d ih => exact Int.le_trans ih (hmono _)
  have hmono' : ∀ i j, i ≤ j → f i ≤ f j := by
    intro i j hij
    have := hstep i (j - i)
    rwa [Nat.add_sub_cancel' hij] at this
  -- descend on the room left below the bound
  suffices h : ∀ (m : Nat) (i : Nat), (B - f i).toNat ≤ m → ∃ N, ∀ k, N ≤ k → f k = f N from
    h _ 0 (Nat.le_refl _)
  intro m
  induction m with
  | zero =>
    intro i hi
    refine ⟨i, fun k hk => ?_⟩
    have := hmono' i k hk
    have := hbound k
    omega
  | succ m ih =>
    intro i hi
    by_cases hstay : ∀ k, i ≤ k → f k = f i
    · exact ⟨i, hstay⟩
    · have : ∃ k, i ≤ k ∧ f k ≠ f i := by
        apply Classical.byContradiction
        intro hno
        exact hstay (fun k hk => Classical.byContradiction (fun hne => hno ⟨k, hk, hne⟩))
      obtain ⟨k, hk, hne⟩ := this
      have hlt : f i < f k := by have := hmono' i k hk; omega
      exact ih k (by have := hbound k; omega)

end Kinu.MCTS.Convergence

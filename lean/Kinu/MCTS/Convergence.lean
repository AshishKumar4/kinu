/-
  Kinu.MCTS.Convergence — which candidate a search converges on. 0 sorry,
  0 axioms.

  Models `packages/core/src/mcts/convergence.ts#converge` over the tree
  `packages/core/src/mcts/engine.ts#runMCTS` leaves behind: every evaluated
  candidate was backpropagated from itself to the root, so a node's `value` is
  the mean reward of the evaluations in its subtree
  (`backprop_accumulates_the_evaluations_through_a_node`), and `converge` takes
  the open or terminal node first under `ORDER BY value DESC, depth DESC`.

  A candidate is a complete answer, and the answer `converge` returns is the
  winner's own proposal. Its `value`, though, is a subtree mean, so the ranking
  converge applies is not the ranking of the answers it can return:

  - a unique best candidate that was never expanded always wins
    (`a_unique_best_leaf_is_the_only_winner`);
  - once it is expanded, worse refinements dilute it, and the shipped selection
    does expand it: `select` picks the best candidate for expansion, and after
    two weak refinements `converge` returns its worse sibling
    (`the_search_expands_its_best_candidate_then_converges_past_it`). So the
    search does not in general stabilize on its best evaluated candidate;
  - it does when refinements never score below their parent: then every winner
    carries the best reward any population candidate reached
    (`the_winner_is_optimal_when_refinements_never_score_worse`), that reward
    never falls as the tree grows, and a bounded non-decreasing reward sequence
    is eventually constant (`a_bounded_rising_reward_stabilizes`).

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

def memberOf (es : List Cand) (c : Cand) : Member :=
  ⟨c.id, c.depth, (through es c.id).sum, (through es c.id).length, c.path, c.text⟩

/-- The root row. Its proposal is the task text `runMCTS` records it with. -/
def rootMember (es : List Cand) (rootId : String) : Member :=
  ⟨rootId, 0, (through es rootId).sum, (through es rootId).length, [], "task"⟩

/-- `status IN ('terminal', 'open')`. -/
def inPopulation (s : NodeStatus) : Bool := s == .open_ || s == .terminal

def population (es : List Cand) (rootId : String) (rootStatus : NodeStatus) : List Member :=
  (if inPopulation rootStatus then [rootMember es rootId] else []) ++
    (es.filter (fun c => inPopulation c.status)).map (memberOf es)

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

/-- The lineage `findNearTiedRivals` sees: the row, then its ancestors upward for as
    long as each is itself in the population. Its parent-link walk runs over
    population rows only, so it stops at the first pruned or failed ancestor. -/
def lineage (pop : List Member) (m : Member) : List String :=
  m.id :: m.path.reverse.takeWhile (fun a => pop.any (·.id == a))

/-- `findNearTiedRivals(population, winner, 0)` kept to exact ties: another row,
    off depth 0, off the winner's lineage and the winner off its own, with a
    non-empty proposal the winner's differs from, and the winner's value. -/
def tiedRival (pop : List Member) (w x : Member) : Bool :=
  x.id != w.id && x.depth != 0 && decide (valueEq x w) &&
    !((lineage pop w).contains x.id) && !((lineage pop x).contains w.id) &&
    x.text != "" && x.text != w.text

inductive Outcome where
  | converged (winner : String)
  | undifferentiated (winner : String)
  | noAcceptable (winner : String)
  deriving Repr, DecidableEq

/-- `converge` in plan mode once `w` heads the population. Rewards are on the scale
    `scale`, and `minNum / minDen` is `minAcceptableScore`. -/
def outcomeOf (pop : List Member) (scale minNum minDen : Nat) (w : Member) : Outcome :=
  if pop.any (tiedRival pop w) then .undifferentiated w.id
  else if w.sum * minDen < minNum * scale * w.den then .noAcceptable w.id
  else .converged w.id

/-- A search converges only on a winner with no exact tie among unrelated rows and
    a value at or above the bar. -/
theorem a_converged_winner_is_undisputed_and_acceptable (pop : List Member)
    (scale minNum minDen : Nat) (w : Member)
    (h : outcomeOf pop scale minNum minDen w = .converged w.id) :
    (∀ x ∈ pop, tiedRival pop w x = false) ∧ ¬ (w.sum * minDen < minNum * scale * w.den) := by
  unfold outcomeOf at h
  by_cases ht : pop.any (tiedRival pop w) = true
  · rw [if_pos ht] at h; cases h
  · rw [if_neg ht] at h
    refine ⟨fun x hx => ?_, fun hlt => ?_⟩
    · cases hx' : tiedRival pop w x with
      | false => rfl
      | true => exact absurd (List.any_eq_true.mpr ⟨x, hx, hx'⟩) ht
    · rw [if_pos hlt] at h; cases h

/-- **A pruned parent splits a lineage.** A grandparent and its grandchild that
    tie exactly are one approach refined, yet with the parent between them pruned,
    the walk stops at the parent, so the grandparent counts as a distinct rival
    and `converge` reports an undifferentiated search. -/
theorem a_pruned_parent_splits_a_lineage :
    let pop := [⟨"g", 1, 5, 1, ["R"], "grandparent"⟩, ⟨"c", 3, 10, 2, ["R", "g", "p"], "grandchild"⟩]
    ("g" ∈ (⟨"c", 3, 10, 2, ["R", "g", "p"], "grandchild"⟩ : Member).path) ∧
      tiedRival pop ⟨"c", 3, 10, 2, ["R", "g", "p"], "grandchild"⟩ ⟨"g", 1, 5, 1, ["R"], "grandparent"⟩ = true := by
  decide

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

/-! ## A unique best candidate that was never expanded wins -/

private theorem through_mem (es : List Cand) (n : String) (e : Cand) (he : e ∈ es)
    (ht : touches n e = true) : e.reward ∈ through es n :=
  List.mem_map.mpr ⟨e, List.mem_filter.mpr ⟨he, ht⟩, rfl⟩

private theorem through_cases (es : List Cand) (n : String) (y : Int) (hy : y ∈ through es n) :
    ∃ e ∈ es, touches n e = true ∧ e.reward = y := by
  obtain ⟨e, he, rfl⟩ := List.mem_map.mp hy
  exact ⟨e, (List.mem_filter.mp he).1, (List.mem_filter.mp he).2, rfl⟩

/-- **A unique best candidate that nothing was expanded from is the only possible
    winner.** Every other row's mean is over rewards no higher than its own, with
    one strictly lower; the root can tie it only when it is the sole evaluation,
    and then loses on depth. -/
theorem a_unique_best_leaf_is_the_only_winner (es : List Cand) (rootId : String)
    (rootStatus : NodeStatus) (c : Cand)
    (hc : c ∈ es) (hcp : inPopulation c.status = true)
    (hids : ∀ e ∈ es, e.id = c.id → e = c)
    (hbest : ∀ e ∈ es, e.id ≠ c.id → e.reward < c.reward)
    (hleaf : ∀ e ∈ es, e.path.contains c.id = false)
    (hroot : c.path.contains rootId = true) :
    ∀ w, IsWinner (population es rootId rootStatus) w → w = memberOf es c := by
  -- every reward through any node is at most `c`'s
  have hle : ∀ n, ∀ y ∈ through es n, y ≤ c.reward := by
    intro n y hy
    obtain ⟨e, he, _, rfl⟩ := through_cases es n y hy
    by_cases hid : e.id = c.id
    · rw [hids e he hid]; exact Int.le_refl _
    · exact Int.le_of_lt (hbest e he hid)
  -- `c`'s own mean is exactly its reward
  have hcself : ∀ y ∈ through es c.id, y = c.reward := by
    intro y hy
    obtain ⟨e, he, ht, rfl⟩ := through_cases es c.id y hy
    have hpath := hleaf e he
    simp only [touches, hpath, Bool.or_false, beq_iff_eq] at ht
    rw [hids e he ht]
  have hccnt : 1 ≤ (memberOf es c).cnt :=
    List.length_pos.mpr (List.ne_nil_of_mem (through_mem es c.id c hc (touches_self c)))
  have hcsum : (memberOf es c).sum = c.reward * (memberOf es c).cnt :=
    sum_eq_of_all_eq _ _ hcself
  have hcmem : memberOf es c ∈ population es rootId rootStatus := by
    unfold population
    exact List.mem_append_right _ (List.mem_map.mpr ⟨c, List.mem_filter.mpr ⟨hc, hcp⟩, rfl⟩)
  -- every other row sorts after `c`'s
  have hbeats : ∀ x ∈ population es rootId rootStatus, x ≠ memberOf es c →
      ranksAbove (memberOf es c) x := by
    intro x hx hne
    unfold population at hx
    rcases List.mem_append.mp hx with hx | hx
    · -- the root
      split at hx
      · rw [List.mem_singleton] at hx
        subst hx
        have hcr : c.reward ∈ through es rootId := through_mem es rootId c hc (touches_of_path _ _ hroot)
        have hrcnt : 1 ≤ (rootMember es rootId).cnt :=
          List.length_pos.mpr (List.ne_nil_of_mem hcr)
        by_cases hlow : ∃ y ∈ through es rootId, y < c.reward
        · exact Or.inl (valueLt_of_mean _ _ c.reward hrcnt hccnt hcsum
            (sum_lt_of_all_le_of_lt _ _ (hle rootId) hlow))
        · -- every evaluation through the root scored `c.reward`: a tie broken by depth
          have heq : ∀ y ∈ through es rootId, y = c.reward := by
            intro y hy
            have := hle rootId y hy
            apply Classical.byContradiction
            intro hne
            exact hlow ⟨y, hy, by omega⟩
          have hrsum : (rootMember es rootId).sum = c.reward * (rootMember es rootId).cnt :=
            sum_eq_of_all_eq _ _ heq
          refine Or.inr ⟨?_, ?_⟩
          · unfold valueEq
            rw [den_of_pos _ hccnt, den_of_pos _ hrcnt, hcsum, hrsum]
            simp only [Int.mul_assoc, Int.mul_comm, Int.mul_left_comm]
          · show 0 < c.path.length
            cases hp : c.path with
            | nil => rw [hp] at hroot; simp at hroot
            | cons _ _ => simp
      · cases hx
    · -- another candidate
      obtain ⟨e, he, rfl⟩ := List.mem_map.mp hx
      have he' := (List.mem_filter.mp he).1
      have hid : e.id ≠ c.id := fun h => hne (by rw [hids e he' h])
      have hecnt : 1 ≤ (memberOf es e).cnt :=
        List.length_pos.mpr (List.ne_nil_of_mem (through_mem es e.id e he' (touches_self e)))
      exact Or.inl (valueLt_of_mean _ _ c.reward hecnt hccnt hcsum
        (sum_lt_of_all_le_of_lt _ _ (hle e.id)
          ⟨e.reward, through_mem es e.id e he' (touches_self e), hbest e he' hid⟩))
  intro w hw
  apply Classical.byContradiction
  intro hne
  exact hw.2 _ hcmem (hbeats w hw.1 hne)

/-! ## Expansion dilutes, and the shipped search expands the best candidate -/

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

/-- **The shipped search expands its best candidate, then converges past it.**
    For any score that rises strictly with the value and with the bonus, the UCT
    argmax over the first level is `a`, the candidate that scored 90. After `a`'s
    two refinements score 10, the only row `converge` can return is `b`, which
    scored 70: `a`'s mean fell to 110/3 while its own reward is still the best. -/
theorem the_search_expands_its_best_candidate_then_converges_past_it {S : Type}
    (ge : S → S → Bool) (score : Int → Uct.Bonus → S)
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true)
    (hv : ∀ v v' k, v < v' → ge (score v k) (score v' k) = false)
    (hk : ∀ v k k', k < k' → ge (score v k) (score v k') = false) :
    Uct.select ge score firstLevel "R" 5 = some ⟨"a", some "R", "R", .open_, 1, 1, 90⟩ ∧
    (population afterExpandingA "R" .open_).filter (fun w => decide (IsWinner (population afterExpandingA "R" .open_) w))
      = [memberOf afterExpandingA ⟨"b", ["R"], 70, .open_, "approach b"⟩] := by
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

/-! ## When refinements never score worse, the winner is optimal -/

/-- **If no candidate scores below any candidate ancestor, every winner carries the
    best reward any candidate reached,** provided one candidate with that reward
    is still in the population. A best candidate's subtree then holds only best
    rewards, so its mean is the best reward; a winner's mean is at least that and
    at most the best, so its whole subtree, itself included, scored the best; and
    the root, tied, loses on depth. -/
theorem the_winner_is_optimal_when_refinements_never_score_worse (es : List Cand)
    (rootId : String) (rootStatus : NodeStatus) (l : Cand)
    (hl : l ∈ es) (hlp : inPopulation l.status = true)
    (hmax : ∀ e ∈ es, e.reward ≤ l.reward)
    (hids : ∀ e ∈ es, ∀ e' ∈ es, e.id = e'.id → e = e')
    (hrefine : ∀ e ∈ es, ∀ p ∈ es, e.path.contains p.id = true → p.reward ≤ e.reward)
    (hroot : ∀ e ∈ es, e.path.contains rootId = true) :
    ∀ w, IsWinner (population es rootId rootStatus) w →
      ∃ e ∈ es, w = memberOf es e ∧ e.reward = l.reward := by
  have hle : ∀ n, ∀ y ∈ through es n, y ≤ l.reward := by
    intro n y hy
    obtain ⟨e, he, _, rfl⟩ := through_cases es n y hy
    exact hmax e he
  -- the best candidate's own mean is the best reward
  have hlself : ∀ y ∈ through es l.id, y = l.reward := by
    intro y hy
    obtain ⟨e, he, ht, rfl⟩ := through_cases es l.id y hy
    simp only [touches, Bool.or_eq_true, beq_iff_eq] at ht
    rcases ht with ht | ht
    · rw [hids e he l hl ht]
    · exact Int.le_antisymm (hmax e he) (hrefine e he l hl ht)
  have hlcnt : 1 ≤ (memberOf es l).cnt :=
    List.length_pos.mpr (List.ne_nil_of_mem (through_mem es l.id l hl (touches_self l)))
  have hlsum : (memberOf es l).sum = l.reward * (memberOf es l).cnt :=
    sum_eq_of_all_eq _ _ hlself
  have hlmem : memberOf es l ∈ population es rootId rootStatus := by
    unfold population
    exact List.mem_append_right _ (List.mem_map.mpr ⟨l, List.mem_filter.mpr ⟨hl, hlp⟩, rfl⟩)
  -- a winner's mean is at least the best reward, so every reward through it is the best
  have hall : ∀ w, IsWinner (population es rootId rootStatus) w → 1 ≤ w.cnt →
      (∀ n, w.sum = (through es n).sum → w.cnt = (through es n).length →
        ∀ y ∈ through es n, y = l.reward) := by
    intro w hw hwc n hsum hcnt
    have hnlt : ¬ valueLt w (memberOf es l) := the_winner_has_the_greatest_value _ w hw _ hlmem
    have hge : l.reward * w.cnt ≤ w.sum := by
      apply Classical.byContradiction
      intro hlt
      exact hnlt (valueLt_of_mean _ _ l.reward hwc hlcnt hlsum (by omega))
    apply all_eq_of_sum_eq _ _ (hle n)
    rw [← hsum, ← hcnt]; exact hge
  intro w hw
  have hwmem := hw.1
  unfold population at hwmem
  rcases List.mem_append.mp hwmem with hx | hx
  · -- the root cannot win: it would tie the best candidate and lose on depth
    exfalso
    split at hx
    · rw [List.mem_singleton] at hx
      have hrcnt : 1 ≤ (rootMember es rootId).cnt :=
        List.length_pos.mpr (List.ne_nil_of_mem
          (through_mem es rootId l hl (touches_of_path _ _ (hroot l hl))))
      have heq := hall w hw (by rw [hx]; exact hrcnt) rootId (by rw [hx]; rfl) (by rw [hx]; rfl)
      have hrsum : (rootMember es rootId).sum = l.reward * (rootMember es rootId).cnt :=
        sum_eq_of_all_eq _ _ heq
      apply hw.2 _ hlmem
      rw [hx]
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
    have hecnt : 1 ≤ (memberOf es e).cnt :=
      List.length_pos.mpr (List.ne_nil_of_mem (through_mem es e.id e he' (touches_self e)))
    exact hall _ hw hecnt e.id rfl rfl e.reward (through_mem es e.id e he' (touches_self e))

/-- **A reward that never falls and never passes a bound is eventually constant.**
    With the theorem above, the best reward a growing tree reaches is the winner's
    reward, it can only rise as candidates are added, and rewards are clamped, so
    the reward of what the search converges on stops changing. -/
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

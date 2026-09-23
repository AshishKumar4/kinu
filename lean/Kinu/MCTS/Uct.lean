/-
  Kinu.MCTS.Uct — the exploration bonus `selectNode` ranks by, and the argmax it
  takes. 0 sorry, 0 axioms.

  Models `packages/core/src/mcts/uct.ts#selectNode`:

    score(s) = value(s) + W · √( ln(max(2, P)) / max(1, visits(s)) )
    P        = the joined parent row's visits, or max(2, visits(s)) when the
               join finds no parent row (the root)

  THE BONUS ORDER IS DECIDED OVER NATURALS. For W > 0, a strictly increasing
  `ln` that turns powers into multiples, and a strictly increasing `√`,

    bonus(N₁, M₁) < bonus(N₂, M₂)  ↔  M₁ ^ N₂ < M₂ ^ N₁

  (`bonus_order_is_power_order`), because both sides are compared after
  multiplying out the denominators: N₂·ln M₁ < N₁·ln M₂ is ln(M₁^N₂) < ln(M₂^N₁).
  Every monotonicity claim below is therefore a statement about natural powers,
  proved without real numbers and without rounding. The SQL evaluates the same
  expression in IEEE-754 doubles, where the order holds up to rounding; the
  refinement fixture (`lean/fixtures/uct-select.json`) compares the deployed
  query against `select` instantiated at `Float` on generated tables.

  WHAT HOLDS, AND WHERE IT STOPS:
  - a node with a parent row: the bonus falls strictly with its own visits from
    one visit on, and rises strictly with its parent's visits from two on;
  - two plateaus: zero and one own visits tie, and zero, one and two parent
    visits tie, because of `max(1.0, …)` and `max(2.0, …)`;
  - the root parents itself, so its bonus is flat from 0 to 1, falls from 1 to 2,
    RISES from 2 to 3 (8 < 9), and falls from 3 on. A global "the bonus falls
    with visits" is false of the shipped query, and
    `the_root_bonus_rises_from_two_visits_to_three` is the counterexample;
  - every bonus is positive, so an open root stays selectable.
-/

import Kinu.Types

namespace Kinu.MCTS.Uct

/-! ## The bonus as a pair of naturals -/

/-- The two naturals the bonus is computed from: `den` is `max(1.0, s.visits)`
    and `arg` is the argument of `ln`. -/
structure Bonus where
  den : Nat
  arg : Nat
  deriving Repr, DecidableEq, Inhabited

/-- `max(2.0, COALESCE(p.visits, max(2, s.visits)))`: the parent row's visits
    when the join finds one, the node's own visits otherwise, floored at 2. -/
def logArgument (parentVisits : Option Nat) (visits : Nat) : Nat :=
  max 2 (parentVisits.getD (max 2 visits))

/-- The bonus of a row with `visits` own visits whose join found `parentVisits`. -/
def bonusOf (visits : Nat) (parentVisits : Option Nat) : Bonus :=
  ⟨max 1 visits, logArgument parentVisits visits⟩

/-- `W · √(ln 1 / 1)`: an exploration term of zero. -/
def zeroBonus : Bonus := ⟨1, 1⟩

/-- Strictly smaller bonus, exact: `bonus_order_is_power_order`. -/
instance : LT Bonus := ⟨fun a b => a.arg ^ b.den < b.arg ^ a.den⟩

instance (a b : Bonus) : Decidable (a < b) :=
  inferInstanceAs (Decidable (a.arg ^ b.den < b.arg ^ a.den))

/-- Equal bonus: neither is below the other. -/
def Bonus.Tie (a b : Bonus) : Prop := a.arg ^ b.den = b.arg ^ a.den

/-- Both naturals are in the range the SQL produces for them. -/
def Bonus.WellFormed (a : Bonus) : Prop := 1 ≤ a.den ∧ 1 ≤ a.arg

theorem bonusOf_well_formed (visits : Nat) (parentVisits : Option Nat) :
    (bonusOf visits parentVisits).WellFormed := by
  simp only [Bonus.WellFormed, bonusOf, logArgument]
  omega

/-! ## Natural-number powers -/

private theorem pow_lt_pow_of_base_lt {a b : Nat} (h : a < b) : ∀ {k : Nat}, 0 < k → a ^ k < b ^ k
  | 0, hk => absurd hk (Nat.lt_irrefl 0)
  | 1, _ => by simpa using h
  | k + 2, _ => by
    have ih : a ^ (k + 1) < b ^ (k + 1) := pow_lt_pow_of_base_lt h (Nat.succ_pos k)
    rw [Nat.pow_succ a (k + 1), Nat.pow_succ b (k + 1)]
    exact Nat.mul_lt_mul_of_lt_of_le ih (Nat.le_of_lt h) (by omega)

private theorem base_lt_of_pow_lt_pow {a b k : Nat} (h : a ^ k < b ^ k) : a < b := by
  apply Nat.lt_of_not_le
  intro hba
  exact Nat.lt_irrefl _ (Nat.lt_of_lt_of_le h (Nat.pow_le_pow_left hba k))

private theorem pow_pos_of_one_le {a : Nat} (h : 1 ≤ a) (k : Nat) : 0 < a ^ k :=
  Nat.pos_pow_of_pos k h

/-! ## The order is a strict weak order -/

theorem bonus_lt_irrefl (a : Bonus) : ¬ a < a := Nat.lt_irrefl _

theorem bonus_lt_asymm (a b : Bonus) (h : a < b) : ¬ b < a := fun h' =>
  Nat.lt_irrefl _ (Nat.lt_trans h h')

theorem bonus_trichotomy (a b : Bonus) : a < b ∨ a.Tie b ∨ b < a := by
  show a.arg ^ b.den < b.arg ^ a.den ∨ a.arg ^ b.den = b.arg ^ a.den ∨ b.arg ^ a.den < a.arg ^ b.den
  omega

/-- The order is transitive over well-formed bonuses. Both inequalities are
    raised to a common exponent, chained, and the common root is taken back. -/
theorem bonus_lt_trans (a b c : Bonus) (hc : c.WellFormed)
    (hab : a < b) (hbc : b < c) : a < c := by
  show a.arg ^ c.den < c.arg ^ a.den
  have hab' : a.arg ^ b.den < b.arg ^ a.den := hab
  have hbc' : b.arg ^ c.den < c.arg ^ b.den := hbc
  have h1 : (a.arg ^ b.den) ^ c.den < (b.arg ^ a.den) ^ c.den :=
    pow_lt_pow_of_base_lt hab' hc.1
  have h2 : (b.arg ^ c.den) ^ a.den ≤ (c.arg ^ b.den) ^ a.den :=
    Nat.pow_le_pow_left (Nat.le_of_lt hbc') a.den
  rw [← Nat.pow_mul, ← Nat.pow_mul] at h1 h2
  have hmid : b.arg ^ (a.den * c.den) = b.arg ^ (c.den * a.den) := by rw [Nat.mul_comm]
  have h3 : a.arg ^ (b.den * c.den) < c.arg ^ (b.den * a.den) := by
    rw [hmid] at h1; exact Nat.lt_of_lt_of_le h1 h2
  have h4 : (a.arg ^ c.den) ^ b.den < (c.arg ^ a.den) ^ b.den := by
    rw [← Nat.pow_mul, ← Nat.pow_mul, Nat.mul_comm c.den, Nat.mul_comm a.den]
    exact h3
  exact base_lt_of_pow_lt_pow h4

/-! ## What the order means -/

/-- **The bonus order is the power order.** For any number system in which `W·`
    and `√` are strictly increasing, clearing two positive denominators preserves
    order, `ln` turns a power into a multiple and is strictly increasing on the
    positive naturals, the implemented bonus `W · √(ln M / N)` of two well-formed
    pairs is ordered exactly as `Bonus`'s `<`. The premises are facts about the
    real numbers; they are parameters here, never axioms. -/
theorem bonus_order_is_power_order {K : Type} [LT K] [LE K] [Mul K] [Div K] [NatCast K] [OfNat K 0]
    (ln sqrt : K → K) (W : K)
    (hW : ∀ x y : K, W * x < W * y ↔ x < y)
    (hsqrt : ∀ x y : K, 0 ≤ x → 0 ≤ y → (sqrt x < sqrt y ↔ x < y))
    (hfrac : ∀ (x y : K) (n₁ n₂ : Nat), 0 < n₁ → 0 < n₂ →
      (x / (n₁ : K) < y / (n₂ : K) ↔ (n₂ : K) * x < (n₁ : K) * y))
    (hpow : ∀ m k : Nat, 0 < m → (k : K) * ln (m : K) = ln ((m ^ k : Nat) : K))
    (hln : ∀ a b : Nat, 0 < a → 0 < b → (ln (a : K) < ln (b : K) ↔ a < b))
    (hnonneg : ∀ m n : Nat, 0 < m → 0 < n → 0 ≤ ln (m : K) / (n : K))
    (a b : Bonus) (ha : a.WellFormed) (hb : b.WellFormed) :
    W * sqrt (ln (a.arg : K) / (a.den : K)) < W * sqrt (ln (b.arg : K) / (b.den : K)) ↔ a < b := by
  rw [hW, hsqrt _ _ (hnonneg _ _ ha.2 ha.1) (hnonneg _ _ hb.2 hb.1),
    hfrac _ _ _ _ ha.1 hb.1, hpow _ _ ha.2, hpow _ _ hb.2,
    hln _ _ (pow_pos_of_one_le ha.2 _) (pow_pos_of_one_le hb.2 _)]
  rfl

/-! ## A node whose join finds a parent row -/

/-- **From one visit on, the bonus falls strictly with the node's own visits.** -/
theorem bonus_falls_with_own_visits (m n n' : Nat) (hn : 1 ≤ n) (h : n < n') :
    bonusOf n' (some m) < bonusOf n (some m) := by
  show (logArgument (some m) n') ^ (max 1 n) < (logArgument (some m) n) ^ (max 1 n')
  simp only [logArgument, Option.getD_some]
  rw [Nat.max_eq_right hn, Nat.max_eq_right (by omega : 1 ≤ n')]
  exact Nat.pow_lt_pow_of_lt (by omega) h

/-- **From two on, the bonus rises strictly with the parent's visits.** -/
theorem bonus_rises_with_parent_visits (n m m' : Nat) (hm : 2 ≤ m) (h : m < m') :
    bonusOf n (some m) < bonusOf n (some m') := by
  show (logArgument (some m) n) ^ (max 1 n) < (logArgument (some m') n) ^ (max 1 n)
  simp only [logArgument, Option.getD_some]
  rw [Nat.max_eq_right hm, Nat.max_eq_right (by omega : 2 ≤ m')]
  exact pow_lt_pow_of_base_lt h (by omega)

/-- The first plateau: `max(1.0, s.visits)` gives an unvisited node the bonus of a
    once-visited one. -/
theorem unvisited_and_once_visited_tie (p : Option Nat) :
    (bonusOf 0 p).den = (bonusOf 1 p).den := rfl

/-- The second plateau: `max(2.0, …)` gives zero, one and two parent visits one
    bonus. -/
theorem parent_visits_below_two_tie (n : Nat) :
    bonusOf n (some 0) = bonusOf n (some 2) ∧ bonusOf n (some 1) = bonusOf n (some 2) := by
  constructor <;> rfl

/-! ## The root parents itself -/

/-- Every bonus is strictly above an exploration term of zero, because the log
    argument is floored at 2. So an open node, the root included, keeps a
    positive exploration term however often it is visited. -/
theorem every_bonus_is_positive (visits : Nat) (parentVisits : Option Nat) :
    zeroBonus < bonusOf visits parentVisits := by
  show 1 ^ (max 1 visits) < (logArgument parentVisits visits) ^ 1
  rw [Nat.one_pow, Nat.pow_one]
  simp only [logArgument]
  omega

/-- **The root's bonus rises from two visits to three**: 2³ < 3². So "the bonus
    falls as a node's visits grow" is false of the shipped query at the root. -/
theorem the_root_bonus_rises_from_two_visits_to_three :
    bonusOf 2 none < bonusOf 3 none := by decide

/-- From one visit to two the root's bonus falls. -/
theorem the_root_bonus_falls_from_one_visit_to_two :
    bonusOf 2 none < bonusOf 1 none := by decide

/-- (n+1)ⁿ < n⁽ⁿ⁺¹⁾ from n = 3 on: squaring n+1 beats n(n+2) by one, which
    carries the step. Stated at n = k + 3. -/
private theorem adjacent_powers : ∀ k : Nat, (k + 3 + 1) ^ (k + 3) < (k + 3) ^ (k + 3 + 1)
  | 0 => by decide
  | k + 1 => by
    have ih := adjacent_powers k
    -- with n = k + 3 the goal is (n + 2) ^ (n + 1) < (n + 1) ^ (n + 2)
    generalize hn : k + 3 = n at ih ⊢
    have e1 : k + 1 + 3 = n + 1 := by omega
    rw [e1]
    have hsq : n * (n + 2) < (n + 1) * (n + 1) := by
      simp only [Nat.mul_add, Nat.add_mul, Nat.mul_one, Nat.one_mul]; omega
    have h1 : (n * (n + 2)) ^ (n + 1) < ((n + 1) * (n + 1)) ^ (n + 1) :=
      pow_lt_pow_of_base_lt hsq (Nat.succ_pos n)
    rw [Nat.mul_pow, Nat.mul_pow] at h1
    have h2 : (n + 1) ^ n * (n + 2) ^ (n + 1) < n ^ (n + 1) * (n + 2) ^ (n + 1) :=
      Nat.mul_lt_mul_of_pos_right ih (pow_pos_of_one_le (by omega) _)
    have e : (n + 1) ^ (n + 1) * (n + 1) ^ (n + 1) = (n + 1) ^ n * (n + 1) ^ (n + 2) := by
      rw [← Nat.pow_add, ← Nat.pow_add]; congr 1; omega
    have h3 : (n + 1) ^ n * (n + 2) ^ (n + 1) < (n + 1) ^ n * (n + 1) ^ (n + 2) := by
      rw [← e]; exact Nat.lt_trans h2 h1
    have h4 := (Nat.mul_lt_mul_left (pow_pos_of_one_le (by omega : 1 ≤ n + 1) n)).mp h3
    show (n + 1 + 1) ^ (n + 1) < (n + 1) ^ (n + 1 + 1)
    exact h4

/-- One more visit lowers the root's bonus from three visits on. -/
private theorem root_step (n : Nat) (hn : 3 ≤ n) : bonusOf (n + 1) none < bonusOf n none := by
  have hk := adjacent_powers (n - 3)
  rw [show n - 3 + 3 = n by omega] at hk
  show (bonusOf (n + 1) none).arg ^ (bonusOf n none).den < (bonusOf n none).arg ^ (bonusOf (n + 1) none).den
  simp only [bonusOf, logArgument, Option.getD_none]
  rw [show max 2 (max 2 (n + 1)) = n + 1 by omega, show max 2 (max 2 n) = n by omega,
    show max 1 n = n by omega, show max 1 (n + 1) = n + 1 by omega]
  exact hk

/-- **From three visits on the root's bonus falls strictly**, so the rise from
    two to three is the only one. -/
theorem the_root_bonus_falls_from_three_visits_on (n d : Nat) (hn : 3 ≤ n) :
    bonusOf (n + 1 + d) none < bonusOf n none := by
  induction d with
  | zero => exact root_step n hn
  | succ d ih =>
    exact bonus_lt_trans _ _ _ (bonusOf_well_formed _ _)
      (root_step (n + 1 + d) (by omega)) ih

/-! ## The argmax

  `selectNode` is `ORDER BY score DESC LIMIT 1` over the rows its `WHERE` admits.
  The model is generic in the value column's type and in the score: `select` keeps
  the first of a tie, and the theorems below claim only what any tie-break gives,
  so SQLite's unspecified order among equal scores cannot falsify them. -/

/-- One `search_nodes` row, as `selectNode` reads it, with `V` the value column's type. -/
structure Row (V : Type) where
  id : String
  parent : Option String
  root : String
  status : NodeStatus
  depth : Nat
  visits : Nat
  value : V
  deriving Repr

/-- The `LEFT JOIN`: the visits of the row whose id is this row's `parent_id`, if
    the table holds one. -/
def parentVisitsIn {V : Type} (table : List (Row V)) (s : Row V) : Option Nat :=
  match s.parent with
  | none => none
  | some pid => (table.find? (fun p => p.id == pid)).map (·.visits)

/-- The `WHERE` clause: open, in this search's tree, and above the depth cap. -/
def eligible {V : Type} (rootId : String) (maxDepth : Nat) (s : Row V) : Bool :=
  s.status == .open_ && s.root == rootId && decide (s.depth < maxDepth)

/-- The score a row is ordered by, given how the value and the bonus combine. -/
def scoreIn {V S : Type} (score : V → Bonus → S) (table : List (Row V)) (r : Row V) : S :=
  score r.value (bonusOf r.visits (parentVisitsIn table r))

/-- One step of the scan: keep the incumbent unless the next row outranks it. -/
def keepBest {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S) (table : List (Row V))
    (best : Option (Row V)) (s : Row V) : Option (Row V) :=
  match best with
  | none => some s
  | some b => if ge (scoreIn score table b) (scoreIn score table s) then some b else some s

/-- `ORDER BY score DESC LIMIT 1` over the eligible rows. `ge x y` decides x ≥ y. -/
def select {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S) (table : List (Row V))
    (rootId : String) (maxDepth : Nat) : Option (Row V) :=
  (table.filter (eligible rootId maxDepth)).foldl (keepBest ge score table) none

private theorem fold_keepBest_mem {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (table : List (Row V)) :
    ∀ (xs : List (Row V)) (best : Option (Row V)) (r : Row V),
      xs.foldl (keepBest ge score table) best = some r → best = some r ∨ r ∈ xs
  | [], best, r, h => Or.inl h
  | x :: xs, best, r, h => by
    rw [List.foldl_cons] at h
    rcases fold_keepBest_mem ge score table xs _ r h with h' | h'
    · cases best with
      | none => simp [keepBest] at h'; exact Or.inr (h' ▸ List.mem_cons_self _ _)
      | some b =>
        simp only [keepBest] at h'
        split at h'
        · exact Or.inl h'
        · simp at h'; exact Or.inr (h' ▸ List.mem_cons_self _ _)
    · exact Or.inr (List.mem_cons_of_mem _ h')

private theorem fold_keepBest_some {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (table : List (Row V)) :
    ∀ (xs : List (Row V)) (b : Row V), ∃ r, xs.foldl (keepBest ge score table) (some b) = some r
  | [], b => ⟨b, rfl⟩
  | x :: xs, b => by
    rw [List.foldl_cons]
    simp only [keepBest]
    split
    · exact fold_keepBest_some ge score table xs b
    · exact fold_keepBest_some ge score table xs x

/-- The scan's result outranks the incumbent it started from and every row it read. -/
private theorem fold_keepBest_max {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (table : List (Row V))
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true) :
    ∀ (xs : List (Row V)) (best : Option (Row V)) (r : Row V),
      xs.foldl (keepBest ge score table) best = some r →
      (∀ b, best = some b → ge (scoreIn score table r) (scoreIn score table b) = true) ∧
      ∀ s ∈ xs, ge (scoreIn score table r) (scoreIn score table s) = true
  | [], best, r, h => by
    change best = some r at h
    refine ⟨fun b hb => ?_, fun s hs => absurd hs (List.not_mem_nil _)⟩
    rw [h] at hb; cases hb
    rcases htotal (scoreIn score table r) (scoreIn score table r) with h1 | h1 <;> exact h1
  | x :: xs, best, r, h => by
    rw [List.foldl_cons] at h
    have ih := fold_keepBest_max ge score table htotal htrans xs _ r h
    obtain ⟨hstep, hrest⟩ := ih
    cases best with
    | none =>
      have hx := hstep x rfl
      refine ⟨(fun b hb => by cases hb), fun s hs => ?_⟩
      rcases List.mem_cons.mp hs with rfl | hs
      · exact hx
      · exact hrest s hs
    | some b0 =>
      simp only [keepBest] at hstep
      by_cases hge : ge (scoreIn score table b0) (scoreIn score table x) = true
      · simp only [hge, if_true] at hstep
        have hb0 := hstep b0 rfl
        refine ⟨(fun b hb => by cases hb; exact hb0), fun s hs => ?_⟩
        rcases List.mem_cons.mp hs with rfl | hs
        · exact htrans _ _ _ hb0 hge
        · exact hrest s hs
      · simp only [hge] at hstep
        have hx := hstep x (by simp)
        have hxb : ge (scoreIn score table x) (scoreIn score table b0) = true := by
          rcases htotal (scoreIn score table x) (scoreIn score table b0) with h1 | h1
          · exact h1
          · exact absurd h1 hge
        refine ⟨(fun b hb => by cases hb; exact htrans _ _ _ hx hxb), fun s hs => ?_⟩
        rcases List.mem_cons.mp hs with rfl | hs
        · exact hx
        · exact hrest s hs

/-- **The selected row is one the `WHERE` admits**: open, in this tree, above the cap. -/
theorem select_is_eligible {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (table : List (Row V)) (rootId : String) (maxDepth : Nat) (r : Row V)
    (h : select ge score table rootId maxDepth = some r) :
    r ∈ table ∧ eligible rootId maxDepth r = true := by
  rcases fold_keepBest_mem ge score table _ none r h with h' | h'
  · cases h'
  · exact List.mem_filter.mp h'

/-- **The selected row outranks every eligible row**, for any total, transitive `≥`. -/
theorem select_is_maximal {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true)
    (table : List (Row V)) (rootId : String) (maxDepth : Nat) (r : Row V)
    (h : select ge score table rootId maxDepth = some r) :
    ∀ s ∈ table, eligible rootId maxDepth s = true →
      ge (scoreIn score table r) (scoreIn score table s) = true := by
  intro s hs he
  exact (fold_keepBest_max ge score table htotal htrans _ none r h).2 s
    (List.mem_filter.mpr ⟨hs, he⟩)

/-- **Nothing is selected exactly when no row is eligible.** The depth cap and the
    tree scope exclude rows; they never end a search that still has an eligible one. -/
theorem select_none_iff {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (table : List (Row V)) (rootId : String) (maxDepth : Nat) :
    select ge score table rootId maxDepth = none ↔
      ∀ s ∈ table, eligible rootId maxDepth s = false := by
  constructor
  · intro h s hs
    cases he : eligible rootId maxDepth s with
    | false => rfl
    | true =>
      exfalso
      have hmem : s ∈ table.filter (eligible rootId maxDepth) := List.mem_filter.mpr ⟨hs, he⟩
      obtain ⟨x, xs, hxs⟩ : ∃ x xs, table.filter (eligible rootId maxDepth) = x :: xs :=
        match hl : table.filter (eligible rootId maxDepth), hmem with
        | x :: xs, _ => ⟨x, xs, rfl⟩
      unfold select at h
      rw [hxs, List.foldl_cons] at h
      obtain ⟨r, hr⟩ := fold_keepBest_some ge score table xs x
      simp only [keepBest] at h
      rw [hr] at h
      cases h
  · intro h
    have hnil : table.filter (eligible rootId maxDepth) = [] := by
      rw [List.filter_eq_nil_iff]
      intro s hs
      simp [h s hs]
    simp [select, hnil]

/-- **A row that some eligible row strictly outranks is never selected.** -/
theorem an_outranked_row_is_never_selected {V S : Type} (ge : S → S → Bool) (score : V → Bonus → S)
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true)
    (table : List (Row V)) (rootId : String) (maxDepth : Nat) (a b : Row V)
    (ha : a ∈ table) (hea : eligible rootId maxDepth a = true)
    (hlt : ge (scoreIn score table b) (scoreIn score table a) = false) :
    select ge score table rootId maxDepth ≠ some b := by
  intro h
  have := select_is_maximal ge score htotal htrans table rootId maxDepth b h a ha hea
  rw [hlt] at this
  cases this

/-- **Of two eligible siblings with one value, the more visited one is never
    selected** once both have been visited: the score is the value plus a bonus
    that falls with the node's own visits. `hmono` says a larger bonus scores
    strictly higher at one value. -/
theorem the_more_visited_of_two_equal_siblings_is_never_selected {V S : Type}
    (ge : S → S → Bool) (score : V → Bonus → S)
    (htotal : ∀ x y, ge x y = true ∨ ge y x = true)
    (htrans : ∀ x y z, ge x y = true → ge y z = true → ge x z = true)
    (hmono : ∀ v k k', k < k' → ge (score v k) (score v k') = false)
    (table : List (Row V)) (rootId : String) (maxDepth : Nat) (a b : Row V) (m : Nat)
    (ha : a ∈ table) (hea : eligible rootId maxDepth a = true)
    (hpa : parentVisitsIn table a = some m) (hpb : parentVisitsIn table b = some m)
    (hv : a.value = b.value) (h1 : 1 ≤ a.visits) (hlt : a.visits < b.visits) :
    select ge score table rootId maxDepth ≠ some b := by
  apply an_outranked_row_is_never_selected ge score htotal htrans table rootId maxDepth a b ha hea
  simp only [scoreIn, hpa, hpb, hv]
  exact hmono _ _ _ (bonus_falls_with_own_visits m a.visits b.visits h1 hlt)

end Kinu.MCTS.Uct

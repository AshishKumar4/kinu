/-
  Proteus.Exploration.Records — S2, monotone displacement over a cell's best,
  and the strictly weaker property the vector case admits instead. 0 sorry.

  Models `ExplorationRecord` and `isBetter` (`objective.ts:369-442`) against
  `docs/EXPLORATION-SPEC.md` at 127a62c1, sections 5.2, 6.5 and 10.1 S2.

  -- TWO FINDINGS THIS MODEL PRODUCED, both stated here because they are results
  -- rather than commentary:

  1. **S2 is FALSE for the overwrite reading of section 5.2's "re-recording the
     same artifact updates it".** An update is a write. If the verifier is not
     deterministic — `unit:'ms'` is an explicit example at `objective.ts:286` —
     re-recording artifact A at 7ms over its recorded 3ms lowers `best(cell)` on a
     minimise objective. `overwrite_breaks_monotonicity` is that counterexample,
     machine-checked. S2 holds only if the update keeps the BETTER of the two
     values, which is how `insertRow` is defined below and is the amendment the
     spec needs.

  2. **S2 does not type-check against the `Objective` union 127a62c1 introduced.**
     S2 quantifies over `isBetter(candidate, incumbent, direction)` and one
     `direction`, but a `VectorObjective` carries one direction PER COMPONENT
     (`objective.ts:322-324`) and settles to a FRONT, so `best(cell)` is not
     defined for it. The scalar results below therefore carry an explicit scalar
     hypothesis, and the vector case gets a genuinely weaker property in its own
     section, NOT a generalisation of S2.

  -- WHAT THIS ABSTRACTION KEEPS: the cell's population, the direction, strict
  betterness including the tie rule, the update-by-digest, and eviction at
  capacity.

  -- WHAT IT DISCARDS, and whether the danger lives there:
  1. CONCURRENCY. One sequential write at a time. Two runs displacing the same
     cell are not modelled, and for a store this is a read-modify-write, so the
     danger DOES live there. Not closable by strengthening these proofs.
  2. `Int` FOR A SQLite REAL. See `Objective.lean`'s header. The tie rule makes
     the discard safe in the conservative direction: a spurious tie loses a
     displacement, it never manufactures one.
  3. THE NON-BEST POPULATION. Section 10.1 asks for monotonicity of `best(cell)`
     and that is what is proved. It is a WEAK invariant and the model says so:
     `eviction_can_destroy_the_population` shows a policy that discards every
     non-best member while leaving `best` monotone. Since the population is the
     entire reason section 5.2 rejects one-incumbent-per-objective — FunSearch's
     own worst arm — the danger genuinely lives in what S2 does not constrain, and
     no strengthening of S2 reaches it.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.Records

open Proteus.Exploration

/-! ## A cell of the records store -/

/-- One member of a cell. Identity within a cell is `artifactDigest`
    (`objective.ts:408-410`), and `value` is the RAW measured value, never the
    normalised score. -/
structure Row where
  digest : String
  value : Int
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A cell's best in the objective's direction (section 5.2). `none` for an empty
    cell. -/
def best (d : Direction) : List Row → Option Int
  | [] => none
  | r :: rs =>
    match best d rs with
    | none => some r.value
    | some w => some (if isBetter r.value w d then r.value else w)

/-- "Not worse than", with an empty cell strictly below everything. This is the
    order the monotone invariant is stated in, and the asymmetry at `none` is
    deliberate: a store that empties a cell HAS lost its best, and a relation
    that called that acceptable would make S2 unfalsifiable. -/
def notWorse (d : Direction) : Option Int → Option Int → Bool
  | _, .none => true
  | .none, .some _ => false
  | .some a, .some b => !(isBetter b a d)

theorem notWorse_refl (d : Direction) (x : Option Int) : notWorse d x x = true := by
  cases x with
  | none => rfl
  | some a => simp [notWorse, isBetter_irrefl]

theorem notWorse_trans (d : Direction) (x y z : Option Int)
    (hxy : notWorse d x y = true) (hyz : notWorse d y z = true) :
    notWorse d x z = true := by
  cases d <;> cases x <;> cases y <;> cases z <;>
    simp [notWorse, isBetter] at hxy hyz ⊢ <;> omega

/-! ### The characterisation of `best` -/

theorem best_nil (d : Direction) : best d [] = none := rfl

theorem best_none_iff (d : Direction) (rs : List Row) :
    best d rs = none ↔ rs = [] := by
  cases rs with
  | nil => simp [best]
  | cons r rs =>
    simp only [best]
    cases best d rs <;> simp

theorem best_cons (d : Direction) (r : Row) (rs : List Row) :
    best d (r :: rs) =
      match best d rs with
      | none => some r.value
      | some w => some (if isBetter r.value w d then r.value else w) := rfl

theorem best_cons_none (d : Direction) (r : Row) (rs : List Row)
    (h : best d rs = none) : best d (r :: rs) = some r.value := by
  rw [best_cons, h]

theorem best_cons_some (d : Direction) (r : Row) (rs : List Row) (w : Int)
    (h : best d rs = some w) :
    best d (r :: rs) = some (if isBetter r.value w d then r.value else w) := by
  rw [best_cons, h]

/-- The best is achieved by a member: it is never a number the store invented. -/
theorem best_mem (d : Direction) (rs : List Row) (v : Int) (h : best d rs = some v) :
    ∃ r ∈ rs, r.value = v := by
  induction rs with
  | nil => simp [best] at h
  | cons r rs ih =>
    cases hr : best d rs with
    | none =>
      rw [best_cons_none d r rs hr, Option.some.injEq] at h
      exact ⟨r, List.mem_cons_self _ _, h⟩
    | some w =>
      rw [best_cons_some d r rs w hr, Option.some.injEq] at h
      by_cases hb : isBetter r.value w d = true
      · rw [if_pos hb] at h
        exact ⟨r, List.mem_cons_self _ _, h⟩
      · simp only [Bool.not_eq_true] at hb
        rw [if_neg (by simp [hb])] at h
        subst h
        obtain ⟨x, hx, hxv⟩ := ih hr
        exact ⟨x, List.mem_cons_of_mem _ hx, hxv⟩

/-- Nothing in the cell beats the best. -/
theorem best_notWorse_mem (d : Direction) (rs : List Row) (r : Row) (h : r ∈ rs) :
    notWorse d (best d rs) (some r.value) = true := by
  induction rs with
  | nil => exact absurd h (List.not_mem_nil r)
  | cons x rs ih =>
    cases hr : best d rs with
    | none =>
      have hnil : rs = [] := (best_none_iff d rs).mp hr
      subst hnil
      have hrx : r = x := by simpa using h
      subst hrx
      rw [best_cons_none d r [] rfl]
      simp [notWorse, isBetter_irrefl]
    | some w =>
      rw [best_cons_some d x rs w hr]
      rcases List.mem_cons.mp h with hh | hh
      · subst hh
        by_cases hb : isBetter r.value w d = true
        · rw [if_pos hb]; simp [notWorse, isBetter_irrefl]
        · simp only [Bool.not_eq_true] at hb
          rw [if_neg (by simp [hb])]
          simpa [notWorse] using hb
      · have hw : notWorse d (some w) (some r.value) = true := by
          rw [← hr]; exact ih hh
        by_cases hb : isBetter x.value w d = true
        · rw [if_pos hb]
          refine notWorse_trans d _ (some w) _ ?_ hw
          simpa [notWorse] using isBetter_asymm _ _ d hb
        · simp only [Bool.not_eq_true] at hb
          rw [if_neg (by simp [hb])]
          exact hw

/-- The master step every monotonicity proof below uses: if some member of the new
    cell is not worse than the old best, the new best is not worse than it
    either. -/
theorem best_notWorse_of_witness (d : Direction) (rs : List Row) (x : Row) (b : Int)
    (hx : x ∈ rs) (hb : notWorse d (some x.value) (some b) = true) :
    notWorse d (best d rs) (some b) = true :=
  notWorse_trans d _ (some x.value) _ (best_notWorse_mem d rs x hx) hb

/-! ## The write, with the update that keeps the better value

  Section 5.2, corrected by finding 1 in this file's header. -/

/-- Merge a re-recorded value with what the cell already had for that artifact:
    keep whichever is better in the objective's direction. A tie keeps the
    incumbent, which is section 5.2's tie rule. -/
def mergeValue (d : Direction) (fresh incumbent : Int) : Int :=
  if isBetter fresh incumbent d then fresh else incumbent

theorem mergeValue_notWorse (d : Direction) (fresh incumbent : Int) :
    notWorse d (some (mergeValue d fresh incumbent)) (some incumbent) = true := by
  by_cases hb : isBetter fresh incumbent d = true
  · simp only [mergeValue, if_pos hb]
    simpa [notWorse] using isBetter_asymm _ _ d hb
  · simp only [Bool.not_eq_true] at hb
    simp [mergeValue, hb, notWorse, isBetter_irrefl]

/-- A write to a cell (section 5.2). A new artifact is inserted; re-recording an
    existing artifact keeps the better value under the one digest. Defined over
    the BEST of the same-digest rows rather than over "the" same-digest row, so
    the result does not depend on a uniqueness invariant holding — it holds
    anyway, and `insertRow_unique_digest` proves the write maintains it. -/
def insertRow (d : Direction) (rs : List Row) (r : Row) : List Row :=
  let same := rs.filter (fun x => x.digest == r.digest)
  let others := rs.filter (fun x => x.digest != r.digest)
  let v :=
    match best d same with
    | none => r.value
    | some w => mergeValue d r.value w
  { digest := r.digest, value := v } :: others

/-- **S2 for the insert half: a write never worsens the cell's best.** -/
theorem insertRow_monotone (d : Direction) (rs : List Row) (r : Row) :
    notWorse d (best d (insertRow d rs r)) (best d rs) = true := by
  cases hb : best d rs with
  | none => simp [notWorse]
  | some b =>
    obtain ⟨x, hx, hxv⟩ := best_mem d rs b hb
    by_cases hd : x.digest = r.digest
    · -- `x` is a same-digest row, so the merged head carries its value forward.
      have hxs : x ∈ rs.filter (fun y => y.digest == r.digest) :=
        List.mem_filter.mpr ⟨hx, by simp [hd]⟩
      have hnw : notWorse d (best d (rs.filter (fun y => y.digest == r.digest)))
          (some x.value) = true :=
        best_notWorse_mem d _ x hxs
      cases hs : best d (rs.filter (fun y => y.digest == r.digest)) with
      | none => rw [hs] at hnw; simp [notWorse] at hnw
      | some w =>
        rw [hs] at hnw
        refine best_notWorse_of_witness d _
          { digest := r.digest, value := mergeValue d r.value w } b ?_ ?_
        · simp [insertRow, hs]
        · refine notWorse_trans d _ (some w) _ (mergeValue_notWorse d r.value w) ?_
          rw [← hxv]; exact hnw
    · -- `x` keeps its own row, untouched by the write.
      have hxo : x ∈ rs.filter (fun y => y.digest != r.digest) :=
        List.mem_filter.mpr ⟨hx, by simp [hd]⟩
      refine best_notWorse_of_witness d _ x b ?_ ?_
      · simp only [insertRow]
        exact List.mem_cons_of_mem _ hxo
      · rw [hxv]; exact notWorse_refl d (some b)

/-- The write maintains one row per digest, so the cell stays a map keyed by
    `artifactDigest` as the DDL makes it. -/
theorem insertRow_unique_digest (d : Direction) (rs : List Row) (r : Row) :
    ∀ y ∈ (insertRow d rs r).tail, y.digest ≠ r.digest := by
  intro y hy
  simp only [insertRow, List.tail_cons] at hy
  have := (List.mem_filter.mp hy).2
  simpa using this

/-! ### Finding 1, machine-checked: the overwrite reading breaks S2 -/

/-- Section 5.2's "re-recording the same artifact updates it", read as an
    overwrite rather than as a merge. -/
def overwriteRow (rs : List Row) (r : Row) : List Row :=
  r :: rs.filter (fun x => x.digest != r.digest)

/-- **Overwriting on re-record makes the cell's best go backwards.**

    Artifact `a` recorded at 3, re-measured at 7 on a minimise objective — which
    is not a hypothetical, it is what a wall-clock unit does on a second run
    (`objective.ts:286` names `'ms'`). The store's best moves from 3 to 7 and S2
    fails. This is why `insertRow` merges rather than overwrites, and it is a
    correction the spec needs at section 5.2 rather than a modelling choice. -/
theorem overwrite_breaks_monotonicity :
    notWorse .minimise
        (best .minimise (overwriteRow [{ digest := "a", value := 3 }]
          { digest := "a", value := 7 }))
        (best .minimise [{ digest := "a", value := 3 }]) = false := by
  decide

/-- The merging write does not have that defect on the same input, which is the
    pair that makes the finding actionable rather than merely alarming. -/
theorem merge_survives_the_same_input :
    notWorse .minimise
        (best .minimise (insertRow .minimise [{ digest := "a", value := 3 }]
          { digest := "a", value := 7 }))
        (best .minimise [{ digest := "a", value := 3 }]) = true := by
  decide

/-! ## Eviction at capacity

  Section 5.2: "the worst member by `value` in the objective's direction is
  evicted". The load-bearing fact is that the evicted member is not the best —
  reverse the direction sign in eviction and the store evicts its own leader,
  which is exactly the "three call sites must move in lockstep" hazard
  `objective.ts:376-380` names. -/

theorem isBetter_flip (a b : Int) (d : Direction) :
    isBetter a b d.flip = isBetter b a d := by
  cases d <;> simp [isBetter, Direction.flip]

/-- The worst member's value: the best in the flipped direction. -/
def worstValue (d : Direction) (rs : List Row) : Option Int := best d.flip rs

/-- Drop the first row carrying this value. -/
def removeFirstWithValue (v : Int) : List Row → List Row
  | [] => []
  | r :: rs => if r.value == v then rs else r :: removeFirstWithValue v rs

/-- Evict one worst member. -/
def removeWorst (d : Direction) (rs : List Row) : List Row :=
  match worstValue d rs with
  | none => rs
  | some w => removeFirstWithValue w rs

theorem removeFirst_subset (v : Int) (rs : List Row) (x : Row)
    (h : x ∈ removeFirstWithValue v rs) : x ∈ rs := by
  induction rs with
  | nil => exact absurd h (List.not_mem_nil x)
  | cons r rs ih =>
    simp only [removeFirstWithValue] at h
    by_cases hv : (r.value == v) = true
    · rw [if_pos hv] at h; exact List.mem_cons_of_mem _ h
    · simp only [Bool.not_eq_true] at hv
      rw [if_neg (by simp [hv])] at h
      rcases List.mem_cons.mp h with hh | hh
      · exact hh ▸ List.mem_cons_self _ _
      · exact List.mem_cons_of_mem _ (ih hh)

/-- A row whose value is not the evicted one survives eviction. -/
theorem mem_removeFirst_of_ne (v : Int) (rs : List Row) (x : Row)
    (hx : x ∈ rs) (hne : x.value ≠ v) : x ∈ removeFirstWithValue v rs := by
  induction rs with
  | nil => exact absurd hx (List.not_mem_nil x)
  | cons r rs ih =>
    simp only [removeFirstWithValue]
    by_cases hv : (r.value == v) = true
    · rw [if_pos hv]
      rcases List.mem_cons.mp hx with hh | hh
      · exact absurd (show x.value = v by rw [hh]; simpa using hv) hne
      · exact hh
    · simp only [Bool.not_eq_true] at hv
      rw [if_neg (by simp [hv])]
      rcases List.mem_cons.mp hx with hh | hh
      · exact hh ▸ List.mem_cons_self _ _
      · exact List.mem_cons_of_mem _ (ih hh)

theorem length_removeFirst (v : Int) (rs : List Row) :
    rs.length ≤ (removeFirstWithValue v rs).length + 1 := by
  induction rs with
  | nil => simp [removeFirstWithValue]
  | cons r rs ih =>
    simp only [removeFirstWithValue]
    by_cases hv : (r.value == v) = true
    · rw [if_pos hv]; simp
    · simp only [Bool.not_eq_true] at hv
      rw [if_neg (by simp [hv])]
      simp only [List.length_cons]
      omega

/-- When the best and the worst coincide the cell is constant, which is the case
    eviction has to be handled separately for: there is no non-best row to drop,
    so the invariant survives only because every remaining row still achieves the
    best. -/
theorem constant_of_best_eq_worst (d : Direction) (rs : List Row) (b : Int)
    (hb : best d rs = some b) (hw : worstValue d rs = some b) :
    ∀ x ∈ rs, x.value = b := by
  intro x hx
  have h₁ : notWorse d (some b) (some x.value) = true := by
    rw [← hb]; exact best_notWorse_mem d rs x hx
  have h₂ : notWorse d.flip (some b) (some x.value) = true := by
    rw [← hw]; exact best_notWorse_mem d.flip rs x hx
  simp only [notWorse, Bool.not_eq_true'] at h₁ h₂
  rw [isBetter_flip] at h₂
  exact (isBetter_total x.value b d (by simpa using h₁) (by simpa using h₂))

/-- **Eviction does not worsen the cell's best**, provided the cell has something
    besides the member being dropped. This is the half of S2 that is not
    definitional: it is true because eviction is ordered by the SAME `isBetter`
    the best is, in the flipped direction. -/
theorem removeWorst_monotone (d : Direction) (rs : List Row) (hlen : 2 ≤ rs.length) :
    notWorse d (best d (removeWorst d rs)) (best d rs) = true := by
  cases hb : best d rs with
  | none => simp [notWorse]
  | some b =>
    cases hw : worstValue d rs with
    | none =>
      -- an empty cell cannot have length 2
      have : rs = [] := (best_none_iff d.flip rs).mp hw
      subst this; simp at hlen
    | some w =>
      simp only [removeWorst, hw]
      by_cases hbw : b = w
      · -- constant cell: whatever survives still achieves `b`
        subst hbw
        have hconst := constant_of_best_eq_worst d rs b hb hw
        have hne : (removeFirstWithValue b rs) ≠ [] := by
          intro hnil
          have := length_removeFirst b rs
          rw [hnil] at this
          simp at this
          omega
        obtain ⟨x, hx⟩ : ∃ x, x ∈ removeFirstWithValue b rs := by
          cases hr : removeFirstWithValue b rs with
          | nil => exact absurd hr hne
          | cons y ys => exact ⟨y, List.mem_cons_self _ _⟩
        refine best_notWorse_of_witness d _ x b hx ?_
        rw [hconst x (removeFirst_subset b rs x hx)]
        exact notWorse_refl d (some b)
      · -- the best differs from the evicted value, so a best-achiever survives
        obtain ⟨x, hxm, hxv⟩ := best_mem d rs b hb
        have hxne : x.value ≠ w := by rw [hxv]; exact hbw
        refine best_notWorse_of_witness d _ x b
          (mem_removeFirst_of_ne w rs x hxm hxne) ?_
        rw [hxv]; exact notWorse_refl d (some b)

/-! ## S2, assembled -/

/-- One write to a cell: insert or update, then evict if over capacity
    (section 5.2). -/
def applyWrite (d : Direction) (cap : Nat) (rs : List Row) (r : Row) : List Row :=
  let rs' := insertRow d rs r
  if cap < rs'.length then removeWorst d rs' else rs'

/-- **S2: the records store is monotone in the objective's direction.**

    `best(cell)` never worsens across any write. Section 10.1's S2, restricted —
    per finding 2 in this file's header — to a SCALAR objective, which is the only
    kind for which `best(cell)` and a single `direction` are defined.

    `1 ≤ cap` is required and the requirement is not bookkeeping: at capacity zero
    a write inserts and then immediately evicts what it inserted, and if the cell
    held only that artifact the store loses its best. A cell capacity of zero is
    not a small archive, it is a store that evicts its own leader. -/
theorem write_monotone (d : Direction) (cap : Nat) (rs : List Row) (r : Row)
    (hcap : 1 ≤ cap) :
    notWorse d (best d (applyWrite d cap rs r)) (best d rs) = true := by
  simp only [applyWrite]
  by_cases hev : cap < (insertRow d rs r).length
  · rw [if_pos hev]
    refine notWorse_trans d _ (best d (insertRow d rs r)) _ ?_
      (insertRow_monotone d rs r)
    exact removeWorst_monotone d _ (by omega)
  · rw [if_neg hev]
    exact insertRow_monotone d rs r

/-- **S2 over a whole run: no finite sequence of writes worsens a cell's best.**
    The reachability form, which is what a leaderboard needs: it is not enough
    that one write is safe. -/
def applyWrites (d : Direction) (cap : Nat) (rs : List Row) : List Row → List Row :=
  List.foldl (applyWrite d cap) rs

theorem writes_monotone (d : Direction) (cap : Nat) (rs : List Row) (ws : List Row)
    (hcap : 1 ≤ cap) :
    notWorse d (best d (applyWrites d cap rs ws)) (best d rs) = true := by
  induction ws generalizing rs with
  | nil => exact notWorse_refl d _
  | cons w ws ih =>
    simp only [applyWrites, List.foldl_cons]
    exact notWorse_trans d _ (best d (applyWrite d cap rs w)) _
      (ih (applyWrite d cap rs w)) (write_monotone d cap rs w hcap)

/-- Sharpness: a strictly better candidate DOES displace, so S2 is not the
    statement that the store never changes. -/
theorem better_candidate_displaces :
    best .minimise (applyWrite .minimise 4 [{ digest := "a", value := 9 }]
      { digest := "b", value := 2 }) = some 2 := by
  decide

/-- And a tie does not displace (section 5.2: "a tie carries no signal"). -/
theorem tie_does_not_displace :
    applyWrite .minimise 4 [{ digest := "a", value := 5 }]
      { digest := "a", value := 5 } = [{ digest := "a", value := 5 }] := by
  decide

/-! ### What S2 does not constrain, stated as a theorem

  S2 is monotone over the cell's BEST. It says nothing about the population, and
  the population is the entire reason section 5.2 refuses one-incumbent-per
  objective: a single best per objective IS best-of-N-with-carry, FunSearch's own
  "W/O Evolution" arm and one of its two worst curves at matched program count.
  So a policy can satisfy S2 while destroying exactly what `carry:'elites'`
  needs. -/

/-- A cell reduced to its single best member satisfies S2 and is nonetheless the
    ablation arm section 5.2 exists to avoid. This is the honest limit of S2: the
    invariant the spec asked Lean to prove cannot see the defect the spec's own
    citation is about. -/
theorem eviction_can_destroy_the_population :
    notWorse .minimise
        (best .minimise [{ digest := "a", value := 1 }])
        (best .minimise [{ digest := "a", value := 1 },
                         { digest := "b", value := 2 },
                         { digest := "c", value := 3 }]) = true
    ∧ ([{ digest := "a", value := 1 }] : List Row).length = 1 := by
  refine ⟨by decide, rfl⟩

/-! ## The vector case — a strictly weaker property, not a generalisation

  Finding 2. A `VectorObjective` has one direction per component
  (`objective.ts:322-324`) and `advance:'pareto'` settles to a front
  (`Settle.lean`), so there is no `best(cell)` to be monotone in. What replaces it
  must be stated exactly, and it is weaker in a specific way: the front may SHRINK
  — many members replaced by one that dominates them all — so no member is
  guaranteed to persist. What is guaranteed is that nothing leaves the front
  except to something that dominates it. -/

structure VRow where
  digest : String
  values : List Int
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Weakly better: not strictly worse. -/
def weaklyBetter (a b : Int) (d : Direction) : Bool := !(isBetter b a d)

def allWeaklyBetter : List Int → List Int → List Direction → Bool
  | [], [], [] => true
  | a :: as, b :: bs, d :: ds => weaklyBetter a b d && allWeaklyBetter as bs ds
  | _, _, _ => false

def someStrictlyBetter : List Int → List Int → List Direction → Bool
  | [], [], [] => false
  | a :: as, b :: bs, d :: ds => isBetter a b d || someStrictlyBetter as bs ds
  | _, _, _ => false

/-- Pareto domination: weakly better in every component and strictly better in at
    least one. -/
def dominates (a b : List Int) (ds : List Direction) : Bool :=
  allWeaklyBetter a b ds && someStrictlyBetter a b ds

theorem someStrictlyBetter_irrefl (a : List Int) (ds : List Direction) :
    someStrictlyBetter a a ds = false := by
  induction a generalizing ds with
  | nil => cases ds <;> rfl
  | cons x xs ih =>
    cases ds with
    | nil => rfl
    | cons d dsr => simp [someStrictlyBetter, isBetter_irrefl, ih]

theorem dominates_irrefl (a : List Int) (ds : List Direction) :
    dominates a a ds = false := by
  simp [dominates, someStrictlyBetter_irrefl]

/-- **Domination is not a total order: incomparable pairs exist.** This is why the
    vector case cannot reuse S2 — `isBetter_total` (`Objective.lean`) says two
    scalar values that neither beats are EQUAL, and that is exactly what fails
    here. -/
theorem dominates_admits_incomparable :
    ∃ (a b : List Int) (ds : List Direction),
      a ≠ b ∧ dominates a b ds = false ∧ dominates b a ds = false :=
  ⟨[1, 5], [5, 1], [.minimise, .minimise], by decide, by decide, by decide⟩

/-- **A front over one dimension is an argmax.** Section 6.5 refuses
    `advance:'pareto'` with a scalar objective for exactly this reason, and here
    it is forced rather than asserted: with a single component, domination and
    strict betterness coincide, so the "front" is a single winner and reporting a
    frontier of size 1 as a success is the degeneracy `VectorObjective` was added
    to prevent. -/
theorem single_component_is_argmax (a b : Int) (d : Direction) :
    dominates [a] [b] [d] = isBetter a b d := by
  cases d <;> simp [dominates, allWeaklyBetter, someStrictlyBetter, weaklyBetter,
    isBetter] <;> omega

/-- The non-dominated members. -/
def front (ds : List Direction) (ms : List VRow) : List VRow :=
  ms.filter (fun m => !ms.any (fun n => dominates n.values m.values ds))

theorem front_subset (ds : List Direction) (ms : List VRow) (m : VRow)
    (h : m ∈ front ds ms) : m ∈ ms := (List.mem_filter.mp h).1

/-- A front member is dominated by nothing in the cell — so the front is what it
    claims to be, with no phantom members. -/
theorem front_undominated (ds : List Direction) (ms : List VRow) (m : VRow)
    (h : m ∈ front ds ms) : ∀ n ∈ ms, dominates n.values m.values ds = false := by
  have h2 := (List.mem_filter.mp h).2
  simp only [Bool.not_eq_true', List.any_eq_false] at h2
  intro n hn
  simpa using h2 n hn

/-- **The vector analogue of S2: the front never loses ground.**

    After a write, every previous front member either is STILL on the front or is
    dominated by the incoming member. Weaker than S2 in a precise way, and the
    weakness is not a modelling artefact: with no total order there is no single
    quantity to be monotone in, so the strongest available statement is that
    membership is lost only to a dominator. -/
theorem front_insert_no_loss (ds : List Direction) (ms : List VRow) (r : VRow) :
    ∀ m ∈ front ds ms,
      m ∈ front ds (r :: ms) ∨ dominates r.values m.values ds = true := by
  intro m hm
  have hms : m ∈ ms := front_subset ds ms m hm
  have hnone := front_undominated ds ms m hm
  by_cases hr : dominates r.values m.values ds = true
  · exact Or.inr hr
  · refine Or.inl (List.mem_filter.mpr ⟨List.mem_cons_of_mem _ hms, ?_⟩)
    simp only [Bool.not_eq_true', List.any_eq_false]
    intro n hn
    rcases List.mem_cons.mp hn with hn | hn
    · subst hn; simpa using hr
    · simpa using hnone n hn

/-- Sharpness: the front genuinely does shrink when a dominator arrives, which is
    why the theorem above is a disjunction rather than a persistence claim. -/
theorem front_can_shrink :
    front [.minimise, .minimise]
        [{ digest := "a", values := [3, 3] }, { digest := "b", values := [1, 1] }]
      = [{ digest := "b", values := [1, 1] }] := by
  decide

end Proteus.Exploration.Records

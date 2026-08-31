/-
  Kinu.Exploration.ArchiveAdmission — the novelty rejection test, and what it
  does and does not bound. 0 sorry.

  Models `admitToArchive` (`packages/core/src/strategy/archive.ts:205-232`): the
  nearest-occupant search, the floor comparison at `archive.ts:227`, and the
  identical-artifact exclusion at `archive.ts:220`.

  `Archive.lean` models S5, the descriptor partition, and its header names exactly
  the gap this file is for: "What covers it is not this file: it is section 6.5's
  OTHER archive refusal, the novelty rejection test."

  ================================================================
  THE FINDING, and it is the reason this file exists rather than the theorem it was
  written to prove.
  ================================================================

  `archive.ts:32-39` justifies having no eviction rule like this:

      "nothing is ever deleted from a cell, because the thing that bounds a cell's
      population is the admission test rather than a row cap — a candidate too
      close to an occupant never lands, so a cell cannot accumulate the near-copies
      an eviction rule would exist to remove."

  Two claims are welded together there and only one of them is true.

  TRUE, and proved below as an invariant over every finite admitted sequence: a
  cell's occupants are pairwise at least `novelty` apart. No near-copy is ever in
  the cell, so the specific population a de-duplicating eviction rule would remove
  is empty — `separation_is_invariant` and `no_near_copy_is_reachable`.

  FALSE: that this BOUNDS THE POPULATION. Separation bounds similarity, not
  cardinality. `separated_cells_are_unboundedly_large` exhibits, for every `n`, a
  trace of `n` writes from an empty cell in which every write is admitted, the
  result satisfies the invariant, and the cell holds `n` occupants. The distance it
  uses is not a device: `noveltyDistance` returns exactly `1` for two artifacts
  sharing no token — `shared = 0`, so `1 - 0/union = 1` (`archive.ts:143`) — and
  exactly `0` for the same artifact, so on a family of artifacts with pairwise
  disjoint vocabularies `noveltyDistance` IS the function used below, and `1` is the
  strictest floor the unit interval admits. A cell can therefore grow without bound
  on mutually-novel members and nothing trims it.

  So the absence of an eviction rule is NOT licensed by the admission test. What the
  admission test licenses is the absence of a DE-DUPLICATION rule, which is a
  different rule. This is Pugh et al.'s filled-grid-of-junk at the scale of one cell
  rather than of the grid — the failure `Archive.lean`'s header attributes to the
  grid and offers the novelty test as the answer to. The novelty test is the answer
  to the collapse in the other direction, Rainbow Teaming's archive collapsing onto
  one prompt; it is not the answer to this one.

  A real population bound needs a bounded vocabulary: at `novelty = 1` the occupants
  have pairwise disjoint token sets, so a cell is bounded by the number of tokens
  available, and nothing in `archive.ts`, `records.ts` or `SwarmAdvanceSetting`
  bounds that. No number is invented here in its place.

  -- WHAT THIS ABSTRACTION KEEPS: the nearest-occupant search including its tie
  order, the floor comparison and its direction, the identical-artifact exclusion,
  the absence of removal, and the refusal's payload.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. THE DISTANCE'S ARITHMETIC. `dist` is a parameter and `noveltyDistance`'s
     token-set Jaccard is one instantiation. Nothing below reads anything of it
     beyond a comparison, which is the point: the admission rule's behaviour is a
     property of the COMPARISON, so an inverted `noveltyDistance` satisfies every
     theorem here. The scale is discarded the way `floorRoom` discards its
     denominator — only the sign of a comparison decides anything. The danger DOES
     live there and what covers it is a mutation, not this file.

  2. THE FLOOR'S VALUE. `novelty` is a parameter here because it is a parameter
     there: `swarm.ts:189-197` refuses to declare one and section 6.3 never stated a
     τ. Every theorem below is universally quantified over it, which is the only
     honest treatment of a number the specification declines to invent.

  3. THE SEAL. `admitToArchive` checks `admitsPublication` before it reads a single
     occupant (`archive.ts:215-217`). That check is modelled in `RecordsStore.lean`,
     whose `verdict` refuses `sealed` ahead of everything else; repeating it here
     would be a second copy of one rule.

  4. THE COST OF THE SCAN. `cellOccupants` has no `LIMIT`, so admission is a linear
     read of a cell this file proves unbounded. That is a consequence of the finding
     rather than a separate one, and it is recorded, not modelled.
-/

import Kinu.Exploration.Objective

namespace Kinu.Exploration.ArchiveAdmission

open Kinu.Exploration

/-! ## The nearest-occupant search

  A left fold in the cell's own order keeping a STRICTLY closer occupant, because
  that is what `archive.ts:219-223` is: `if (nearest === null || distance <
  nearest.distance)`. The strictness decides the tie order — the first of two
  equally close occupants is the one named — and `cellOccupants` returns the cell
  best-first, so the tie order is observable. -/

/-- One occupant considered. An occupant carrying the candidate's own artifact is
    skipped entirely (`archive.ts:220`): a re-record is the monotone rule's
    business, never an admission question. -/
def nearerOf (dist : Nat → Nat → Int) (a : Nat)
    (acc : Option (Nat × Int)) (o : Nat) : Option (Nat × Int) :=
  if o = a then acc
  else
    match acc with
    | none => some (o, dist a o)
    | some (p, w) => if dist a o < w then some (o, dist a o) else some (p, w)

/-- The nearest occupant and its distance, or `none` for a cell with no occupant
    other than the candidate itself. -/
def nearestFrom (dist : Nat → Nat → Int) (a : Nat) (os : List Nat) : Option (Nat × Int) :=
  os.foldl (nearerOf dist a) none

/-- The floor test, `archive.ts:227`: STRICTLY below the floor refuses, so the floor
    itself admits. -/
def belowFloor (ν : Int) : Option (Nat × Int) → Bool
  | none => false
  | some (_, w) => w < ν

/-- `ArchiveVerdict`'s archive-specific arm (`archive.ts:171-176`), carrying the
    occupant it collided with and the distance: a refusal that cannot name what it
    collided with is not actionable. -/
inductive Verdict where
  | recorded
  | tooClose (occupant : Nat) (distance : Int)
  deriving Repr, BEq, DecidableEq, Inhabited

def admit (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) (a : Nat) : Verdict :=
  match nearestFrom dist a os with
  | some (p, w) => if w < ν then .tooClose p w else .recorded
  | none => .recorded

/-- What an admitted candidate does to the population. An artifact already present
    updates its own row rather than adding one, because `record_key` derives from
    `artifactDigest` and the store's write is an `UPDATE` on a key collision
    (`records.ts:436-447`). -/
def landed (os : List Nat) (a : Nat) : List Nat := if a ∈ os then os else a :: os

def stepOf (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) (a : Nat) : List Nat :=
  match admit dist ν os a with
  | .recorded => landed os a
  | .tooClose _ _ => os

/-- A finite sequence of archive writes. There is no other action, because the
    archive has no removal — which is the fact under examination. -/
def runOf (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) : List Nat → List Nat :=
  List.foldl (stepOf dist ν) os

theorem runOf_append (dist : Nat → Nat → Int) (ν : Int) (os as bs : List Nat) :
    runOf dist ν os (as ++ bs) = runOf dist ν (runOf dist ν os as) bs := by
  simp [runOf, List.foldl_append]

/-! ## The search is equivalent to the universal condition

  "Find the nearest, then compare" and "no occupant is inside the floor" are the
  same predicate. That is neither obvious nor free: it is what makes the minimum the
  right accumulator, and it fails the moment the fold keeps the farthest instead —
  `inverting_the_search_admits_a_near_copy`. -/

theorem belowFloor_foldl (dist : Nat → Nat → Int) (ν : Int) (a : Nat) (os : List Nat)
    (acc : Option (Nat × Int)) :
    belowFloor ν (os.foldl (nearerOf dist a) acc) = true
      ↔ (belowFloor ν acc = true ∨ ∃ o ∈ os, o ≠ a ∧ dist a o < ν) := by
  induction os generalizing acc with
  | nil => simp [belowFloor]
  | cons o os ih =>
    rw [List.foldl_cons, ih (nearerOf dist a acc o)]
    by_cases hoa : o = a
    · -- The candidate's own artifact contributes nothing, in either direction.
      simp only [nearerOf]
      rw [if_pos hoa]
      constructor
      · rintro (h | ⟨x, hx, hxa, hxd⟩)
        · exact Or.inl h
        · exact Or.inr ⟨x, List.mem_cons_of_mem _ hx, hxa, hxd⟩
      · rintro (h | ⟨x, hx, hxa, hxd⟩)
        · exact Or.inl h
        · rcases List.mem_cons.mp hx with rfl | hx
          · exact absurd hoa hxa
          · exact Or.inr ⟨x, hx, hxa, hxd⟩
    · have hstep : belowFloor ν (nearerOf dist a acc o) = true
          ↔ (belowFloor ν acc = true ∨ dist a o < ν) := by
        cases acc with
        | none => simp [nearerOf, hoa, belowFloor]
        | some pw =>
          obtain ⟨p, w⟩ := pw
          simp only [nearerOf]
          rw [if_neg hoa]
          by_cases hlt : dist a o < w
          · rw [if_pos hlt]
            simp only [belowFloor, decide_eq_true_eq]
            omega
          · rw [if_neg hlt]
            simp only [belowFloor, decide_eq_true_eq]
            omega
      rw [hstep]
      constructor
      · rintro ((h | h) | ⟨x, hx, hxa, hxd⟩)
        · exact Or.inl h
        · exact Or.inr ⟨o, List.mem_cons_self _ _, hoa, h⟩
        · exact Or.inr ⟨x, List.mem_cons_of_mem _ hx, hxa, hxd⟩
      · rintro (h | ⟨x, hx, hxa, hxd⟩)
        · exact Or.inl (Or.inl h)
        · rcases List.mem_cons.mp hx with rfl | hx
          · exact Or.inl (Or.inr hxd)
          · exact Or.inr ⟨x, hx, hxa, hxd⟩

theorem tooClose_iff_belowFloor (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) (a : Nat) :
    (∃ p w, admit dist ν os a = .tooClose p w) ↔ belowFloor ν (nearestFrom dist a os) = true := by
  cases hn : nearestFrom dist a os with
  | none => simp [admit, belowFloor, hn]
  | some pw =>
    obtain ⟨p, w⟩ := pw
    by_cases hlt : w < ν
    · simp [admit, belowFloor, hn, hlt]
    · simp [admit, belowFloor, hn, hlt]

/-- **The nearest-then-compare search refuses exactly when some occupant is inside
    the floor.** The equivalence the implementation rests on. -/
theorem refuses_iff_an_occupant_is_too_close (dist : Nat → Nat → Int) (ν : Int)
    (os : List Nat) (a : Nat) :
    (∃ p w, admit dist ν os a = .tooClose p w) ↔ ∃ o ∈ os, o ≠ a ∧ dist a o < ν := by
  rw [tooClose_iff_belowFloor]
  simp only [nearestFrom]
  rw [belowFloor_foldl dist ν a os none]
  simp [belowFloor]

/-- The constructive half, in the form the invariant proofs use: a candidate no
    occupant is inside the floor of is admitted. -/
theorem admitted_of_all_far (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) (a : Nat)
    (h : ∀ o ∈ os, o = a ∨ ν ≤ dist a o) : admit dist ν os a = .recorded := by
  cases hv : admit dist ν os a with
  | recorded => rfl
  | tooClose p w =>
    exfalso
    obtain ⟨o, ho, hoa, hod⟩ :=
      (refuses_iff_an_occupant_is_too_close dist ν os a).mp ⟨p, w, hv⟩
    rcases h o ho with rfl | hge
    · exact hoa rfl
    · omega

/-- And the other half: an admitted candidate really is clear of every occupant. -/
theorem admitted_is_far_from_every_occupant (dist : Nat → Nat → Int) (ν : Int)
    (os : List Nat) (a : Nat) (h : admit dist ν os a = .recorded) :
    ∀ o ∈ os, o = a ∨ ν ≤ dist a o := by
  intro o ho
  by_cases hoa : o = a
  · exact Or.inl hoa
  · refine Or.inr ?_
    by_cases hlt : dist a o < ν
    · exfalso
      obtain ⟨p, w, hv⟩ :=
        (refuses_iff_an_occupant_is_too_close dist ν os a).mpr ⟨o, ho, hoa, hlt⟩
      rw [h] at hv
      simp at hv
    · omega

/-! ## The true invariant: no near-copy is ever in a cell -/

/-- Every two distinct occupants are at least the floor apart. -/
def Separated (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) : Prop :=
  ∀ x ∈ os, ∀ y ∈ os, x ≠ y → ν ≤ dist x y

/-- Symmetry is a HYPOTHESIS on the results that need it, never an axiom — the
    discipline `Publication.lean` uses for digest injectivity. `noveltyDistance` is
    symmetric because Jaccard overlap is (`archive.ts:136-144` reads both token sets
    the same way), and `discreteDist_symm` discharges it for the witness below, so
    nothing here rests on an assumption nothing satisfies. -/
theorem step_preserves_separation (dist : Nat → Nat → Int) (ν : Int) (os : List Nat)
    (a : Nat) (hsym : ∀ x y, dist x y = dist y x) (hsep : Separated dist ν os) :
    Separated dist ν (stepOf dist ν os a) := by
  cases hv : admit dist ν os a with
  | tooClose p w =>
    have hstep : stepOf dist ν os a = os := by simp [stepOf, hv]
    rw [hstep]; exact hsep
  | recorded =>
    have hfar := admitted_is_far_from_every_occupant dist ν os a hv
    by_cases hmem : a ∈ os
    · have hstep : stepOf dist ν os a = os := by simp [stepOf, hv, landed, hmem]
      rw [hstep]; exact hsep
    · have hstep : stepOf dist ν os a = a :: os := by simp [stepOf, hv, landed, hmem]
      rw [hstep]
      intro x hx y hy hxy
      rcases List.mem_cons.mp hx with hxa | hx
      · rcases List.mem_cons.mp hy with hya | hy
        · exact absurd (hxa.trans hya.symm) hxy
        · rw [hxa]
          exact (hfar y hy).resolve_left (fun h => hxy (hxa.trans h.symm))
      · rcases List.mem_cons.mp hy with hya | hy
        · rw [hya] at hxy
          rw [hya, hsym]
          exact (hfar x hx).resolve_left hxy
        · exact hsep x hx y hy hxy

/-- **Separation is an invariant of every finite sequence of archive writes.** The
    reachability form: no path of admitted writes puts two near-copies in one cell,
    so the population a de-duplicating rule would exist to remove is empty. -/
theorem separation_is_invariant (dist : Nat → Nat → Int) (ν : Int) (os : List Nat)
    (as : List Nat) (hsym : ∀ x y, dist x y = dist y x) (hsep : Separated dist ν os) :
    Separated dist ν (runOf dist ν os as) := by
  induction as generalizing os with
  | nil => exact hsep
  | cons a as ih =>
    simp only [runOf, List.foldl_cons]
    exact ih (stepOf dist ν os a) (step_preserves_separation dist ν os a hsym hsep)

/-- **From an empty cell, no near-copy is reachable at all.** The empty cell is
    separated for free, so the invariant assumes no starting condition. -/
theorem no_near_copy_is_reachable (dist : Nat → Nat → Int) (ν : Int) (as : List Nat)
    (hsym : ∀ x y, dist x y = dist y x) :
    Separated dist ν (runOf dist ν [] as) :=
  separation_is_invariant dist ν [] as hsym
    (by intro x hx; exact absurd hx (List.not_mem_nil x))

/-! ## The finding: separation does not bound the population -/

/-- `noveltyDistance` restricted to a family of artifacts with pairwise disjoint
    vocabularies, where it is exactly this function — see this file's header. -/
def discreteDist (a b : Nat) : Int := if a = b then 0 else 1

theorem discreteDist_of_ne (a b : Nat) (h : a ≠ b) : discreteDist a b = 1 := by
  simp [discreteDist, h]

theorem discreteDist_symm (a b : Nat) : discreteDist a b = discreteDist b a := by
  by_cases h : a = b
  · rw [h]
  · rw [discreteDist_of_ne a b h, discreteDist_of_ne b a (Ne.symm h)]

/-- The cell `freshTrace n` leaves behind: `n` distinct artifacts. -/
def descending : Nat → List Nat
  | 0 => []
  | n + 1 => n :: descending n

/-- `n` writes of mutually-novel artifacts, in the order a run produces them. -/
def freshTrace : Nat → List Nat
  | 0 => []
  | n + 1 => freshTrace n ++ [n]

theorem descending_length (n : Nat) : (descending n).length = n := by
  induction n with
  | zero => rfl
  | succ n ih => simp [descending, ih]

theorem lt_of_mem_descending (n m : Nat) (h : m ∈ descending n) : m < n := by
  induction n with
  | zero => exact absurd h (List.not_mem_nil m)
  | succ n ih =>
    rcases List.mem_cons.mp h with rfl | h
    · exact Nat.lt_succ_self m
    · exact Nat.lt_succ_of_lt (ih h)

theorem fresh_run (n : Nat) : runOf discreteDist 1 [] (freshTrace n) = descending n := by
  induction n with
  | zero => rfl
  | succ n ih =>
    have hnot : n ∉ descending n := fun h =>
      absurd (lt_of_mem_descending n n h) (Nat.lt_irrefl n)
    have hadm : admit discreteDist 1 (descending n) n = .recorded := by
      refine admitted_of_all_far discreteDist 1 (descending n) n ?_
      intro o ho
      have hne : o ≠ n := fun h => absurd (h ▸ lt_of_mem_descending n o ho) (Nat.lt_irrefl n)
      refine Or.inr ?_
      rw [discreteDist_symm, discreteDist_of_ne o n hne]
      exact Int.le_refl 1
    rw [freshTrace, runOf_append, ih]
    simp [runOf, stepOf, hadm, landed, hnot, descending]

/-- **For every `n`, a reachable cell that satisfies the invariant and holds `n`
    occupants.**

    Every write in the trace is admitted, the result is separated, and the population
    is `n`. So the admission test does not bound a cell's population, and
    `archive.ts:32-39`'s reason for having no eviction rule does not establish what
    it claims: it establishes the absence of near-copies, which is a different
    property. Reported as a finding, not weakened into a bound. -/
theorem separated_cells_are_unboundedly_large (n : Nat) :
    (runOf discreteDist 1 [] (freshTrace n)).length = n
    ∧ Separated discreteDist 1 (runOf discreteDist 1 [] (freshTrace n)) := by
  refine ⟨?_, no_near_copy_is_reachable discreteDist 1 (freshTrace n) discreteDist_symm⟩
  rw [fresh_run]
  exact descending_length n

/-- And the growth is not an artefact of the refusal being unreachable: at the same
    floor a repeat of an occupant is admitted and the population does NOT grow, so
    the two behaviours are distinguished. -/
theorem a_repeat_does_not_grow_the_population :
    stepOf discreteDist 1 [3, 1] 1 = [3, 1] := by decide

/-! ## Sharpness: the refusal fires, names the nearest, and reads the floor as a floor

  A small distance table with an intermediate value, which the discrete metric
  cannot supply. Symmetric by construction: every branch reads only `a = b` and
  `a + b`. -/

def demoDist (a b : Nat) : Int :=
  if a = b then 0
  else if a + b = 1 then 2
  else if a + b = 3 then 5
  else 6

/-- **A near-copy is refused, and the refusal names the occupant it collided with
    and the distance.** -/
theorem a_near_copy_is_refused_and_names_the_occupant :
    admit demoDist 5 [1] 0 = .tooClose 1 2 := by decide

/-- **An empty cell admits**: there is no occupant to be too close to. -/
theorem an_empty_cell_admits : admit demoDist 5 [] 0 = .recorded := by decide

/-- **The threshold is read as a FLOOR.** At distance exactly `5` a floor of `5`
    admits and a floor of `6` refuses, so `archive.ts:227`'s comparison is `<` and
    not `<=`. This is the comparison a silent inversion lives in. -/
theorem the_threshold_is_read_as_a_floor :
    admit demoDist 5 [2] 1 = .recorded ∧ admit demoDist 6 [2] 1 = .tooClose 2 5 := by
  refine ⟨by decide, by decide⟩

/-- **The identical artifact is excluded from the comparison**, so a re-record can
    never be refused as too close — it falls through to the monotone rule instead
    (`archive.ts:220`). At distance `0` from itself it would otherwise be the nearest
    occupant there is. -/
theorem an_identical_artifact_is_not_a_near_copy :
    admit demoDist 5 [0] 0 = .recorded := by decide

/-- **The nearest occupant is named, not whichever the cell was sorted on top.** -/
theorem the_refusal_names_the_nearest :
    admit demoDist 6 [2, 1] 0 = .tooClose 1 2 := by decide

/-! ### The search direction is load-bearing -/

/-- The same fold keeping the FARTHEST occupant — the inversion of
    `archive.ts:222`'s `distance < nearest.distance`. -/
def fartherOf (dist : Nat → Nat → Int) (a : Nat)
    (acc : Option (Nat × Int)) (o : Nat) : Option (Nat × Int) :=
  if o = a then acc
  else
    match acc with
    | none => some (o, dist a o)
    | some (p, w) => if w < dist a o then some (o, dist a o) else some (p, w)

def admitByFarthest (dist : Nat → Nat → Int) (ν : Int) (os : List Nat) (a : Nat) : Verdict :=
  match os.foldl (fartherOf dist a) none with
  | some (p, w) => if w < ν then .tooClose p w else .recorded
  | none => .recorded

/-- **Invert the search and the near-copy lands.** A cell holding one far occupant
    and one near one admits the near-copy, because the farthest clears the floor. The
    `<` inside the fold is therefore a second comparison that can invert silently,
    distinct from the floor test — and no separation property is violated in the one
    step that does it, so only a mutation catches it. -/
theorem inverting_the_search_admits_a_near_copy :
    admit demoDist 5 [2, 1] 0 = .tooClose 1 2
    ∧ admitByFarthest demoDist 5 [2, 1] 0 = .recorded := by
  refine ⟨by decide, by decide⟩

end Kinu.Exploration.ArchiveAdmission

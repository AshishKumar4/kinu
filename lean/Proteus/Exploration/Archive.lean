/-
  Proteus.Exploration.Archive — S5, the descriptor partition. 0 sorry.

  Models `ExplorationRecord.descriptor` (`objective.ts:401-407`). Specified by
  docs/EXPLORATION.md — "The archive", "Presets" and "The Lean invariants".

  -- WHAT THIS ABSTRACTION KEEPS: the shape of the binning decision — whether one
  candidate maps to exactly one cell — and the shape of a coverage report.

  -- WHAT IT DISCARDS, and whether the danger lives there. Both answers matter and
  they differ:

  1. EXTRACTION. `functional_descriptor_partitions` holds because a Lean function is total
     and single-valued. That is not a discovery, it is the statement that IF
     descriptor extraction is a total function THEN S5 holds — and the danger
     lives ENTIRELY in that antecedent:
     *How a descriptor is produced is unspecified* records exactly that. So the
     useful half of this file is not the positive theorem, it is
     `judged_descriptor_breaks_partition`: a descriptor that can bin one candidate
     two ways REFUTES S5, which turns *The archive*'s refusal of a judged archive key
     from a preference into a forced consequence.
     `bucketOf` then discharges the antecedent for one concrete extraction, so S5
     is not left resting on an assumption nothing satisfies.

  2. QUALITY. The archive's coverage claim is about BINNING, never about worth. A
     full archive of junk satisfies every theorem here, and
     `full_coverage_says_nothing_about_quality` proves it rather than leaving a
     reader to hope otherwise. That is Pugh et al.'s result — "the grid is
     completely filled … but many bins contain low-quality behaviors" — and the
     danger DOES live in this discarded part. What covers it is not this file: it
     is *The archive*'s OTHER refusal, the novelty rejection test, whose
     absence Rainbow Teaming measured collapsing an archive onto one prompt across
     every cell while still reporting coverage.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.Archive

open Proteus.Exploration

/-- A candidate as the archive sees it: an identity, the behaviour a descriptor
    reads, and a quality the descriptor does NOT read. Keeping `value` here and
    unused by `bucketOf` is the point — it is what makes
    `full_coverage_says_nothing_about_quality` sayable. -/
structure Candidate where
  digest : String
  behaviour : Int
  value : Int
  deriving Repr, BEq, Inhabited

/-! ## S5 — total and disjoint

  S5 is the descriptor partition *The Lean invariants* names for this module,
  stated as `∀ c, ∃! cell, inCell c cell`, i.e. one predicate carrying both
  halves: totality is the `∃`, disjointness is the uniqueness. -/

/-- "Exactly one", spelled out. Lean 4 core has no `∃!` notation and this corpus
    takes no Mathlib dependency (`lean/lakefile.lean`), so the two halves S5
    bundles are written explicitly: `k` exists, and any `k'` that also holds is
    that same `k`. -/
def UniqueCell (P : Nat → Prop) : Prop :=
  ∃ k : Nat, P k ∧ ∀ k' : Nat, P k' → k' = k

/-- S5, verbatim: every candidate maps to exactly one cell. -/
def PartitionsTotally (InCell : Candidate → Nat → Prop) : Prop :=
  ∀ c : Candidate, UniqueCell (InCell c)

/-- A descriptor that is a FUNCTION satisfies S5. By construction — a Lean
    function is total and single-valued — and labelled as such. -/
theorem functional_descriptor_partitions (desc : Candidate → Nat) :
    PartitionsTotally (fun c k => desc c = k) := by
  intro c
  exact ⟨desc c, rfl, fun _ hk => hk.symm⟩

/-- **A descriptor that can bin one candidate two ways refutes S5.**

    This is *The archive*'s refusal of `archive` + judged descriptor, as a forced
    consequence rather than a preference: judge variance in the archive KEY is not
    a ranking error that can be re-ranked, it is a partition that is not a
    partition, and everything the archive reports downstream is then a claim about
    a structure it does not have. Pugh et al.'s mis-binned elite is silently
    lost because there is no cell it can be looked up in. -/
theorem judged_descriptor_breaks_partition
    (InCell : Candidate → Nat → Prop) (c : Candidate) (k₁ k₂ : Nat)
    (hne : k₁ ≠ k₂) (h₁ : InCell c k₁) (h₂ : InCell c k₂) :
    ¬ PartitionsTotally InCell := by
  intro hp
  obtain ⟨k, _, huniq⟩ := hp c
  exact hne ((huniq k₁ h₁).trans (huniq k₂ h₂).symm)

/-- And a descriptor that can bin a candidate NOWHERE refutes S5 too — the other
    half of totality, which a partial extraction (a regex that did not match, a
    tool call that returned nothing) is exactly how you get. *Merge-back*'s rule
    applies: when a fact is missing, degrade toward less authority. There is no
    "the unnamed cell" to degrade into, which is why `descriptor` is NULL for NO
    PARTITION and NULL is not a cell (`objective.ts:401-407`). -/
theorem partial_descriptor_breaks_partition
    (InCell : Candidate → Nat → Prop) (c : Candidate)
    (h : ∀ k : Nat, ¬ InCell c k) :
    ¬ PartitionsTotally InCell := by
  intro hp
  obtain ⟨k, hk, _⟩ := hp c
  exact h k hk

/-! ## One concrete extraction that discharges S5's antecedent

  *How a descriptor is produced is unspecified* leaves descriptor extraction exactly
  that, so the positive theorem above rests on a hypothesis nothing in the tree yet
  satisfies. `bucketOf` is a witness that the hypothesis is satisfiable by something
  cheap and mechanical: count the declared boundaries the behaviour exceeds. -/

/-- The cell index of a behaviour, against a list of declared boundaries. Total
    for every behaviour and every boundary list, including the empty one (which
    is the single-cell archive). -/
def bucketOf (behaviour : Int) (bounds : List Int) : Nat :=
  (bounds.filter (fun b => b < behaviour)).length

/-- `bucketOf` lands inside the declared grid, so a candidate never bins outside
    the archive it is being counted against. `n` boundaries give `n+1` cells. -/
theorem bucketOf_in_grid (behaviour : Int) (bounds : List Int) :
    bucketOf behaviour bounds < bounds.length + 1 :=
  Nat.lt_succ_of_le (List.length_filter_le _ _)

/-- The grid `bucketOf` bins into. -/
def gridOf (bounds : List Int) : List Nat := List.range (bounds.length + 1)

theorem bucketOf_mem_grid (behaviour : Int) (bounds : List Int) :
    bucketOf behaviour bounds ∈ gridOf bounds :=
  List.mem_range.mpr (bucketOf_in_grid behaviour bounds)

/-- So `bucketOf` satisfies S5, and S5's antecedent is discharged by a
    construction rather than assumed. -/
theorem bucketOf_partitions (bounds : List Int) :
    PartitionsTotally (fun c k => bucketOf c.behaviour bounds = k) :=
  functional_descriptor_partitions (fun c => bucketOf c.behaviour bounds)

/-! ## Coverage, and what it does and does not claim -/

/-- Did anything land in this cell? -/
def covered (desc : Candidate → Nat) (cs : List Candidate) (k : Nat) : Bool :=
  cs.any (fun c => desc c == k)

/-- How many cells of the declared grid have a member. -/
def coverageCount (desc : Candidate → Nat) (cs : List Candidate) (grid : List Nat) : Nat :=
  (grid.filter (covered desc cs)).length

/-- **No phantom coverage: a cell reported as covered has a member.** The
    archive's coverage number is the thing `research` and `audit` return
    (*Presets*), so a coverage count that could exceed what landed would be the
    one number those presets exist to produce, wrong. -/
theorem covered_has_a_member (desc : Candidate → Nat) (cs : List Candidate) (k : Nat)
    (h : covered desc cs k = true) : ∃ c ∈ cs, desc c = k := by
  simp only [covered, List.any_eq_true, beq_iff_eq] at h
  obtain ⟨c, hc, hk⟩ := h
  exact ⟨c, hc, hk⟩

/-- And nothing that landed is lost from the count, provided the grid contains its
    cell — which `bucketOf_mem_grid` guarantees for the concrete extraction. -/
theorem member_is_covered (desc : Candidate → Nat) (cs : List Candidate) (c : Candidate)
    (h : c ∈ cs) : covered desc cs (desc c) = true := by
  simp only [covered, List.any_eq_true, beq_iff_eq]
  exact ⟨c, h, rfl⟩

/-- Coverage never exceeds the grid. -/
theorem coverageCount_le_grid (desc : Candidate → Nat) (cs : List Candidate)
    (grid : List Nat) : coverageCount desc cs grid ≤ grid.length :=
  List.length_filter_le _ _

/-- A saturated filter keeps everything. Proved here because Lean 4 core carries
    no `length_filter_eq_length` and this corpus takes no Mathlib dependency. -/
theorem all_of_filter_length_eq (p : Nat → Bool) (l : List Nat)
    (h : (l.filter p).length = l.length) : ∀ k ∈ l, p k = true := by
  induction l with
  | nil => intro k hk; exact absurd hk (List.not_mem_nil k)
  | cons a t ih =>
    by_cases hp : p a = true
    · rw [List.filter_cons_of_pos hp, List.length_cons, List.length_cons] at h
      have ht : (t.filter p).length = t.length := by omega
      intro k hk
      rcases List.mem_cons.mp hk with hk | hk
      · subst hk; exact hp
      · exact ih ht k hk
    · simp only [Bool.not_eq_true] at hp
      rw [List.filter_cons_of_neg (by simp [hp]), List.length_cons] at h
      exact absurd h (by have := List.length_filter_le p t; omega)

/-- Full coverage means every declared cell has a member — so the number means
    what a reader takes it to mean. -/
theorem full_coverage_fills_every_cell (desc : Candidate → Nat) (cs : List Candidate)
    (grid : List Nat) (h : coverageCount desc cs grid = grid.length) :
    ∀ k ∈ grid, covered desc cs k = true :=
  all_of_filter_length_eq (covered desc cs) grid h

/-! ### The limitation, proved rather than promised

  Everything above is about BINNING. None of it is about worth, and the archive
  presets report coverage as their result. So the model states the gap as a
  theorem: a set of candidates can fill the grid completely while every one of
  them is worthless. -/

/-- A two-cell grid filled by two candidates whose quality is the direction's
    worst. Coverage reports 2 of 2. This is Pugh et al.'s finding inside the
    model, and it is why *The archive*'s OTHER refusal — the novelty
    rejection test — is not optional. -/
theorem full_coverage_says_nothing_about_quality :
    ∃ (desc : Candidate → Nat) (cs : List Candidate) (grid : List Nat),
      coverageCount desc cs grid = grid.length
      ∧ grid.length = 2
      ∧ (∀ c ∈ cs, c.value = 0) := by
  refine ⟨fun c => c.behaviour.toNat,
    [{ digest := "a", behaviour := 0, value := 0 },
     { digest := "b", behaviour := 1, value := 0 }],
    [0, 1], by decide, rfl, ?_⟩
  intro c hc
  simp at hc
  rcases hc with h | h <;> simp [h]

/-- Sharpness: coverage is not vacuously full. An archive whose candidates all
    land in one cell reports 1 of 2, which is what makes the theorem above a
    statement about quality rather than about the counter. -/
theorem collapsed_archive_reports_partial_coverage :
    coverageCount (fun c => c.behaviour.toNat)
      [{ digest := "a", behaviour := 0, value := 9 },
       { digest := "b", behaviour := 0, value := 9 }] [0, 1] = 1 := by
  decide

end Proteus.Exploration.Archive

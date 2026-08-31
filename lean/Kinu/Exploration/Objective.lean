/-
  Kinu.Exploration.Objective — the objective's direction, what a verifier may
  return, and the floor's two declaration-time checks. 0 sorry.

  Models `packages/core/src/strategy/objective.ts`. Specified by
  docs/EXPLORATION.md — "The objective", "The closed verifier registry" and
  "The floor".

  -- Model assumption, stated because it is the one that matters:
  A measured value is an `Int`, never a `Float`. Lean's `Float` is opaque and
  admits no order reasoning, and this corpus already refuses Float proofs
  (`MCTS/Backpropagation.lean:9-20` replaced them with exact scaled integers).
  So a value here is the RAW measurement scaled by a fixed positive factor.
  Every statement below is an order or equality statement and is division-free,
  so nothing is rounded away INSIDE the model — but IEEE-754 comparison in
  TypeScript and in a SQLite REAL column is not what is proved.

  WHAT THAT DISCARDS, and whether the danger lives there: two measurements
  differing below the scale factor compare EQUAL here and may compare unequal in
  production. *The records store*'s tie rule makes that the safe direction — a spurious
  tie loses a displacement, it never manufactures one — so the danger does NOT
  live in the discarded part for the monotonicity results. It DOES live there for
  any future claim about `floorMargin`'s division, which is why the floor results
  below are stated on the numerator alone.
-/

namespace Kinu.Exploration

/-! ## Direction and strict betterness -/

/-- Which way is better (`objective.ts:44`). Two values and no default: a number
    without a direction is not an objective, and guessing "higher is better"
    silently inverts every cost. -/
inductive Direction where
  | minimise
  | maximise
  deriving Repr, BEq, DecidableEq, Inhabited

/-- The opposite direction. `worst = best` in the flipped direction, which is how
    eviction is defined without a second recursion. -/
def Direction.flip : Direction → Direction
  | .minimise => .maximise
  | .maximise => .minimise

/-- `objective.ts:382-386`. STRICTLY better: a tie does not displace, because a
    tie carries no signal and `ORDER BY value DESC` over equal values is row
    order (`mcts/convergence.ts:56-93` is the live precedent). -/
def isBetter (cand inc : Int) : Direction → Bool
  | .minimise => cand < inc
  | .maximise => inc < cand

theorem isBetter_irrefl (v : Int) (d : Direction) : isBetter v v d = false := by
  cases d <;> simp [isBetter]

theorem isBetter_asymm (a b : Int) (d : Direction) (h : isBetter a b d = true) :
    isBetter b a d = false := by
  cases d <;> simp [isBetter] at h ⊢ <;> omega

theorem isBetter_trans (a b c : Int) (d : Direction)
    (hab : isBetter a b d = true) (hbc : isBetter b c d = true) :
    isBetter a c d = true := by
  cases d <;> simp [isBetter] at hab hbc ⊢ <;> omega

/-- The scalar case is TOTAL up to ties: two values that neither beats the other
    are equal. This is what makes the vector case genuinely different rather than
    a generalisation for its own sake — see `Records.lean`, where incomparability
    is exhibited as a theorem. -/
theorem isBetter_total (a b : Int) (d : Direction)
    (hab : isBetter a b d = false) (hba : isBetter b a d = false) : a = b := by
  cases d <;> simp [isBetter] at hab hba <;> omega

/-! ## What a verifier may return -/

/-- Everything a verifier may return (`objective.ts:103`).

    Note what is NOT a constructor: there is no way to say "the verifier itself
    broke". That is the mechanism, not an oversight — a broken instrument throws,
    and the harness must not convert a throw into an `unmeasurable`. The
    consequence is `measurement_cannot_report_fault` below and the halting
    results in `Publication.lean`. -/
inductive Measurement where
  | measured (value : Int)
  | unmeasurable (detail : String)
  deriving Repr, BEq, Inhabited

/-- A fault is unrepresentable in the verifier's return type. Two constructors,
    so this is a by-construction witness rather than a discovery: its value is
    that the model's `Measurement` cannot be widened without this failing. -/
theorem measurement_cannot_report_fault (m : Measurement) :
    (∃ v : Int, m = .measured v) ∨ (∃ dt : String, m = .unmeasurable dt) := by
  cases m with
  | measured v => exact Or.inl ⟨v, rfl⟩
  | unmeasurable dt => exact Or.inr ⟨dt, rfl⟩

/-! ## The floor -/

/-- How the bound was established (`objective.ts:159`). -/
inductive FloorKind where
  | certificate
  | adversary
  | physical
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Only `certificate` and `physical` are admissible AS floors. An `adversary`
    bound is a worst case, and using one as a floor scores a lucky honest run as a
    cheat (`hard-tasks/tasks.ts:29-39`). The type keeps `adversary` as a DECLARABLE
    value that is refused, so an author is told why instead of quietly relabelling
    it — which is why this is a predicate over a three-valued type rather than a
    two-valued type. -/
def FloorKind.admissible : FloorKind → Bool
  | .certificate => true
  | .adversary => false
  | .physical => true

theorem adversary_is_declarable_and_refused :
    FloorKind.admissible .adversary = false
    ∧ FloorKind.admissible .certificate = true
    ∧ FloorKind.admissible .physical = true := by
  refine ⟨rfl, rfl, rfl⟩

structure Floor where
  value : Int
  kind : FloorKind
  /-- The measured cost of the best honest solution known when the floor was
      written (`objective.ts:160-169`). REQUIRED, and it is the mechanical half
      of the floor's proof. -/
  bestKnownHonest : Int
  deriving Repr, BEq, Inhabited

/-- Does this measurement cross the floor, on the side `direction` makes
    impossible? -/
def breaches (v : Int) (f : Floor) : Direction → Bool
  | .minimise => v < f.value
  | .maximise => f.value < v

/-- The floor's room to the best known honest cost — the NUMERATOR of
    `floorMargin()` (`objective.ts:190-195`).

    Division-free on purpose. `floorMargin` divides by `|bestKnownHonest|`, and a
    division by a positive quantity cannot change a sign, so the sign convention
    — the one thing about that function that can be wrong, and the exact class of
    mistake the majority-vote floor was — is decided entirely here. What is
    discarded is the magnitude, i.e. the reported percentage; C3 requires the
    magnitude to be SURFACED and explicitly forbids thresholding it
    (*Floor margin*), so no decision depends on the discarded part. -/
def floorRoom (f : Floor) : Direction → Int
  | .minimise => f.bestKnownHonest - f.value
  | .maximise => f.value - f.bestKnownHonest

/-- **C1 and C2 are the same check on two different numbers.** The margin is
    negative exactly when the best known honest solution would itself breach the
    floor (C1), which is C2's condition applied to the DECLARED best-known cost
    instead of to the measured baseline.

    This is the sign-convention theorem. Getting the convention backwards
    inverts the check the function exists to perform, and `objective.ts:185-188`
    names that as the reason the function is named rather than inlined. -/
theorem floorRoom_neg_iff_bestKnown_breaches (f : Floor) (d : Direction) :
    (floorRoom f d < 0) ↔ (breaches f.bestKnownHonest f d = true) := by
  cases d <;> simp [floorRoom, breaches] <;> omega

/-- A run refuses at declaration time when the floor is refuted by its own
    best-known cost, and refuses at first measurement when the measured baseline
    breaches it (C1, C2). Total, so there is no third outcome in which a refuted
    floor is carried into the run. -/
def floorAdmissible (f : Floor) (baseline : Int) (d : Direction) : Bool :=
  f.kind.admissible && !breaches f.bestKnownHonest f d && !breaches baseline f d

theorem floorAdmissible_rejects_negative_margin (f : Floor) (baseline : Int)
    (d : Direction) (h : floorRoom f d < 0) : floorAdmissible f baseline d = false := by
  have hb : breaches f.bestKnownHonest f d = true :=
    (floorRoom_neg_iff_bestKnown_breaches f d).mp h
  simp [floorAdmissible, hb]

theorem floorAdmissible_rejects_breaching_baseline (f : Floor) (baseline : Int)
    (d : Direction) (h : breaches baseline f d = true) :
    floorAdmissible f baseline d = false := by
  simp [floorAdmissible, h]

theorem floorAdmissible_rejects_adversary (f : Floor) (baseline : Int)
    (d : Direction) (h : f.kind = .adversary) :
    floorAdmissible f baseline d = false := by
  simp [floorAdmissible, h, FloorKind.admissible]

/-! ### The majority-vote floor, as a witness that C1 is not the check that
     caught it

  The majority-vote numbers (`hard-tasks/tasks.ts:192-206`), with `MAJORITY.n = 1200`
  and a `minimise` objective in oracle calls. C1 and C2 would NOT have caught this
  floor and C3 — the reported margin, which *Floor margin* requires the caller be
  SHOWN — is what would. These two theorems are that claim, mechanised: the
  defective floor passes the admissibility check, and its room is a thin but
  POSITIVE 594 out of 2992. A model that could not exhibit the escape would be
  claiming more for the mechanical checks than they deliver. -/

/-- The defective floor: `2*(n-1) = 2398` against a best known honest cost of
    2992 (`tasks.ts:198`, `tasks.ts:192`). -/
def majorityVoteOldFloor : Floor :=
  { value := 2398, kind := .certificate, bestKnownHonest := 2992 }

/-- The corrected floor, `n = 1200` (`tasks.ts:206`). -/
def majorityVoteFixedFloor : Floor :=
  { value := 1200, kind := .certificate, bestKnownHonest := 2992 }

theorem old_majority_floor_escapes_c1 :
    floorRoom majorityVoteOldFloor .minimise = 594
    ∧ floorAdmissible majorityVoteOldFloor 2992 .minimise = true := by
  refine ⟨rfl, rfl⟩

theorem fixed_majority_floor_has_more_room :
    floorRoom majorityVoteOldFloor .minimise
      < floorRoom majorityVoteFixedFloor .minimise := by
  decide

/-- C1 is not vacuous: a floor that exceeds its own best known honest cost is
    refused. Without this the `floorAdmissible` results above would be consistent
    with a predicate that accepts everything. -/
theorem c1_refuses_a_refuted_floor :
    floorAdmissible { value := 3000, kind := .certificate, bestKnownHonest := 2992 }
      2992 .minimise = false := by
  decide

end Kinu.Exploration

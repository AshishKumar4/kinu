/-
  Proteus.Exploration.RecordsStore — monotone best over every finite write
  sequence the shipped store admits. 0 sorry.

  Models `recordExploration` (`packages/core/src/strategy/records.ts:403-467`) and
  the seal it consults first (`admitsPublication`, `objective.ts:445-450`).

  -- WHY THIS IS A SECOND FILE AND NOT A SECTION OF `Records.lean`, and the
  -- disagreement is the whole point:

  `Records.lean` models section 5.2's cell — a CAPPED population with an eviction
  policy, whose write MERGES a re-record to the better of the two values
  (`insertRow`). The store that shipped does neither. It has no capacity and no
  eviction, and its write is the OVERWRITE that `Records.overwrite_breaks_monotonicity`
  refutes: `records.ts:436-447` sets `value = ${write.value}` unconditionally once
  admission passed. So the two models are about different objects and the shipped
  one is the weaker write.

  What makes the shipped store monotone anyway is that the overwrite is UNREACHABLE
  for a lowering value: `records.ts:422-427` returns `{kind:'refused',
  cause:'not-better'}` before it. Monotonicity there is therefore not a rule the
  store enforces — it is a CONSEQUENCE of two rules that are each about something
  else, and this file's job is to show the consequence follows and that both
  premises are load-bearing:

    1. the refusal — `an_unguarded_write_lowers_the_best`;
    2. never deleting a row — `removing_a_row_can_lower_the_best`.

  -- THE FINDING THIS MODEL PRODUCED. `Admissible` below is the WEAKEST admission
  rule under which the overwrite stays monotone, and it is strictly weaker than
  the shipped one: it admits a tie. `the_tie_rule_is_not_what_makes_it_monotone`
  and `lenient_best_never_falls` prove that pair. So the strictness of `isBetter`
  at `records.ts:423` is NOT justified by monotonicity — relaxing `<` to `<=`
  there leaves every theorem in this file true. What the strictness is for is the
  displacement count at `records.ts:460`, where a tie counted as a displacement
  reports a movement that did not happen. A monotonicity test cannot catch that
  inversion, which is why the comparison needs a mutation test and not a proof.

  -- WHAT THIS ABSTRACTION KEEPS: the store's whole input — a write, a breach and
  a recorded re-derivation — the direction, the seal's refusal, the strict
  comparison against the same-digest incumbent, the overwrite, and the absence of
  any removal.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. CONCURRENCY, and the danger DOES live there. `runOf` is a sequential fold and
     `recordExploration` is a read-modify-write across an `await`: the SELECT at
     `records.ts:422` and the UPDATE at `records.ts:437` are two statements, so two
     runs can both read the same incumbent and both pass the guard. Nothing here
     rules that out and no strengthening of these theorems reaches it — it needs a
     conditional write. `PR-PUBLISH-004` already records the same gap for the seal.

  2. `Int` FOR A SQLite REAL. As in `Records.lean`: a spurious tie loses a write,
     it never manufactures one, so the discard is conservative.

  3. WHETHER THE CLEAR IS EARNED. `clear` here is unconditional, where production
     requires an admissible `FloorRederivation`. That makes the modelled adversary
     STRONGER — it can re-open writes at will — so a monotonicity result proved
     against it holds against the real gate. `Publication.lean` carries the
     conditional version, which is where the clear's own burden belongs.
-/

import Proteus.Exploration.Publication
import Proteus.Exploration.Records

namespace Proteus.Exploration.RecordsStore

open Proteus.Exploration
open Proteus.Exploration.Records

/-! ## The store and its verdict -/

/-- Why the store refused. An inductive rather than a string, so that
    `RecordVerdict`'s two causes (`records.ts:197`) are exhaustive here as they are
    there, and a third cause is a compile-time obligation. -/
inductive Cause where
  /-- `admitsPublication` refused (`records.ts:408-410`). -/
  | sealed
  /-- The same-digest incumbent is not beaten (`records.ts:423-427`). -/
  | notBetter
  deriving Repr, BEq, DecidableEq, Inhabited

/-- What the store answers a write with (`RecordVerdict`, `records.ts:190-198`).
    `displaced` is omitted: it is a counter over OTHER rows in the cell and no
    monotonicity claim reads it — see this file's header for why that omission is
    the finding rather than a simplification. -/
inductive Outcome where
  | recorded
  | refused (cause : Cause)
  deriving Repr, BEq, DecidableEq, Inhabited

/-- The store: a cell's rows and the publication state its writer consults. One
    cell, because `record_key` partitions by `(objectiveId, floorDigest,
    descriptor)` and monotonicity is a per-cell claim. -/
structure Store where
  rows : List Row
  pub : Publication.Publication
  deriving Repr, Inhabited

/-- The rows the store's `SELECT ... WHERE record_key = ?` would find
    (`records.ts:422`). A list rather than an `Option` so that nothing below rests
    on the primary key's uniqueness holding — the same choice `insertRow` makes,
    and `write_keeps_one_row_per_digest` earns it back. -/
def sameDigest (rs : List Row) (dg : String) : List Row :=
  rs.filter (fun x => x.digest == dg)

/-- **The weakest admission rule under which the overwrite stays monotone.**

    Stated in `notWorse`, the same order the invariant is stated in, so that the
    sufficiency proof below is about this predicate rather than about the shipped
    comparison. An empty same-digest set is admitted because `notWorse _ none` is
    `true`: a first record of an artifact has no incumbent to fail against. -/
def Admissible (d : Direction) (rs : List Row) (r : Row) : Bool :=
  notWorse d (some r.value) (best d (sameDigest rs r.digest))

/-- The shipped verdict, in the order `recordExploration` checks: the seal first
    (`records.ts:408`), then the same-digest incumbent under STRICT betterness
    (`records.ts:423`). -/
def verdict (d : Direction) (s : Store) (r : Row) : Outcome :=
  if Publication.admits s.pub .records then
    match best d (sameDigest s.rows r.digest) with
    | none => .recorded
    | some w => if isBetter r.value w d then .recorded else .refused .notBetter
  else .refused .sealed

/-! ## The store's whole input alphabet

  Three actions, because `recordExploration` takes three things that can vary: the
  write, and the two transitions of the `PublicationState` it is handed. A trace
  over writes alone would prove monotonicity of a store nobody seals. -/

inductive StoreAction where
  | write (r : Row)
  | breach (b : Publication.Breach)
  /-- A recorded re-derivation, unconditional here — see header discard 3. -/
  | clear (rd : Publication.Rederivation)
  deriving Repr, Inhabited

/-- One step. Total, so every theorem below is about this definition rather than
    about a postcondition asserted of it. The admitted branch is
    `Records.overwriteRow` — the shipped `UPDATE ... SET value = ?`, reused rather
    than restated so that its refutation stays one definition away. -/
def stepOf (d : Direction) (s : Store) (a : StoreAction) : Store :=
  match a with
  | .write r =>
      match verdict d s r with
      | .recorded => { s with rows := overwriteRow s.rows r }
      | .refused _ => s
  | .breach b => { s with pub := .sealed b none }
  | .clear rd =>
      match s.pub with
      | .open_ => s
      | .sealed b _ => { s with pub := .sealed b (some rd) }

/-- A finite sequence of everything the store can be asked to do. -/
def runOf (d : Direction) (s : Store) : List StoreAction → Store :=
  List.foldl (stepOf d)  s

theorem runOf_nil (d : Direction) (s : Store) : runOf d s [] = s := rfl

theorem runOf_cons (d : Direction) (s : Store) (a : StoreAction) (as : List StoreAction) :
    runOf d s (a :: as) = runOf d (stepOf d s a) as := by
  simp [runOf, List.foldl_cons]

/-! ## Premise one: the admitted overwrite cannot lower the best -/

/-- The load-bearing step, stated over `Admissible` rather than over the shipped
    comparison so that exactly what monotonicity needs is visible. -/
theorem overwrite_monotone_of_admissible (d : Direction) (rs : List Row) (r : Row)
    (h : Admissible d rs r = true) :
    notWorse d (best d (overwriteRow rs r)) (best d rs) = true := by
  cases hb : best d rs with
  | none => simp [notWorse]
  | some b =>
    obtain ⟨x, hx, hxv⟩ := best_mem d rs b hb
    by_cases hd : x.digest = r.digest
    · -- `x` carries the old best and shares the written digest, so the overwritten
      -- head has to answer for it — which is exactly what `Admissible` promises.
      have hxs : x ∈ sameDigest rs r.digest := by
        simp only [sameDigest]
        exact List.mem_filter.mpr ⟨hx, by simp [hd]⟩
      have hnw : notWorse d (best d (sameDigest rs r.digest)) (some x.value) = true :=
        best_notWorse_mem d _ x hxs
      refine best_notWorse_of_witness d _ r b ?_ ?_
      · simp [overwriteRow]
      · rw [← hxv]
        exact notWorse_trans d _ _ _ h hnw
    · -- `x` keeps its own row: the overwrite touches one digest and no other.
      have hxo : x ∈ rs.filter (fun y => y.digest != r.digest) :=
        List.mem_filter.mpr ⟨hx, by simp [hd]⟩
      refine best_notWorse_of_witness d _ x b ?_ ?_
      · simp only [overwriteRow]
        exact List.mem_cons_of_mem _ hxo
      · rw [hxv]; exact notWorse_refl d (some b)

/-- The shipped verdict is at least as strong as `Admissible`: a strict win is not
    worse. This is the only place `isBetter`'s strictness is used, and it is used
    in the direction that does not need it. -/
theorem recorded_is_admissible (d : Direction) (s : Store) (r : Row)
    (h : verdict d s r = .recorded) : Admissible d s.rows r = true := by
  cases ha : Publication.admits s.pub .records with
  | false => simp [verdict, ha] at h
  | true =>
    cases hw : best d (sameDigest s.rows r.digest) with
    | none => simp [Admissible, hw, notWorse]
    | some w =>
      simp only [Admissible, hw, notWorse]
      by_cases hbb : isBetter r.value w d = true
      · simp [isBetter_asymm _ _ d hbb]
      · simp only [Bool.not_eq_true] at hbb
        simp [verdict, ha, hw, hbb] at h

/-- A refusal is inert: it changes the store not at all, rows and seal alike. -/
theorem refused_write_changes_nothing (d : Direction) (s : Store) (r : Row) (c : Cause)
    (h : verdict d s r = .refused c) : stepOf d s (.write r) = s := by
  simp [stepOf, h]

/-- **One step never lowers the best**, over the store's whole action alphabet —
    the write, the breach and the clear. -/
theorem step_monotone (d : Direction) (s : Store) (a : StoreAction) :
    notWorse d (best d (stepOf d s a).rows) (best d s.rows) = true := by
  cases a with
  | write r =>
    cases hv : verdict d s r with
    | recorded =>
      simp only [stepOf, hv]
      exact overwrite_monotone_of_admissible d s.rows r (recorded_is_admissible d s r hv)
    | refused c =>
      rw [refused_write_changes_nothing d s r c hv]
      exact notWorse_refl d _
  | breach b => exact notWorse_refl d _
  | clear rd =>
    cases hp : s.pub with
    | open_ => simp only [stepOf, hp]; exact notWorse_refl d _
    | sealed b cl => simp only [stepOf, hp]; exact notWorse_refl d _

/-- **The invariant, as reachability over all finite write sequences: no trace of
    the store's own operations lowers a cell's best.**

    The shape `sealed_publishes_nothing` uses, and for the same reason. A guard is
    a one-step property that a path not passing through it can bypass; this
    quantifies over every finite sequence of writes, breaches and clears, so there
    is no such path to look for. -/
theorem best_never_falls (d : Direction) (s : Store) (as : List StoreAction) :
    notWorse d (best d (runOf d s as).rows) (best d s.rows) = true := by
  induction as generalizing s with
  | nil => exact notWorse_refl d _
  | cons a as ih =>
    rw [runOf_cons]
    exact notWorse_trans d _ _ _ (ih (stepOf d s a)) (step_monotone d s a)

/-- And so nothing a trace does drops below a value the store ever held: once a
    row is recorded, the cell's best answers for it forever. -/
theorem best_never_falls_below_a_recorded_value (d : Direction) (s : Store)
    (as : List StoreAction) (r : Row) (h : r ∈ s.rows) :
    notWorse d (best d (runOf d s as).rows) (some r.value) = true :=
  notWorse_trans d _ (best d s.rows) _ (best_never_falls d s as) (best_notWorse_mem d _ r h)

/-! ## Premise two: nothing is ever deleted

  `records.ts` contains no `DELETE` and the archive layer above it contains no
  eviction path (`archive.ts:32-39`). That is the other half, and it is a
  SEPARATE fact: the guard alone does not give monotonicity to a store that
  removes rows. -/

/-- **No action removes a digest from the cell.** Stated over digests rather than
    over rows because an admitted overwrite does replace a row — what it may not
    do is drop one. -/
theorem step_deletes_no_digest (d : Direction) (s : Store) (a : StoreAction) (x : Row)
    (hx : x ∈ s.rows) : ∃ y ∈ (stepOf d s a).rows, y.digest = x.digest := by
  cases a with
  | write r =>
    cases hv : verdict d s r with
    | recorded =>
      simp only [stepOf, hv]
      by_cases hd : x.digest = r.digest
      · exact ⟨r, by simp [overwriteRow], hd.symm⟩
      · refine ⟨x, ?_, rfl⟩
        simp only [overwriteRow]
        exact List.mem_cons_of_mem _ (List.mem_filter.mpr ⟨hx, by simp [hd]⟩)
    | refused c => exact ⟨x, by rw [refused_write_changes_nothing d s r c hv]; exact hx, rfl⟩
  | breach b => exact ⟨x, hx, rfl⟩
  | clear rd =>
    refine ⟨x, ?_, rfl⟩
    cases hp : s.pub with
    | open_ => simpa [stepOf, hp] using hx
    | sealed b cl => simpa [stepOf, hp] using hx

/-- And so over a whole trace. -/
theorem trace_deletes_no_digest (d : Direction) (s : Store) (as : List StoreAction) (x : Row)
    (hx : x ∈ s.rows) : ∃ y ∈ (runOf d s as).rows, y.digest = x.digest := by
  induction as generalizing s x with
  | nil => exact ⟨x, hx, rfl⟩
  | cons a as ih =>
    obtain ⟨y, hy, hyd⟩ := step_deletes_no_digest d s a x hx
    obtain ⟨z, hz, hzd⟩ := ih (stepOf d s a) y hy
    exact ⟨z, by rw [runOf_cons]; exact hz, hzd.trans hyd⟩

/-- The overwrite keeps the cell a map keyed by `artifactDigest`, as the DDL's
    primary key makes it (`records.ts:77`). -/
theorem write_keeps_one_row_per_digest (rs : List Row) (r : Row) :
    ∀ y ∈ (overwriteRow rs r).tail, y.digest ≠ r.digest := by
  intro y hy
  simp only [overwriteRow, List.tail_cons] at hy
  simpa using (List.mem_filter.mp hy).2

/-! ## Both premises are load-bearing

  A consequence of two rules is worth nothing if either rule can be dropped and
  the consequence survives. Neither can. -/

/-- **Drop the refusal and the best falls.** The witness is section 5.2's
    nondeterministic verifier: artifact `a` recorded at 3, re-measured at 7 on a
    minimise objective. `Admissible` rejects it and the unguarded overwrite lowers
    the best — which is `Records.overwrite_breaks_monotonicity` located in the
    shipped store, where the write really is an overwrite. -/
theorem an_unguarded_write_lowers_the_best :
    Admissible .minimise [{ digest := "a", value := 3 }] { digest := "a", value := 7 } = false
    ∧ notWorse .minimise
        (best .minimise
          (overwriteRow [{ digest := "a", value := 3 }] { digest := "a", value := 7 }))
        (best .minimise [{ digest := "a", value := 3 }]) = false := by
  refine ⟨by decide, by decide⟩

/-- **Keep the refusal, delete a row, and the best falls anyway.** So the guard is
    not sufficient by itself and "no eviction" is a second premise rather than a
    restatement of the first. This is why `archive.ts` having no eviction path is a
    correctness property and not an omission. -/
theorem removing_a_row_can_lower_the_best :
    notWorse .minimise (best .minimise [{ digest := "b", value := 5 }])
      (best .minimise [{ digest := "a", value := 1 }, { digest := "b", value := 5 }]) = false := by
  decide

/-! ## The finding: the tie rule is not what makes it monotone -/

/-- The lenient store: admit whenever `Admissible` allows, which is `<=` where the
    shipped rule is `<`. -/
def stepLenient (d : Direction) (rs : List Row) (r : Row) : List Row :=
  if Admissible d rs r then overwriteRow rs r else rs

def runLenient (d : Direction) (rs : List Row) : List Row → List Row :=
  List.foldl (stepLenient d) rs

theorem stepLenient_monotone (d : Direction) (rs : List Row) (r : Row) :
    notWorse d (best d (stepLenient d rs r)) (best d rs) = true := by
  unfold stepLenient
  split
  · rename_i h
    exact overwrite_monotone_of_admissible d rs r h
  · exact notWorse_refl d _

/-- **The lenient store is monotone over every finite write sequence too.** So
    every monotonicity theorem in this file survives relaxing `records.ts:423`
    from `<` to `<=`, and no monotonicity test can catch that inversion. -/
theorem lenient_best_never_falls (d : Direction) (rs : List Row) (ws : List Row) :
    notWorse d (best d (runLenient d rs ws)) (best d rs) = true := by
  induction ws generalizing rs with
  | nil => exact notWorse_refl d (best d rs)
  | cons w ws ih =>
    simp only [runLenient, List.foldl_cons]
    exact notWorse_trans d _ _ _ (ih (stepLenient d rs w)) (stepLenient_monotone d rs w)

/-- **And the two rules genuinely differ**, on the tie: the shipped store refuses
    it by name, the weakest monotone rule admits it. The strictness therefore
    answers to `records.ts:460`'s displacement count, not to this invariant. -/
theorem the_tie_rule_is_not_what_makes_it_monotone :
    verdict .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
        { digest := "a", value := 3 } = .refused .notBetter
    ∧ Admissible .minimise [{ digest := "a", value := 3 }] { digest := "a", value := 3 } = true := by
  refine ⟨by decide, by decide⟩

/-! ## Sharpness: the store does write, and it refuses by name

  A monotonicity proof over a store that never records anything is vacuous, so
  each refusal is exhibited beside the write it is not. -/

/-- A better re-record lands, and moves the best. -/
theorem a_better_write_is_recorded :
    verdict .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
        { digest := "a", value := 1 } = .recorded
    ∧ best .minimise
        (stepOf .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
          (.write { digest := "a", value := 1 })).rows = some 1 := by
  refine ⟨by decide, by decide⟩

/-- A worse NEW artifact joins the population and the best does not move: the
    refusal is per digest, not per cell, which is what keeps the population the
    spec wants (`Records.eviction_can_destroy_the_population`). -/
theorem a_worse_new_artifact_joins :
    verdict .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
        { digest := "b", value := 9 } = .recorded
    ∧ best .minimise
        (stepOf .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
          (.write { digest := "b", value := 9 })).rows = some 3 := by
  refine ⟨by decide, by decide⟩

/-- **The direction decides which way is better**, so a maximise objective is not
    silently inverted: the same two numbers swap verdicts. -/
theorem the_direction_decides :
    verdict .minimise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
        { digest := "a", value := 7 } = .refused .notBetter
    ∧ verdict .maximise { rows := [{ digest := "a", value := 3 }], pub := .open_ }
        { digest := "a", value := 7 } = .recorded := by
  refine ⟨by decide, by decide⟩

/-- A floor that is a bound and a breach against it, so the sealed states below are
    the ones section 4.3 describes rather than arbitrary values. -/
def sampleFloor : Floor := { value := 10, kind := .certificate, bestKnownHonest := 12 }

def sampleBreach : Publication.Breach :=
  { floor := sampleFloor, measured := 3,
    hypotheses := [.floorWrong, .verifierGameable] }

def sampleRederivation : Publication.Rederivation :=
  { floor := { sampleFloor with value := 2 }, adjudication := "the floor was wrong" }

/-- **A sealed store refuses by the seal, and names it** — the cause is not folded
    into `not-better`, because the two refusals demand different responses. -/
theorem a_sealed_store_refuses_by_name :
    verdict .minimise { rows := [], pub := .sealed sampleBreach none }
      { digest := "a", value := 1 } = .refused .sealed := by
  decide

/-- **A seal is not a boolean**: a recorded re-derivation records again, so the
    reachability theorem is not satisfied by a store that refuses everything. -/
theorem a_cleared_seal_records_again :
    verdict .minimise
      (stepOf .minimise { rows := [], pub := .sealed sampleBreach none }
        (.clear sampleRederivation))
      { digest := "a", value := 1 } = .recorded := by
  decide

/-- And the breach really does reach the state the refusal is proved against, so
    `a_sealed_store_refuses_by_name` is about a reachable store. -/
theorem a_breach_seals_the_store :
    verdict .minimise
      (stepOf .minimise { rows := [], pub := .open_ } (.breach sampleBreach))
      { digest := "a", value := 1 } = .refused .sealed := by
  decide

end Proteus.Exploration.RecordsStore

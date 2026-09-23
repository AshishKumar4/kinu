/-
  Kinu.Exploration.Concurrent — the publication seal and the records store
  under concurrent runs. 0 sorry, 0 axioms.

  `RecordsStore.lean` folds ONE run's actions. Several swarm runs on one
  objective share the cell's rows and, since a breach is evidence about the
  floor and the verifier they share, they share its seal: a breach writes a seal
  row for the objective and floor
  (`packages/core/src/strategy/records.ts#sealRecords`), and every records
  write reads it in the same synchronous step as the write
  (`packages/core/src/strategy/records.ts#publicationOf`, consulted by
  `recordExploration`). Each run also keeps its own `PublicationState`. A whole
  `recordExploration` call runs with no `await` inside, so it is one atomic step
  of the workspace's one isolate, and a concurrent execution is an interleaving
  of such steps.

  - The cell's best never falls under any interleaving of any number of runs
    (`the_best_never_falls_under_any_interleaving`).
  - A breach in one run stops every run on the objective and floor: after it no
    run records anything there (`a_breach_stops_every_run_on_its_floor`). The
    spec's words, section 4.4: "Publication STOPS for that objective, until a
    human re-derives the floor." A re-derived floor, or a replaced verifier, has
    another digest, so it publishes under another key.
  - Atomicity is load-bearing: split the check from the write across an
    `await` and two interleaved writes lower the best
    (`a_split_check_and_write_lowers_the_best`).
-/

import Kinu.Exploration.RecordsStore

namespace Kinu.Exploration.Concurrent

open Kinu.Exploration
open Kinu.Exploration.Records
open Kinu.Exploration.RecordsStore

/-! ## Runs over one store -/

/-- The shared rows of one cell, each run's own publication state, and the breach
    the store's seal row holds for the cell's objective and floor, if any. -/
structure Shared where
  rows : List Row
  seals : Nat → Publication.Publication
  store : Option Publication.Breach

/-- Replace run `i`'s seal. -/
def setSeal (f : Nat → Publication.Publication) (i : Nat) (p : Publication.Publication) :
    Nat → Publication.Publication :=
  fun j => if j = i then p else f j

/-- `publicationOf`: the run's own seal, else the store's. -/
def effective (own : Publication.Publication) : Option Publication.Breach → Publication.Publication
  | none => own
  | some b => if own.isSealed then own else .sealed b

/-- `sealRecords`: the first breach holds. -/
def sealStore : Option Publication.Breach → Publication.Breach → Option Publication.Breach
  | none, b => some b
  | some b', _ => some b'

/-- One `recordExploration` call, or one breach, by run `i`. A write is the
    single-run step under the publication `publicationOf` reads; a breach seals the
    run and the store. -/
def stepC (d : Direction) (s : Shared) (i : Nat) : StoreAction → Shared
  | .write r =>
    { s with rows := (RecordsStore.stepOf d { rows := s.rows, pub := effective (s.seals i) s.store }
        (.write r)).rows }
  | .breach b => { s with seals := setSeal s.seals i (.sealed b), store := sealStore s.store b }

/-- An interleaving: any finite sequence of steps by any runs. -/
def runC (d : Direction) (s : Shared) : List (Nat × StoreAction) → Shared :=
  List.foldl (fun s st => stepC d s st.1 st.2) s

theorem runC_cons (d : Direction) (s : Shared) (st : Nat × StoreAction)
    (sts : List (Nat × StoreAction)) :
    runC d s (st :: sts) = runC d (stepC d s st.1 st.2) sts := by
  simp [runC, List.foldl_cons]

/-! ## Monotone under every interleaving -/

/-- **No interleaving of any number of runs lowers the cell's best.** A write is a
    single-run step, monotone whatever seal it consults; a seal transition leaves
    the rows alone. -/
theorem the_best_never_falls_under_any_interleaving (d : Direction) (s : Shared)
    (sts : List (Nat × StoreAction)) :
    notWorse d (best d (runC d s sts).rows) (best d s.rows) = true := by
  induction sts generalizing s with
  | nil => exact notWorse_refl d _
  | cons st sts ih =>
    rw [runC_cons]
    refine notWorse_trans d _ _ _ (ih _) ?_
    obtain ⟨i, a⟩ := st
    cases a with
    | write r =>
      exact RecordsStore.step_monotone d { rows := s.rows, pub := effective (s.seals i) s.store } (.write r)
    | breach b => exact notWorse_refl d _

/-! ## A breach stops every run -/

private theorem sealed_refuses (p : Publication.Publication) (h : p.isSealed = true) :
    Publication.admits p .records = false := by
  cases p with
  | open_ => cases h
  | sealed b => rfl

private theorem effective_refuses (own : Publication.Publication) (b : Publication.Breach) :
    Publication.admits (effective own (some b)) .records = false := by
  show Publication.admits (if own.isSealed then own else .sealed b) .records = false
  by_cases h : own.isSealed = true
  · rw [if_pos h]; exact sealed_refuses _ h
  · rw [if_neg h]; rfl

/-- Once the store holds a seal, every step keeps it and changes no row. -/
private theorem sealed_step (d : Direction) (s : Shared) (st : Nat × StoreAction)
    (h : s.store.isSome = true) :
    (stepC d s st.1 st.2).store.isSome = true ∧ (stepC d s st.1 st.2).rows = s.rows := by
  obtain ⟨i, a⟩ := st
  obtain ⟨b, hb⟩ := Option.isSome_iff_exists.mp h
  cases a with
  | write r =>
    refine ⟨h, ?_⟩
    have hv : verdict d { rows := s.rows, pub := effective (s.seals i) s.store } r = .refused .sealed := by
      simp [verdict, hb, effective_refuses]
    simp [stepC, RecordsStore.stepOf, hv]
  | breach b' => exact ⟨by simp [stepC, hb, sealStore], rfl⟩

/-- **A breach in one run stops every run on the objective and floor.** After any
    run's breach, every interleaving of any runs' steps leaves the rows exactly as
    the breach found them. -/
theorem a_breach_stops_every_run_on_its_floor (d : Direction) (s : Shared) (i : Nat)
    (b : Publication.Breach) (sts : List (Nat × StoreAction)) :
    (runC d (stepC d s i (.breach b)) sts).rows = s.rows := by
  have key : ∀ (sts : List (Nat × StoreAction)) (t : Shared), t.store.isSome = true →
      (runC d t sts).rows = t.rows := by
    intro sts
    induction sts with
    | nil => intro t _; rfl
    | cons st sts ih =>
      intro t ht
      rw [runC_cons]
      obtain ⟨hst, hrows⟩ := sealed_step d t st ht
      rw [ih _ hst, hrows]
  have hs : (stepC d s i (.breach b)).store.isSome = true := by
    cases h : s.store <;> simp [stepC, h, sealStore]
  exact key sts _ hs

/-- Two runs, both open, sharing an empty cell. -/
def twoOpenRuns : Shared := { rows := [], seals := fun _ => .open_, store := none }

/-- Run 0 measures past the floor; run 1, on the same objective and floor, then
    tries to record a row, and the store refuses it. -/
theorem a_breach_in_one_run_seals_another :
    (runC .minimise twoOpenRuns
      [(0, .breach sampleBreach), (1, .write { digest := "b", value := 4 })]).rows = [] := by
  decide

/-! ## Atomicity is load-bearing -/

/-- A write split at an `await`: the verdict is read in one step and applied in a
    later one, with other runs' steps in between. `pending` holds each run's
    decided row. -/
structure Split where
  rows : List Row
  pending : List (Nat × Row)

inductive SplitAction where
  | decide (r : Row)
  | apply
  deriving Repr

def stepSplit (d : Direction) (s : Split) (i : Nat) : SplitAction → Split
  | .decide r =>
    match verdict d { rows := s.rows, pub := .open_ } r with
    | .recorded => { s with pending := (i, r) :: s.pending }
    | .refused _ => s
  | .apply =>
    match s.pending.find? (fun p => p.1 == i) with
    | some (_, r) => { rows := overwriteRow s.rows r,
                       pending := s.pending.filter (fun p => p.1 != i) }
    | none => s

def runSplit (d : Direction) (s : Split) : List (Nat × SplitAction) → Split :=
  List.foldl (fun s st => stepSplit d s st.1 st.2) s

/-- **Split the check from the write and two runs lower the best.** Both runs
    read the incumbent 3 on a minimise objective and decide to improve artifact
    `a`, to 1 and to 2; run 0 writes 1, then run 1 overwrites it with 2. The best
    went 3, 1, 2. The shipped body checks and writes in one synchronous call,
    which is what keeps this interleaving out of `runC`. -/
theorem a_split_check_and_write_lowers_the_best :
    best .minimise (runSplit .minimise { rows := [{ digest := "a", value := 3 }], pending := [] }
      [(0, .decide { digest := "a", value := 1 }), (1, .decide { digest := "a", value := 2 }),
       (0, .apply)]).rows = some 1
    ∧ best .minimise (runSplit .minimise { rows := [{ digest := "a", value := 3 }], pending := [] }
      [(0, .decide { digest := "a", value := 1 }), (1, .decide { digest := "a", value := 2 }),
       (0, .apply), (1, .apply)]).rows = some 2 := by
  refine ⟨by decide, by decide⟩

end Kinu.Exploration.Concurrent

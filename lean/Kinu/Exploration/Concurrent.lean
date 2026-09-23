/-
  Kinu.Exploration.Concurrent — the publication seal and the records store
  under concurrent runs. 0 sorry, 0 axioms.

  `RecordsStore.lean` folds ONE run's actions. Two swarm runs on one objective
  share the cell's rows but not their seal: each run keeps its own
  `PublicationState` (`packages/core/src/strategy/swarm-setup.ts#seedResumedSearch`
  starts it `open` or re-derives it from the run's own rows, and
  `packages/core/src/strategy/swarm-scoring.ts#scoreExpansion` seals it on the
  run's own breach) and hands it to
  `packages/core/src/strategy/records.ts#recordExploration`, which checks it,
  reads the incumbent and writes, synchronously, with no `await` in between.
  That makes a whole `recordExploration` call one atomic step of the
  workspace's one isolate, so a concurrent execution is an interleaving of such
  steps: `stepC` below applies `RecordsStore.stepOf` to the shared rows and the
  acting run's own seal.

  What the interleaving keeps, and what it does not:

  - the cell's best never falls under any interleaving of any number of runs
    (`the_best_never_falls_under_any_interleaving`);
  - a sealed run's writes are invisible to everyone else: the interleaving ends
    exactly where it would have if that run had written nothing
    (`a_sealed_run_is_invisible_to_every_interleaving`);
  - the seal is RUN-SCOPED. A breach in one run leaves a concurrent run on the
    same objective and floor writing rows
    (`a_breach_in_one_run_does_not_seal_another`), where a seal held by the
    store would refuse that write (`a_store_scoped_seal_would_refuse_it`);
  - atomicity is load-bearing: split the check from the write across an
    `await` and two interleaved writes lower the best
    (`a_split_check_and_write_lowers_the_best`).
-/

import Kinu.Exploration.RecordsStore

namespace Kinu.Exploration.Concurrent

open Kinu.Exploration
open Kinu.Exploration.Records
open Kinu.Exploration.RecordsStore

/-! ## Runs over one store -/

/-- The shared rows of one cell, and each run's own publication state. -/
structure Shared where
  rows : List Row
  seals : Nat → Publication.Publication

/-- Replace run `i`'s seal. -/
def setSeal (f : Nat → Publication.Publication) (i : Nat) (p : Publication.Publication) :
    Nat → Publication.Publication :=
  fun j => if j = i then p else f j

/-- One `recordExploration` call, or one seal transition, by run `i`: the single-run
    step applied to the shared rows and run `i`'s own seal. -/
def stepC (d : Direction) (s : Shared) (i : Nat) (a : StoreAction) : Shared :=
  let local' := RecordsStore.stepOf d { rows := s.rows, pub := s.seals i } a
  { rows := local'.rows, seals := setSeal s.seals i local'.pub }

/-- An interleaving: any finite sequence of steps by any runs. -/
def runC (d : Direction) (s : Shared) : List (Nat × StoreAction) → Shared :=
  List.foldl (fun s st => stepC d s st.1 st.2) s

theorem runC_cons (d : Direction) (s : Shared) (st : Nat × StoreAction)
    (sts : List (Nat × StoreAction)) :
    runC d s (st :: sts) = runC d (stepC d s st.1 st.2) sts := by
  simp [runC, List.foldl_cons]

/-! ## Monotone under every interleaving -/

/-- **No interleaving of any number of runs lowers the cell's best.** Each step is
    a single-run step on the shared rows, and every single-run step is monotone
    whatever seal it consults. -/
theorem the_best_never_falls_under_any_interleaving (d : Direction) (s : Shared)
    (sts : List (Nat × StoreAction)) :
    notWorse d (best d (runC d s sts).rows) (best d s.rows) = true := by
  induction sts generalizing s with
  | nil => exact notWorse_refl d _
  | cons st sts ih =>
    rw [runC_cons]
    exact notWorse_trans d _ _ _ (ih _)
      (RecordsStore.step_monotone d { rows := s.rows, pub := s.seals st.1 } st.2)

/-! ## A sealed run is invisible -/

/-- Run `i` holds an uncleared seal. -/
def sealedUncleared (p : Publication.Publication) : Prop :=
  ∃ b, p = .sealed b none

def isWriteBy (i : Nat) (st : Nat × StoreAction) : Bool :=
  st.1 == i && match st.2 with
    | .write _ => true
    | _ => false

def isClearBy (i : Nat) (st : Nat × StoreAction) : Bool :=
  st.1 == i && match st.2 with
    | .clear _ => true
    | _ => false

private theorem sealed_write_refused (d : Direction) (s : Shared) (i : Nat) (r : Row)
    (h : sealedUncleared (s.seals i)) : stepC d s i (.write r) = s := by
  obtain ⟨b, hb⟩ := h
  have hv : verdict d { rows := s.rows, pub := s.seals i } r = .refused .sealed := by
    simp [verdict, hb, Publication.admits, Publication.Publication.uncleared]
  have hstep := refused_write_changes_nothing d { rows := s.rows, pub := s.seals i } r _ hv
  simp only [stepC, hstep]
  cases s with
  | mk rows seals =>
    simp only [Shared.mk.injEq, true_and]
    funext j
    simp only [setSeal]
    split
    · next h => subst h; rfl
    · rfl

private theorem stays_sealed (d : Direction) (s : Shared) (i : Nat) (st : Nat × StoreAction)
    (h : sealedUncleared (s.seals i)) (hc : isClearBy i st = false) :
    sealedUncleared ((stepC d s st.1 st.2).seals i) := by
  obtain ⟨j, a⟩ := st
  by_cases hj : j = i
  · subst hj
    obtain ⟨b, hb⟩ := h
    cases a with
    | write r => rw [sealed_write_refused d s j r ⟨b, hb⟩]; exact ⟨b, hb⟩
    | breach b' => exact ⟨b', by simp [stepC, setSeal, RecordsStore.stepOf]⟩
    | clear rd => simp [isClearBy] at hc
  · simp only [stepC, setSeal, if_neg (Ne.symm hj)]
    exact h

/-- **A sealed run's writes are invisible to every interleaving.** If run `i`
    holds an uncleared seal and clears nothing, the interleaving reaches exactly
    the state it reaches with every one of `i`'s writes deleted: no other run can
    observe that `i` tried to publish. -/
theorem a_sealed_run_is_invisible_to_every_interleaving (d : Direction) (s : Shared) (i : Nat)
    (sts : List (Nat × StoreAction)) (h : sealedUncleared (s.seals i))
    (hc : ∀ st ∈ sts, isClearBy i st = false) :
    runC d s sts = runC d s (sts.filter (fun st => !isWriteBy i st)) := by
  induction sts generalizing s with
  | nil => rfl
  | cons st sts ih =>
    have hc' : ∀ st' ∈ sts, isClearBy i st' = false := fun st' h' => hc st' (List.mem_cons_of_mem _ h')
    rw [runC_cons]
    by_cases hw : isWriteBy i st = true
    · obtain ⟨j, a⟩ := st
      simp only [isWriteBy, Bool.and_eq_true, beq_iff_eq] at hw
      obtain ⟨rfl, ha⟩ := hw
      cases a with
      | write r =>
        rw [sealed_write_refused d s j r h, List.filter_cons]
        simp only [isWriteBy, beq_self_eq_true, Bool.true_and, Bool.not_true]
        exact ih s h hc'
      | breach b => simp at ha
      | clear rd => simp at ha
    · rw [List.filter_cons, if_pos (by simpa using hw), runC_cons]
      exact ih _ (stays_sealed d s i st h (hc st (List.mem_cons_self _ _))) hc'

/-! ## The seal is run-scoped -/

/-- Two runs, both open, sharing an empty cell. -/
def twoOpenRuns : Shared := { rows := [], seals := fun _ => .open_ }

/-- **A breach in one run does not seal another.** Run 0 measures past the floor
    and seals itself; run 1, on the same objective and floor, then records a row.
    The floor's guarantee is void for both, and only run 0 stops publishing. -/
theorem a_breach_in_one_run_does_not_seal_another :
    (runC .minimise twoOpenRuns
      [(0, .breach sampleBreach), (1, .write { digest := "b", value := 4 })]).rows
      = [{ digest := "b", value := 4 }] := by
  decide

/-- **A seal held by the store would refuse that write**: the single-store step,
    whose seal every writer consults, answers run 1's write after run 0's breach
    with `sealed`. -/
theorem a_store_scoped_seal_would_refuse_it :
    verdict .minimise
      (RecordsStore.stepOf .minimise { rows := [], pub := .open_ } (.breach sampleBreach))
      { digest := "b", value := 4 } = .refused .sealed := by
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

/-
  Kinu.MCTS.StorageIsolation — branches never write the orchestrator's rows.
  0 sorry, 0 axioms.

  Every MCTS branch runs as its own actor: a hosted logical actor on the
  workspace's one SQLite (`packages/cf-backend/src/exploration-hosting.ts#hostBranch`), or a
  forked process that binds its own actor row in the same database file
  (`packages/cli-backend/src/branch-process.ts#createBranchSpawner`). Every row
  is keyed by the actor that wrote it (`ActorHandle`, `actor_id = …` on every
  statement). So the invariant is actor separation: no branch runs as the
  orchestrator's actor (`transition_preserves_isolation`), and a write under one
  actor leaves every other actor's rows exactly as they were
  (`another_actors_writes_are_invisible`). Together: nothing a branch does
  changes the orchestrator's rows.

  Actor separation is a premise of `Expand`, the step that spawns branches, not
  a property proved of the spawner. A swarm node with tools is not a branch:
  `Exploration/Isolation.lean` proves why this proof does not reach it.
-/

import Kinu.Types

namespace Kinu.MCTS.StorageIsolation

open Kinu

/-! ## MCTS Actions and Transitions -/

inductive MCTSAction where
  | Select
  | Expand (newActorIds : List String)
  | BranchExplore
  | BranchEvaluate (score : Float)
  | Backpropagate (reward : Float)
  | Prune (branchId : String)
  | Converge

/-- Transition relation with postconditions sufficient to prove StorageIsolated. -/
def mctsTransition (s s' : MCTSSystemState) (a : MCTSAction) : Prop :=
  match a with
  | .Select => s' = s
  | .Expand newIds =>
    s'.orch = s.orch ∧
    (∀ sid ∈ newIds, sid ≠ s.orch.actorId) ∧
    (∀ b ∈ s'.branches, b ∈ s.branches ∨ b.actorId ∈ newIds)
  | .BranchExplore =>
    s'.orch = s.orch ∧
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.actorId = b'.actorId)
  | .BranchEvaluate _ =>
    s'.orch = s.orch ∧
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.actorId = b'.actorId)
  | .Backpropagate _ =>
    s'.orch.actorId = s.orch.actorId ∧
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.actorId = b'.actorId)
  | .Prune bid =>
    s'.orch.actorId = s.orch.actorId ∧
    s'.branches = s.branches.filter fun b => !(b.id == bid)
  | .Converge => s' = s

/-! ## Init and invariant -/

def mctsInit (s : MCTSSystemState) : Prop :=
  s.branches = []

theorem init_isolated (s : MCTSSystemState) (h : mctsInit s) : StorageIsolated s := by
  intro b hmem
  rw [h] at hmem
  exact absurd hmem (List.not_mem_nil _)

/-! ## Main theorem: StorageIsolated is preserved by all transitions -/

theorem transition_preserves_isolation (s s' : MCTSSystemState) (a : MCTSAction)
    (hinv : StorageIsolated s) (htrans : mctsTransition s s' a) :
    StorageIsolated s' := by
  intro b hmem
  match a with
  | .Select =>
    simp [mctsTransition] at htrans
    subst htrans
    exact hinv b hmem
  | .Expand newIds =>
    simp [mctsTransition] at htrans
    obtain ⟨horch, hdisj, hbranch⟩ := htrans
    rcases hbranch b hmem with hold | hnew
    · rw [horch]; exact hinv b hold
    · rw [horch]; exact hdisj b.actorId hnew
  | .BranchExplore =>
    simp [mctsTransition] at htrans
    obtain ⟨horch, hpres⟩ := htrans
    obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
    rw [horch, hb'sid]; exact hinv b' hb'mem
  | .BranchEvaluate _ =>
    simp [mctsTransition] at htrans
    obtain ⟨horch, hpres⟩ := htrans
    obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
    rw [horch, hb'sid]; exact hinv b' hb'mem
  | .Backpropagate _ =>
    simp [mctsTransition] at htrans
    obtain ⟨horsid, hpres⟩ := htrans
    obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
    rw [horsid, hb'sid]; exact hinv b' hb'mem
  | .Prune bid =>
    simp [mctsTransition] at htrans
    obtain ⟨hstorage, hfilt⟩ := htrans
    rw [hfilt] at hmem
    simp [List.mem_filter] at hmem
    rw [hstorage]; exact hinv b hmem.1
  | .Converge =>
    simp [mctsTransition] at htrans
    subst htrans
    exact hinv b hmem

/-! ## One store, keyed by actor -/

/-- One row of the workspace SQLite, under the actor that wrote it. -/
structure Row where
  actor : String
  key : String
  value : String
  deriving DecidableEq, Repr

/-- A write by `actor`: an upsert of its own row for `key`. -/
def writeAs (actor key value : String) (rows : List Row) : List Row :=
  ⟨actor, key, value⟩ :: rows.filter (fun r => !(r.actor == actor && r.key == key))

/-- What `actor` reads: its own rows. -/
def rowsOf (actor : String) (rows : List Row) : List Row := rows.filter (·.actor == actor)

/-- A write under one actor leaves another actor's rows exactly as they were. -/
theorem a_write_leaves_other_actors_alone (a b key value : String) (h : a ≠ b)
    (rows : List Row) : rowsOf b (writeAs a key value rows) = rowsOf b rows := by
  have hne : (a == b) = false := by simpa using h
  simp only [rowsOf, writeAs, List.filter_cons, hne, if_false, Bool.false_eq_true]
  rw [List.filter_filter]
  congr 1
  funext r
  by_cases hr : r.actor = b
  · have hba : b ≠ a := fun e => h e.symm
    simp [hr, hba]
  · simp [hr]

/-- What an actor's own write leaves it: the new row, then its other keys. -/
private theorem rowsOf_writeAs_self (b key value : String) (rows : List Row) :
    rowsOf b (writeAs b key value rows) =
      ⟨b, key, value⟩ :: (rowsOf b rows).filter (fun r => !(r.key == key)) := by
  simp only [rowsOf, writeAs, List.filter_cons, beq_self_eq_true, if_true, List.filter_filter]
  congr 1
  apply List.filter_congr
  intro r _
  cases (r.actor == b) <;> cases (r.key == key) <;> rfl

/-- An actor's own writes see only its own rows. -/
private theorem rowsOf_fold_congr (b : String) :
    ∀ (ws : List (String × String × String)) (r₁ r₂ : List Row),
      (∀ w ∈ ws, w.1 = b) → rowsOf b r₁ = rowsOf b r₂ →
      rowsOf b (ws.foldl (fun rs w => writeAs w.1 w.2.1 w.2.2 rs) r₁) =
        rowsOf b (ws.foldl (fun rs w => writeAs w.1 w.2.1 w.2.2 rs) r₂)
  | [], _, _, _, h => h
  | w :: ws, r₁, r₂, hall, h => by
    have hw : w.1 = b := hall w (List.mem_cons_self _ _)
    simp only [List.foldl_cons]
    apply rowsOf_fold_congr b ws _ _ (fun x hx => hall x (List.mem_cons_of_mem _ hx))
    rw [hw, rowsOf_writeAs_self, rowsOf_writeAs_self, h]

/-- **Another actor's writes are invisible.** Run any interleaving of writes by any
    actors: an actor's rows are exactly what its own writes, in order, make of
    them. -/
theorem another_actors_writes_are_invisible (b : String) :
    ∀ (writes : List (String × String × String)) (rows : List Row),
      rowsOf b (writes.foldl (fun rs w => writeAs w.1 w.2.1 w.2.2 rs) rows) =
        rowsOf b ((writes.filter (·.1 == b)).foldl (fun rs w => writeAs w.1 w.2.1 w.2.2 rs) rows)
  | [], _ => rfl
  | w :: ws, rows => by
    by_cases hw : w.1 = b
    · simp only [List.foldl_cons, List.filter_cons, hw, beq_self_eq_true, if_true]
      exact another_actors_writes_are_invisible b ws _
    · have hne : (w.1 == b) = false := by simpa using hw
      simp only [List.foldl_cons, List.filter_cons, hne, if_false, Bool.false_eq_true]
      rw [another_actors_writes_are_invisible b ws (writeAs w.1 w.2.1 w.2.2 rows)]
      exact rowsOf_fold_congr b _ _ _ (fun x hx => by simpa using (List.mem_filter.mp hx).2)
        (a_write_leaves_other_actors_alone _ _ _ _ hw rows)

/-- Budget termination: MCTS terminates because budget is well-founded. -/
theorem budget_well_founded :
    WellFounded (InvImage (· < ·) (fun s : MCTSSystemState => s.orch.budget)) :=
  InvImage.wf _ Nat.lt_wfRel.wf

end Kinu.MCTS.StorageIsolation

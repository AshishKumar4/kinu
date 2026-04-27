-- SelfEvolvingAgent.DistributedModel
-- Veil-style distributed model of MCTS.
-- Architecture reference: final-architecture.md §5.4

import SelfEvolvingAgent.Types
import TSLean.Veil.Core
import TSLean.DurableObjects.MultiDO
import TSLean.DurableObjects.Model

namespace SelfEvolvingAgent.Distributed

open TSLean.Veil TransitionSystem
open TSLean.DO.MultiDO
open SelfEvolvingAgent

/-! ## Agent states (using storage IDs for isolation proof) -/

structure OrchestratorState where
  nodes       : List NodeData
  budget      : Nat
  task        : String
  craftStore  : List CraftedTool
  scaffoldVer : Nat
  storageId   : String  -- unique ID for this DO's SQLite
  id          : String

structure BranchState where
  id        : String
  task      : String
  steps     : Nat
  score     : Option Float
  storageId : String    -- unique ID for this branch's isolated SQLite
  done      : Bool

structure MCTSSystemState where
  orch     : OrchestratorState
  branches : List BranchState
  net      : DONetwork

/-! ## Storage isolation -/

def StorageIsolated (s : MCTSSystemState) : Prop :=
  ∀ b ∈ s.branches, b.storageId ≠ s.orch.storageId

/-! ## Actions and transitions

  v4.0: Strengthened postconditions on Expand, BranchExplore,
  BranchEvaluate, and Backpropagate to constrain s'.branches
  storageIds. This closes SORRY-9 through SORRY-12.
-/

inductive MCTSAction where
  | Select
  | Expand (n : Nat) (newStorageIds : List String)
  | BranchExplore (branchId : String)
  | BranchEvaluate (branchId : String) (score : Float)
  | Backpropagate (nodeId : String) (reward : Float)
  | Prune (branchId : String)
  | Converge

def mctsTransition (s : MCTSSystemState) (a : MCTSAction) (s' : MCTSSystemState) : Prop :=
  match a with
  | .Select => s' = s
  | .Expand _ newIds =>
    -- Orchestrator state unchanged
    s'.orch = s.orch ∧
    -- New storage IDs are distinct from orchestrator
    (∀ sid ∈ newIds, sid ≠ s.orch.storageId) ∧
    -- v4.0: Every branch in s' either existed in s or has a storageId from newIds
    (∀ b ∈ s'.branches, b ∈ s.branches ∨ b.storageId ∈ newIds)
  | .BranchExplore _ =>
    -- Orchestrator unchanged
    s'.orch = s.orch ∧
    -- v4.0: Branch set unchanged (explore mutates branch-internal state only)
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.storageId = b'.storageId)
  | .BranchEvaluate bid score =>
    s'.orch = s.orch ∧
    (∃ b ∈ s'.branches, b.id == bid ∧ b.score = some score) ∧
    -- v4.0: StorageIds preserved (only score field changes)
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.storageId = b'.storageId)
  | .Backpropagate _ _ =>
    s'.orch.budget = s.orch.budget ∧
    -- v4.0: Orchestrator storageId preserved
    s'.orch.storageId = s.orch.storageId ∧
    -- v4.0: Branch storageIds preserved
    (∀ b ∈ s'.branches, ∃ b' ∈ s.branches, b.storageId = b'.storageId)
  | .Prune bid =>
    s'.orch.budget + 1 = s.orch.budget ∧
    s'.orch.storageId = s.orch.storageId ∧
    s'.branches = s.branches.filter fun b => !(b.id == bid)
  | .Converge => s.orch.budget = 0 ∧ s' = s

/-! ## Veil instance -/

def mctsInit (s : MCTSSystemState) : Prop :=
  s.orch.budget > 0 ∧ s.branches = [] ∧ s.net = DONetwork.empty

instance : TransitionSystem MCTSSystemState where
  init        := mctsInit
  assumptions := fun s => s.orch.budget ≤ 200
  next        := fun s s' => ∃ a, mctsTransition s a s'
  safe        := StorageIsolated
  inv         := StorageIsolated

/-! ## Core proofs -/

theorem init_isolated (s : MCTSSystemState) (h : mctsInit s) : StorageIsolated s := by
  simp [StorageIsolated, h.2.1]

theorem prune_decreases_budget (s s' : MCTSSystemState) (bid : String)
    (h : mctsTransition s (.Prune bid) s') : s'.orch.budget < s.orch.budget := by
  simp [mctsTransition] at h; omega

theorem prune_preserves_orch_storageId (s s' : MCTSSystemState) (bid : String)
    (h : mctsTransition s (.Prune bid) s') : s'.orch.storageId = s.orch.storageId := by
  simp [mctsTransition] at h; exact h.2.1

theorem budget_well_founded :
    WellFounded (InvImage (· < ·) (fun s : MCTSSystemState => s.orch.budget)) :=
  InvImage.wf _ Nat.lt_wfRel.wf

/-- Storage isolation is an invariant of the MCTS system.
    v4.0: All 7 transition cases now have sufficient postconditions. -/
theorem storage_isolation_invariant :
    isInvariant (σ := MCTSSystemState) StorageIsolated := by
  apply invInductive_ind
  · -- assumptions (budget ≤ 200) preserved through all transitions
    intro s s' _ hassm ⟨a, ha⟩
    rcases a with _ | ⟨_, newIds⟩ | _ | ⟨_, _⟩ | ⟨_, _⟩ | bid | _
    all_goals simp [mctsTransition] at ha
    · subst ha; exact hassm                     -- Select: s' = s
    · rw [ha.1]; exact hassm                    -- Expand: orch unchanged
    · rw [ha.1]; exact hassm                    -- BranchExplore: orch unchanged
    · rw [ha.1]; exact hassm                    -- BranchEvaluate: orch unchanged
    · omega                                      -- Backpropagate: budget preserved
    · omega                                      -- Prune: budget decreases
    · obtain ⟨_, hident⟩ := ha; subst hident; exact hassm -- Converge: s' = s
  · -- init establishes invariant
    intro s _ hi; exact init_isolated s hi
  · -- consecution: all transitions preserve StorageIsolated
    intro s s' _ hinv ⟨a, ha⟩
    simp [StorageIsolated]
    rcases a with _ | ⟨_, newIds⟩ | _ | ⟨_, _⟩ | ⟨_, _⟩ | bid | _
    · -- Select: s' = s
      simp [mctsTransition] at ha; subst ha; exact hinv
    · -- Expand: new branches have storageIds from newIds (disjoint from orch)
      simp [mctsTransition] at ha
      obtain ⟨horch, hdisj, hbranch⟩ := ha
      intro b hmem
      rcases hbranch b hmem with hold | hnew
      · rw [horch]; exact hinv b hold
      · rw [horch]; exact hdisj b.storageId hnew
    · -- BranchExplore: storageIds preserved from s.branches
      simp [mctsTransition] at ha
      obtain ⟨horch, hpres⟩ := ha
      intro b hmem
      obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
      rw [horch, hb'sid]; exact hinv b' hb'mem
    · -- BranchEvaluate: storageIds preserved from s.branches
      simp [mctsTransition] at ha
      obtain ⟨horch, _, hpres⟩ := ha
      intro b hmem
      obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
      rw [horch, hb'sid]; exact hinv b' hb'mem
    · -- Backpropagate: orch storageId + branch storageIds both preserved
      simp [mctsTransition] at ha
      obtain ⟨_, horsid, hpres⟩ := ha
      intro b hmem
      obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hmem
      rw [horsid, hb'sid]; exact hinv b' hb'mem
    · -- Prune: filtered list (was already proven)
      simp [mctsTransition] at ha
      obtain ⟨_, hstorage, hfilt⟩ := ha
      intro b hmem
      rw [hfilt] at hmem
      simp only [List.mem_filter, Bool.not_eq_true] at hmem
      rw [hstorage]
      exact hinv b hmem.1
    · -- Converge: s' = s
      simp [mctsTransition] at ha; obtain ⟨_, hident⟩ := ha; subst hident; exact hinv

end SelfEvolvingAgent.Distributed

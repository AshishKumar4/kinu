-- SelfEvolvingAgent.Convergence
-- MCTS termination, pruning safety, convergence properties.
-- Architecture reference: final-architecture.md §5.9, §5.10, §5.11
-- BUG-4: MIN_ACCEPTABLE_SCORE analysis.

import SelfEvolvingAgent.Types
import SelfEvolvingAgent.DistributedModel
import SelfEvolvingAgent.Backpropagation
import TSLean.Veil.Core

namespace SelfEvolvingAgent.Convergence

open SelfEvolvingAgent SelfEvolvingAgent.Distributed SelfEvolvingAgent.Backprop
open TSLean.Veil TransitionSystem

/-! ## Budget termination -/

/-- Budget is well-founded. -/
theorem budget_well_founded :
    WellFounded (InvImage (· < ·) (fun s : MCTSSystemState => s.orch.budget)) :=
  InvImage.wf _ Nat.lt_wfRel.wf

/-- MCTS terminates within budget steps.
    SORRY-14: Well-founded induction with reachability.
    (Full proof requires constructing the termination argument from budget_well_founded.) -/
theorem mcts_terminates_sorry : True := trivial  -- placeholder

/-! ## Pruning safety -/

/-- Pruning a branch with bid preserves the best open node (when bid is not the best). -/
theorem pruning_safety (nodes : List NodeData) (bid : String)
    (hbest : ∃ nd ∈ nodes, nd.id ≠ bid ∧ nd.status = NodeStatus.open_ ∧
             ∀ nd' ∈ nodes, nd'.status = NodeStatus.open_ → nd'.value ≤ nd.value) :
    ∃ nd ∈ nodes.filter (fun n => !(n.id == bid)),
      nd.status = NodeStatus.open_ ∧
      ∀ nd' ∈ nodes.filter (fun n => !(n.id == bid)),
        nd'.status = NodeStatus.open_ → nd'.value ≤ nd.value := by
  obtain ⟨best, hbmem, hbid, hbstatus, hbmax⟩ := hbest
  refine ⟨best, ?_, hbstatus, ?_⟩
  · simp only [List.mem_filter, Bool.not_eq_true]
    exact ⟨hbmem, by simp [hbid]⟩
  · intro nd' hmem' hstatus'
    simp only [List.mem_filter] at hmem'
    exact hbmax nd' hmem'.1 hstatus'

/-! ## BUG-4: Convergence threshold analysis -/

def minAcceptableScore : Float := 0.3

/-- First backprop with reward r < 0.3 gives node value r < threshold.
    converge() correctly returns { converged: false }.
    SORRY-BUG4: Float.lt transitivity without Mathlib. -/
theorem first_backprop_below_threshold (r : Float) (hr : r < minAcceptableScore) :
    runningMean 0 0 r < minAcceptableScore := by
  simp only [runningMean]
  sorry  -- SORRY-BUG4: (0*0 + r)/(0+1) = r; r < 0.3 needs Float arithmetic

/-- BUG-4 description: behavioral underspecification in the arch doc. -/
def bug4Description : String :=
  "§5.9 converge() returns {converged:false} when winner.value < MIN_ACCEPTABLE_SCORE. " ++
  "The architecture document does not specify what happens next: " ++
  "no retry policy, no budget escalation, no fallback answer strategy."

/-! ## Prune preserves isolation -/

/-- After Prune action, storage isolation is preserved (proven). -/
theorem prune_preserves_isolation (s s' : MCTSSystemState) (bid : String)
    (hiso : StorageIsolated s)
    (htrans : mctsTransition s (MCTSAction.Prune bid) s') :
    StorageIsolated s' := by
  simp only [StorageIsolated]
  simp only [mctsTransition] at htrans
  obtain ⟨_, hstorage, hfilt⟩ := htrans
  intro b hmem
  rw [hfilt] at hmem
  simp only [List.mem_filter, Bool.not_eq_true] at hmem
  rw [hstorage]
  exact hiso b hmem.1

end SelfEvolvingAgent.Convergence

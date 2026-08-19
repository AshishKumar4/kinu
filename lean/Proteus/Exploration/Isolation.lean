/-
  Proteus.Exploration.Isolation — why the existing storage-isolation proof does NOT
  reach an agent node, proved rather than asserted. 0 sorry.

  Specified by docs/EXPLORATION.md — "Isolation".

  **THIS FILE PROVES NOTHING ABOUT AGENT-NODE ISOLATION, AND THAT IS ITS POINT.**

  `MCTS/StorageIsolation.lean`'s `transition_preserves_isolation` holds precisely
  BECAUSE branches are toolless. There is no `toolless` identifier in Lean;
  toollessness is encoded as a frame condition on the two branch-side actions
  (`StorageIsolation.lean:32-37`), whose second conjunct says a branch may not
  introduce any storage identity not already held by an existing branch.
  **Acquiring storage — that is, having tools — is exactly what that conjunct
  forbids.**

  So a TOOLED unit — `answer` or `generator`, as against `thought`, the toolless
  degenerate point the old hypothesis still fits — invalidates the existing proof's
  HYPOTHESIS, not merely its conclusion. What invalidates it is ACQUIRING STORAGE
  and not the spelling of the axis value, so the two theorems below are that
  distinction made machine-checked rather than left as prose:

  * `agent_node_is_not_a_branch_explore` — a transition in which a node acquires
    its own storage does not satisfy `mctsTransition … .BranchExplore`. The
    existing theorem therefore does not APPLY to it. Nothing is weakened and
    nothing is extended; the theorem's domain is exhibited as not containing the
    case.

  * `dropping_the_frame_condition_breaks_isolation` — the conjunct is not
    removable. With only the orchestrator frame condition and no constraint on new
    storage identities, `StorageIsolated` is NOT preserved, and the witness is
    concrete. So the old proof cannot be extended to agent nodes by weakening the
    conjunct: that is the conjunct the proof consumes.

  -- WHAT AN AGENT-NODE REGION WOULD NEED, and why it is STILL not here:
  a NEW action with a NEW postcondition — a fresh, provably-disjoint storage id
  per node — and its own preservation proof. That region is now UNBLOCKED and
  UNWRITTEN, and those are two different states. Per-node isolation exists in the
  code: `agentHomeNodeProvisioner` (`strategy/node-workspace.ts`) gives a node a
  real home in the one global view, owned by the node's own uid, so there is now
  something for that postcondition to be REFINED FROM where before there was
  nothing to refine. Writing it ahead of that provisioner would have been the
  weakness `PR-MCTS-003`'s `remainingEvidence` already records for the branch case
  ("hand-asserted rather than refined from branch spawning and storage code"): a
  postcondition refining nothing reads as coverage and is not. Nothing below claims
  that region — the theorems here delimit the OLD proof and go no further.

  What the residue is, and *Isolation* names it: there are exactly two isolation
  states, and under `shared-origin-plane` there is no boundary, said out loud. In
  the shared-workspace layout heads are still merely ASKED to isolate themselves
  (`head-inference.ts`, the `shared-workspace` branch), and
  `HEAD_FILE_CHANGE_PROVENANCE` states that shell-command changes a head ran are
  not attributed to it.
-/

import Proteus.MCTS.StorageIsolation

namespace Proteus.Exploration.Isolation

open Proteus
open Proteus.MCTS.StorageIsolation

/-- What an agent node does that a toolless branch cannot: acquire a storage
    identity held by no existing branch. This is the modelling of "has tools" —
    *Isolation*'s reading of the frame condition, stated positively. -/
def AcquiresOwnStorage (s s' : MCTSSystemState) : Prop :=
  ∃ b ∈ s'.branches, ∀ b' ∈ s.branches, b.storageId ≠ b'.storageId

/-- **An agent node's step is not a `.BranchExplore` step.** So
    `transition_preserves_isolation` does not apply to it — its hypothesis is
    false, which is a stronger and more honest statement than "its conclusion is
    unproved". -/
theorem agent_node_is_not_a_branch_explore (s s' : MCTSSystemState)
    (h : AcquiresOwnStorage s s') : ¬ mctsTransition s s' .BranchExplore := by
  intro ht
  simp only [mctsTransition] at ht
  obtain ⟨_, hpres⟩ := ht
  obtain ⟨b, hb, hfresh⟩ := h
  obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hb
  exact hfresh b' hb'mem hb'sid

/-- The same for `.BranchEvaluate`, the other branch-side action carrying the frame
    condition — so the exclusion is not specific to one of the two. -/
theorem agent_node_is_not_a_branch_evaluate (s s' : MCTSSystemState) (score : Float)
    (h : AcquiresOwnStorage s s') : ¬ mctsTransition s s' (.BranchEvaluate score) := by
  intro ht
  simp only [mctsTransition] at ht
  obtain ⟨_, hpres⟩ := ht
  obtain ⟨b, hb, hfresh⟩ := h
  obtain ⟨b', hb'mem, hb'sid⟩ := hpres b hb
  exact hfresh b' hb'mem hb'sid

/-- **The frame condition is not removable.** Keeping only the orchestrator half —
    `s'.orch = s.orch`, which is what a naive "an agent node does not touch the
    orchestrator" reading would leave — admits a successor in which a node holds
    the ORCHESTRATOR's own storage id, and `StorageIsolated` fails.

    So the existing proof cannot be stretched over agent nodes by weakening the
    conjunct the `.BranchExplore` case consumes at
    `StorageIsolation.lean:73-77`. An agent-node region needs its own
    postcondition and its own proof. -/
theorem dropping_the_frame_condition_breaks_isolation :
    ∃ s s' : MCTSSystemState,
      StorageIsolated s ∧ s'.orch = s.orch ∧ ¬ StorageIsolated s' := by
  refine ⟨{ orch := { nodes := [], budget := 1, storageId := "orch" }, branches := [] },
          { orch := { nodes := [], budget := 1, storageId := "orch" },
            branches := [{ id := "n", storageId := "orch", score := none }] },
          ?_, rfl, ?_⟩
  · intro b hmem
    exact absurd hmem (List.not_mem_nil b)
  · intro hiso
    exact hiso { id := "n", storageId := "orch", score := none }
      (List.mem_cons_self _ _) rfl

/-- And the acquisition itself is representable, so
    `agent_node_is_not_a_branch_explore` is a statement about a case that exists
    rather than a vacuous exclusion. -/
theorem agent_node_step_is_representable :
    ∃ s s' : MCTSSystemState, AcquiresOwnStorage s s' := by
  refine ⟨{ orch := { nodes := [], budget := 1, storageId := "orch" }, branches := [] },
          { orch := { nodes := [], budget := 1, storageId := "orch" },
            branches := [{ id := "n", storageId := "node-ws", score := none }] },
          { id := "n", storageId := "node-ws", score := none },
          List.mem_cons_self _ _, ?_⟩
  intro b' hb'
  exact absurd hb' (List.not_mem_nil b')

end Proteus.Exploration.Isolation

/-
  Proteus.Axioms — axiom audit for every published theorem. 0 sorry.

  `#print axioms <thm>` reports at compile time exactly which axioms a proof
  depends on. Expected output for EVERY theorem below: either
  "does not depend on any axioms" or a subset of Lean's three built-in kernel
  axioms [propext, Classical.choice, Quot.sound] — never the proof-placeholder
  axiom, never `Lean.ofReduceBool`/`Lean.trustCompiler`, never a domain axiom.

  The corpus carries exactly one domain axiom — the trusted SQLite FTS5
  assumption `Proteus.Storage.FTS5Search.fts5_indexed_findable` — and no
  published theorem depends on it (any future consumer is the explicit,
  documented exception and must be annotated here). The WP-F1 traceability
  gate consumes this file's output; new theorems must be enrolled here.
-/

import Proteus

/-! ## Proteus/Agent/FiberDurability.lean -/

#print axioms Proteus.Agent.FiberDurability.start_conserved
#print axioms Proteus.Agent.FiberDurability.step_preserves_conservation
#print axioms Proteus.Agent.FiberDurability.step_decreases_remaining
#print axioms Proteus.Agent.FiberDurability.n_steps_remaining
#print axioms Proteus.Agent.FiberDurability.checkpoint_restore_roundtrip

/-! ## Proteus/Agent/Lifecycle.lean -/

#print axioms Proteus.Agent.Lifecycle.reset_clears_counters
#print axioms Proteus.Agent.Lifecycle.reset_preserves_turnCount
#print axioms Proteus.Agent.Lifecycle.step_increments
#print axioms Proteus.Agent.Lifecycle.tool_increments
#print axioms Proteus.Agent.Lifecycle.turn_increments
#print axioms Proteus.Agent.Lifecycle.steps_bounded_by_calls
#print axioms Proteus.Agent.Lifecycle.maxSteps_invariant

/-! ## Proteus/Agent/TurnQueue.lean -/

#print axioms Proteus.Agent.TurnQueue.enqueue_preserves_busy
#print axioms Proteus.Agent.TurnQueue.start_requires_idle
#print axioms Proteus.Agent.TurnQueue.start_makes_busy
#print axioms Proteus.Agent.TurnQueue.complete_clears_busy
#print axioms Proteus.Agent.TurnQueue.complete_increments
#print axioms Proteus.Agent.TurnQueue.enqueue_increases_total

/-! ## Proteus/Evolution/CraftStore.lean -/

#print axioms Proteus.Evolution.CraftStore.consolidate_keeps_above
#print axioms Proteus.Evolution.CraftStore.search_length_bound

/-! ## Proteus/Evolution/FullCraftLifecycle.lean -/

#print axioms Proteus.Evolution.FullCraftLifecycle.extract_increases
#print axioms Proteus.Evolution.FullCraftLifecycle.extract_contains
#print axioms Proteus.Evolution.FullCraftLifecycle.update_preserves
#print axioms Proteus.Evolution.FullCraftLifecycle.ema_bounded
#print axioms Proteus.Evolution.FullCraftLifecycle.consolidation_never_empties
#print axioms Proteus.Evolution.FullCraftLifecycle.consolidation_nonincreasing
#print axioms Proteus.Evolution.FullCraftLifecycle.remove_nonincreasing
#print axioms Proteus.Evolution.FullCraftLifecycle.full_lifecycle_nonempty
#print axioms Proteus.Evolution.FullCraftLifecycle.ema_stays_bounded
#print axioms Proteus.Evolution.FullCraftLifecycle.ema_nonneg
#print axioms Proteus.Evolution.FullCraftLifecycle.below_threshold_filtered
#print axioms Proteus.Evolution.FullCraftLifecycle.pipeline_preserves_nonempty

/-! ## Proteus/Evolution/Scaffold.lean -/

#print axioms Proteus.Evolution.Scaffold.rollback_nonexistent_is_none
#print axioms Proteus.Evolution.Scaffold.append_increases_length

/-! ## Proteus/Evolution/Timescales.lean -/

#print axioms Proteus.Evolution.Timescales.turnCount_increases
#print axioms Proteus.Evolution.Timescales.scaffoldVersion_nondecreasing
#print axioms Proteus.Evolution.Timescales.memorySize_nondecreasing
#print axioms Proteus.Evolution.Timescales.sessionCount_nondecreasing
#print axioms Proteus.Evolution.Timescales.nested_budget_bounded
#print axioms Proteus.Evolution.Timescales.deeper_costs_more

/-! ## Proteus/Execution/Capabilities.lean -/

#print axioms Proteus.Execution.Capabilities.container_subsumes_nimbus
#print axioms Proteus.Execution.Capabilities.ssh_subsumes_container
#print axioms Proteus.Execution.Capabilities.ssh_subsumes_nimbus
#print axioms Proteus.Execution.Capabilities.workspace_incomparable_nimbus
#print axioms Proteus.Execution.Capabilities.chain
#print axioms Proteus.Execution.Capabilities.route_satisfies_all
#print axioms Proteus.Execution.Capabilities.route_available
#print axioms Proteus.Execution.Capabilities.route_has_all_caps
#print axioms Proteus.Execution.Capabilities.subsumes_refl
#print axioms Proteus.Execution.Capabilities.subsumes_trans

/-! ## Proteus/Execution/ToolSystem.lean -/

#print axioms Proteus.Execution.ToolSystem.action_routes_to_valid_tool
#print axioms Proteus.Execution.ToolSystem.only_mcts_uses_explore
#print axioms Proteus.Execution.ToolSystem.shell_uses_run
#print axioms Proteus.Execution.ToolSystem.memory_search_uses_search
#print axioms Proteus.Execution.ToolSystem.memory_save_uses_note
#print axioms Proteus.Execution.ToolSystem.file_ops_use_codemode
#print axioms Proteus.Execution.ToolSystem.empty_is_isolated
#print axioms Proteus.Execution.ToolSystem.append_workspace_preserves

/-! ## Proteus/MCTS/Backpropagation.lean -/

#print axioms Proteus.MCTS.Backpropagation.init_values_equal_at_first_step
#print axioms Proteus.MCTS.Backpropagation.update_matches_ts_numerator
#print axioms Proteus.MCTS.Backpropagation.initial_in_range
#print axioms Proteus.MCTS.Backpropagation.update_preserves_range
#print axioms Proteus.MCTS.Backpropagation.applyRewards_preserves_range
#print axioms Proteus.MCTS.Backpropagation.applyRewards_sum_invariant
#print axioms Proteus.MCTS.Backpropagation.sum_invariant
#print axioms Proteus.MCTS.Backpropagation.backprop_preserves_ids

/-! ## Proteus/MCTS/StorageIsolation.lean -/

#print axioms Proteus.MCTS.StorageIsolation.init_isolated
#print axioms Proteus.MCTS.StorageIsolation.transition_preserves_isolation
#print axioms Proteus.MCTS.StorageIsolation.budget_well_founded

/-! ## Proteus/Safety/CapabilitySafety.lean -/

#print axioms Proteus.Safety.CapabilitySafety.grantableOps_only_toolcalls
#print axioms Proteus.Safety.CapabilitySafety.sqlwrite_not_grantable
#print axioms Proteus.Safety.CapabilitySafety.sqlread_not_grantable
#print axioms Proteus.Safety.CapabilitySafety.scaffoldwrite_not_grantable
#print axioms Proteus.Safety.CapabilitySafety.spawnsubagent_not_grantable
#print axioms Proteus.Safety.CapabilitySafety.networkfetch_not_grantable

/-! ## Proteus/Storage/FTS5Search.lean -/

#print axioms Proteus.Storage.FTS5Search.index_includes_new
#print axioms Proteus.Storage.FTS5Search.index_preserves_other
#print axioms Proteus.Storage.FTS5Search.search_bounded
#print axioms Proteus.Storage.FTS5Search.fts5_scores_nonneg

/-! ## Proteus/Storage/SqliteFSCorrectness.lean -/

#print axioms Proteus.Storage.SqliteFSCorrectness.write_read_roundtrip
#print axioms Proteus.Storage.SqliteFSCorrectness.mkdir_idempotent
#print axioms Proteus.Storage.SqliteFSCorrectness.chunkCount_drop
#print axioms Proteus.Storage.SqliteFSCorrectness.chunk_reassembly
#print axioms Proteus.Storage.SqliteFSCorrectness.writes_commute

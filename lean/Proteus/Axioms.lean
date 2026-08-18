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

/-! ## Proteus/Exploration -- docs/EXPLORATION-SPEC.md section 10 -/

/-! ### Proteus/Exploration/Objective.lean -/

#print axioms Proteus.Exploration.isBetter_irrefl
#print axioms Proteus.Exploration.isBetter_asymm
#print axioms Proteus.Exploration.isBetter_trans
#print axioms Proteus.Exploration.isBetter_total
#print axioms Proteus.Exploration.measurement_cannot_report_fault
#print axioms Proteus.Exploration.adversary_is_declarable_and_refused
#print axioms Proteus.Exploration.floorRoom_neg_iff_bestKnown_breaches
#print axioms Proteus.Exploration.floorAdmissible_rejects_negative_margin
#print axioms Proteus.Exploration.floorAdmissible_rejects_breaching_baseline
#print axioms Proteus.Exploration.floorAdmissible_rejects_adversary
#print axioms Proteus.Exploration.old_majority_floor_escapes_c1
#print axioms Proteus.Exploration.fixed_majority_floor_has_more_room
#print axioms Proteus.Exploration.c1_refuses_a_refuted_floor

/-! ### Proteus/Exploration/Publication.lean -/

#print axioms Proteus.Exploration.Publication.identityKey_is_floor_blind
#print axioms Proteus.Exploration.Publication.sealKey_discriminates
#print axioms Proteus.Exploration.Publication.isDiscriminating_eq
#print axioms Proteus.Exploration.Publication.constantList_false_witness
#print axioms Proteus.Exploration.Publication.inertValues_false_witness
#print axioms Proteus.Exploration.Publication.discriminating_gives_two_values
#print axioms Proteus.Exploration.Publication.single_candidate_is_insufficient_not_inert
#print axioms Proteus.Exploration.Publication.two_equal_candidates_are_inert
#print axioms Proteus.Exploration.Publication.identity_free_b1_accepts_verifier_noise
#print axioms Proteus.Exploration.Publication.baseline_supplies_the_second_value
#print axioms Proteus.Exploration.Publication.unmeasurable_does_not_discriminate
#print axioms Proteus.Exploration.Publication.runOf_nil
#print axioms Proteus.Exploration.Publication.runOf_cons
#print axioms Proteus.Exploration.Publication.breach_seals
#print axioms Proteus.Exploration.Publication.publish_requires_open
#print axioms Proteus.Exploration.Publication.retroPublish_requires_open
#print axioms Proteus.Exploration.Publication.sealed_is_absorbing
#print axioms Proteus.Exploration.Publication.sealed_publishes_nothing
#print axioms Proteus.Exploration.Publication.breach_freezes_the_store
#print axioms Proteus.Exploration.Publication.open_publish_writes
#print axioms Proteus.Exploration.Publication.retry_does_not_clear
#print axioms Proteus.Exploration.Publication.good_measurement_does_not_clear
#print axioms Proteus.Exploration.Publication.admissible_rederivation_reopens
#print axioms Proteus.Exploration.Publication.refuted_replacement_does_not_clear
#print axioms Proteus.Exploration.Publication.unaudited_rederivation_does_not_clear
#print axioms Proteus.Exploration.Publication.rederivation_restores_publication
#print axioms Proteus.Exploration.Publication.retroPublish_requires_same_verifier
#print axioms Proteus.Exploration.Publication.retroPublish_after_clearance_writes
#print axioms Proteus.Exploration.Publication.breach_does_not_halt
#print axioms Proteus.Exploration.Publication.sealed_still_scores
#print axioms Proteus.Exploration.Publication.breach_records_suspension
#print axioms Proteus.Exploration.Publication.fault_halts
#print axioms Proteus.Exploration.Publication.fault_writes_nothing
#print axioms Proteus.Exploration.Publication.halted_is_absorbing
#print axioms Proteus.Exploration.Publication.halted_does_nothing
#print axioms Proteus.Exploration.Publication.fault_freezes_the_run
#print axioms Proteus.Exploration.Publication.recorded_nodes_are_observed
#print axioms Proteus.Exploration.Publication.init_nodes_are_observed
#print axioms Proteus.Exploration.Publication.no_unobserved_node_is_reachable
#print axioms Proteus.Exploration.Publication.unobserved_node_is_representable
#print axioms Proteus.Exploration.Publication.published_implies_discriminated
#print axioms Proteus.Exploration.Publication.retroPublished_implies_discriminated
#print axioms Proteus.Exploration.Publication.non_discriminating_run_publishes_nothing
#print axioms Proteus.Exploration.Publication.discrimination_is_not_relevance
#print axioms Proteus.Exploration.Publication.bestOf_mem
#print axioms Proteus.Exploration.Publication.success_was_measured
#print axioms Proteus.Exploration.Publication.inert_cannot_succeed
#print axioms Proteus.Exploration.Publication.insufficient_cannot_succeed
#print axioms Proteus.Exploration.Publication.sealed_never_succeeds
#print axioms Proteus.Exploration.Publication.the_three_withholdings_are_distinct
#print axioms Proteus.Exploration.Publication.discriminating_run_succeeds

/-! ### Proteus/Exploration/Settle.lean -/

#print axioms Proteus.Exploration.Settle.settle_is_total
#print axioms Proteus.Exploration.Settle.settle_total_over_axes
#print axioms Proteus.Exploration.Settle.settleOf_archive_iff
#print axioms Proteus.Exploration.Settle.settleOf_front_iff
#print axioms Proteus.Exploration.Settle.settleOf_merge_iff
#print axioms Proteus.Exploration.Settle.archive_never_settles_best
#print axioms Proteus.Exploration.Settle.pareto_never_settles_best
#print axioms Proteus.Exploration.Settle.settleOf_best_iff
#print axioms Proteus.Exploration.Settle.settleOf_depends_only_on_score_and_advance
#print axioms Proteus.Exploration.Settle.settleOf_is_not_constant
#print axioms Proteus.Exploration.Settle.every_settle_kind_is_reachable

/-! ### Proteus/Exploration/Archive.lean -/

#print axioms Proteus.Exploration.Archive.functional_descriptor_partitions
#print axioms Proteus.Exploration.Archive.judged_descriptor_breaks_partition
#print axioms Proteus.Exploration.Archive.partial_descriptor_breaks_partition
#print axioms Proteus.Exploration.Archive.bucketOf_in_grid
#print axioms Proteus.Exploration.Archive.bucketOf_mem_grid
#print axioms Proteus.Exploration.Archive.bucketOf_partitions
#print axioms Proteus.Exploration.Archive.covered_has_a_member
#print axioms Proteus.Exploration.Archive.member_is_covered
#print axioms Proteus.Exploration.Archive.coverageCount_le_grid
#print axioms Proteus.Exploration.Archive.all_of_filter_length_eq
#print axioms Proteus.Exploration.Archive.full_coverage_fills_every_cell
#print axioms Proteus.Exploration.Archive.full_coverage_says_nothing_about_quality
#print axioms Proteus.Exploration.Archive.collapsed_archive_reports_partial_coverage

/-! ### Proteus/Exploration/Records.lean -/

#print axioms Proteus.Exploration.Records.notWorse_refl
#print axioms Proteus.Exploration.Records.notWorse_trans
#print axioms Proteus.Exploration.Records.best_nil
#print axioms Proteus.Exploration.Records.best_none_iff
#print axioms Proteus.Exploration.Records.best_cons
#print axioms Proteus.Exploration.Records.best_cons_none
#print axioms Proteus.Exploration.Records.best_cons_some
#print axioms Proteus.Exploration.Records.best_mem
#print axioms Proteus.Exploration.Records.best_notWorse_mem
#print axioms Proteus.Exploration.Records.best_notWorse_of_witness
#print axioms Proteus.Exploration.Records.mergeValue_notWorse
#print axioms Proteus.Exploration.Records.insertRow_monotone
#print axioms Proteus.Exploration.Records.insertRow_unique_digest
#print axioms Proteus.Exploration.Records.overwrite_breaks_monotonicity
#print axioms Proteus.Exploration.Records.merge_survives_the_same_input
#print axioms Proteus.Exploration.Records.isBetter_flip
#print axioms Proteus.Exploration.Records.removeFirst_subset
#print axioms Proteus.Exploration.Records.mem_removeFirst_of_ne
#print axioms Proteus.Exploration.Records.length_removeFirst
#print axioms Proteus.Exploration.Records.constant_of_best_eq_worst
#print axioms Proteus.Exploration.Records.removeWorst_monotone
#print axioms Proteus.Exploration.Records.write_monotone
#print axioms Proteus.Exploration.Records.writes_monotone
#print axioms Proteus.Exploration.Records.better_candidate_displaces
#print axioms Proteus.Exploration.Records.tie_does_not_displace
#print axioms Proteus.Exploration.Records.eviction_can_destroy_the_population
#print axioms Proteus.Exploration.Records.someStrictlyBetter_irrefl
#print axioms Proteus.Exploration.Records.dominates_irrefl
#print axioms Proteus.Exploration.Records.dominates_admits_incomparable
#print axioms Proteus.Exploration.Records.single_component_is_argmax
#print axioms Proteus.Exploration.Records.front_subset
#print axioms Proteus.Exploration.Records.front_undominated
#print axioms Proteus.Exploration.Records.front_insert_no_loss
#print axioms Proteus.Exploration.Records.front_can_shrink

/-! ### Proteus/Exploration/Arbitration.lean -/

#print axioms Proteus.Exploration.Arbitration.accepted_iff
#print axioms Proteus.Exploration.Arbitration.accepted_children_within_depth
#print axioms Proteus.Exploration.Arbitration.accepted_within_budget
#print axioms Proteus.Exploration.Arbitration.accepted_width_in_range
#print axioms Proteus.Exploration.Arbitration.accepted_respects_decorrelate
#print axioms Proteus.Exploration.Arbitration.archive_refuses_at_node
#print axioms Proteus.Exploration.Arbitration.arbitrate_at_zero_depth_always_refuses
#print axioms Proteus.Exploration.Arbitration.every_proposal_gets_a_verdict
#print axioms Proteus.Exploration.Arbitration.a_legal_proposal_is_accepted
#print axioms Proteus.Exploration.Arbitration.every_refusal_is_reachable
#print axioms Proteus.Exploration.Arbitration.an_adversarial_proposal_is_refused

/-! ### Proteus/Exploration/Isolation.lean -/

#print axioms Proteus.Exploration.Isolation.agent_node_is_not_a_branch_explore
#print axioms Proteus.Exploration.Isolation.agent_node_is_not_a_branch_evaluate
#print axioms Proteus.Exploration.Isolation.dropping_the_frame_condition_breaks_isolation
#print axioms Proteus.Exploration.Isolation.agent_node_step_is_representable

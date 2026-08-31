/-
  Kinu.Axioms — axiom audit for every published theorem. 0 sorry.

  `#print axioms <thm>` reports at compile time exactly which axioms a proof
  depends on. Expected output for EVERY theorem below: either
  "does not depend on any axioms" or a subset of Lean's three built-in kernel
  axioms [propext, Classical.choice, Quot.sound] — never the proof-placeholder
  axiom, never `Lean.ofReduceBool`/`Lean.trustCompiler`, never a domain axiom.

  The corpus carries exactly one domain axiom — the trusted SQLite FTS5
  assumption `Kinu.Storage.FTS5Search.fts5_indexed_findable` — and no
  published theorem depends on it (any future consumer is the explicit,
  documented exception and must be annotated here). The WP-F1 traceability
  gate consumes this file's output; new theorems must be enrolled here.
-/

import Kinu
import Kinu.Storage.DurableRoot

/-! ## Kinu/Agent/FiberDurability.lean -/

#print axioms Kinu.Agent.FiberDurability.start_conserved
#print axioms Kinu.Agent.FiberDurability.step_preserves_conservation
#print axioms Kinu.Agent.FiberDurability.step_decreases_remaining
#print axioms Kinu.Agent.FiberDurability.n_steps_remaining
#print axioms Kinu.Agent.FiberDurability.checkpoint_restore_roundtrip

/-! ## Kinu/Agent/Lifecycle.lean -/

#print axioms Kinu.Agent.Lifecycle.reset_clears_counters
#print axioms Kinu.Agent.Lifecycle.reset_preserves_turnCount
#print axioms Kinu.Agent.Lifecycle.step_increments
#print axioms Kinu.Agent.Lifecycle.tool_increments
#print axioms Kinu.Agent.Lifecycle.turn_increments
#print axioms Kinu.Agent.Lifecycle.steps_bounded_by_calls
#print axioms Kinu.Agent.Lifecycle.maxSteps_invariant

/-! ## Kinu/Agent/TurnQueue.lean -/

#print axioms Kinu.Agent.TurnQueue.enqueue_preserves_busy
#print axioms Kinu.Agent.TurnQueue.start_requires_idle
#print axioms Kinu.Agent.TurnQueue.start_makes_busy
#print axioms Kinu.Agent.TurnQueue.complete_clears_busy
#print axioms Kinu.Agent.TurnQueue.complete_increments
#print axioms Kinu.Agent.TurnQueue.enqueue_increases_total

/-! ## Kinu/Evolution/CraftStore.lean -/

#print axioms Kinu.Evolution.CraftStore.consolidate_keeps_above
#print axioms Kinu.Evolution.CraftStore.search_length_bound

/-! ## Kinu/Evolution/FullCraftLifecycle.lean -/

#print axioms Kinu.Evolution.FullCraftLifecycle.extract_increases
#print axioms Kinu.Evolution.FullCraftLifecycle.extract_contains
#print axioms Kinu.Evolution.FullCraftLifecycle.update_preserves
#print axioms Kinu.Evolution.FullCraftLifecycle.ema_bounded
#print axioms Kinu.Evolution.FullCraftLifecycle.consolidation_never_empties
#print axioms Kinu.Evolution.FullCraftLifecycle.consolidation_nonincreasing
#print axioms Kinu.Evolution.FullCraftLifecycle.remove_nonincreasing
#print axioms Kinu.Evolution.FullCraftLifecycle.full_lifecycle_nonempty
#print axioms Kinu.Evolution.FullCraftLifecycle.ema_stays_bounded
#print axioms Kinu.Evolution.FullCraftLifecycle.ema_nonneg
#print axioms Kinu.Evolution.FullCraftLifecycle.below_threshold_filtered
#print axioms Kinu.Evolution.FullCraftLifecycle.pipeline_preserves_nonempty

/-! ## Kinu/Evolution/Scaffold.lean -/

#print axioms Kinu.Evolution.Scaffold.rollback_nonexistent_is_none
#print axioms Kinu.Evolution.Scaffold.append_increases_length

/-! ## Kinu/Evolution/Timescales.lean -/

#print axioms Kinu.Evolution.Timescales.turnCount_increases
#print axioms Kinu.Evolution.Timescales.scaffoldVersion_nondecreasing
#print axioms Kinu.Evolution.Timescales.memorySize_nondecreasing
#print axioms Kinu.Evolution.Timescales.sessionCount_nondecreasing
#print axioms Kinu.Evolution.Timescales.nested_budget_bounded
#print axioms Kinu.Evolution.Timescales.deeper_costs_more

/-! ## Kinu/Execution/Capabilities.lean -/

#print axioms Kinu.Execution.Capabilities.container_subsumes_nimbus
#print axioms Kinu.Execution.Capabilities.ssh_subsumes_container
#print axioms Kinu.Execution.Capabilities.ssh_subsumes_nimbus
#print axioms Kinu.Execution.Capabilities.workspace_incomparable_nimbus
#print axioms Kinu.Execution.Capabilities.chain
#print axioms Kinu.Execution.Capabilities.route_satisfies_all
#print axioms Kinu.Execution.Capabilities.route_available
#print axioms Kinu.Execution.Capabilities.route_has_all_caps
#print axioms Kinu.Execution.Capabilities.subsumes_refl
#print axioms Kinu.Execution.Capabilities.subsumes_trans

/-! ## Kinu/Execution/ToolSystem.lean -/

#print axioms Kinu.Execution.ToolSystem.action_routes_to_valid_tool
#print axioms Kinu.Execution.ToolSystem.only_mcts_uses_explore
#print axioms Kinu.Execution.ToolSystem.shell_uses_run
#print axioms Kinu.Execution.ToolSystem.memory_search_uses_search
#print axioms Kinu.Execution.ToolSystem.memory_save_uses_note
#print axioms Kinu.Execution.ToolSystem.file_ops_use_codemode
#print axioms Kinu.Execution.ToolSystem.empty_is_isolated
#print axioms Kinu.Execution.ToolSystem.append_workspace_preserves

/-! ## Kinu/MCTS/Backpropagation.lean -/

#print axioms Kinu.MCTS.Backpropagation.init_values_equal_at_first_step
#print axioms Kinu.MCTS.Backpropagation.update_matches_ts_numerator
#print axioms Kinu.MCTS.Backpropagation.initial_in_range
#print axioms Kinu.MCTS.Backpropagation.update_preserves_range
#print axioms Kinu.MCTS.Backpropagation.applyRewards_preserves_range
#print axioms Kinu.MCTS.Backpropagation.applyRewards_sum_invariant
#print axioms Kinu.MCTS.Backpropagation.sum_invariant
#print axioms Kinu.MCTS.Backpropagation.backprop_preserves_ids

/-! ## Kinu/MCTS/StorageIsolation.lean -/

#print axioms Kinu.MCTS.StorageIsolation.init_isolated
#print axioms Kinu.MCTS.StorageIsolation.transition_preserves_isolation
#print axioms Kinu.MCTS.StorageIsolation.budget_well_founded

/-! ## Kinu/Safety/CapabilitySafety.lean -/

#print axioms Kinu.Safety.CapabilitySafety.grantableOps_only_toolcalls
#print axioms Kinu.Safety.CapabilitySafety.sqlwrite_not_grantable
#print axioms Kinu.Safety.CapabilitySafety.sqlread_not_grantable
#print axioms Kinu.Safety.CapabilitySafety.scaffoldwrite_not_grantable
#print axioms Kinu.Safety.CapabilitySafety.spawnsubagent_not_grantable
#print axioms Kinu.Safety.CapabilitySafety.networkfetch_not_grantable

/-! ## Kinu/Storage/FTS5Search.lean -/

#print axioms Kinu.Storage.FTS5Search.index_includes_new
#print axioms Kinu.Storage.FTS5Search.index_preserves_other
#print axioms Kinu.Storage.FTS5Search.search_bounded
#print axioms Kinu.Storage.FTS5Search.fts5_scores_nonneg

/-! ## Kinu/Storage/SqliteFSCorrectness.lean -/

#print axioms Kinu.Storage.SqliteFSCorrectness.write_read_roundtrip
#print axioms Kinu.Storage.SqliteFSCorrectness.mkdir_idempotent
#print axioms Kinu.Storage.SqliteFSCorrectness.chunkCount_drop
#print axioms Kinu.Storage.SqliteFSCorrectness.chunk_reassembly
#print axioms Kinu.Storage.SqliteFSCorrectness.writes_commute

/-! ## Kinu/Storage/SnapshotChain.lean -/

#print axioms Kinu.Storage.SnapshotChain.layers_le_two
#print axioms Kinu.Storage.SnapshotChain.chain_attach_mounts_its_layers
#print axioms Kinu.Storage.SnapshotChain.chain_attach_independent_of_n
#print axioms Kinu.Storage.SnapshotChain.chain_attach_independent_of_pending
#print axioms Kinu.Storage.SnapshotChain.attach_seed_is_the_committed_delta
#print axioms Kinu.Storage.SnapshotChain.attach_seed_absent_without_delta
#print axioms Kinu.Storage.SnapshotChain.a_pending_seed_would_differ
#print axioms Kinu.Storage.SnapshotChain.extract_attach_is_linear_in_n
#print axioms Kinu.Storage.SnapshotChain.chain_tick_uploads_unexcluded_bytes
#print axioms Kinu.Storage.SnapshotChain.chain_tick_upper_bound
#print axioms Kinu.Storage.SnapshotChain.chain_tick_exact_after_excludes
#print axioms Kinu.Storage.SnapshotChain.a_pending_only_tick_would_be_strictly_cheaper
#print axioms Kinu.Storage.SnapshotChain.first_base_uploads_unexcluded_bytes
#print axioms Kinu.Storage.SnapshotChain.first_base_upper_bound
#print axioms Kinu.Storage.SnapshotChain.tick_never_rebases
#print axioms Kinu.Storage.SnapshotChain.rebase_requires_the_delta_to_outgrow_k_base
#print axioms Kinu.Storage.SnapshotChain.rebase_amortizes_at_a_quiesce
#print axioms Kinu.Storage.SnapshotChain.a_tick_past_the_ratio_still_uploads_unexcluded_delta
#print axioms Kinu.Storage.SnapshotChain.the_changed_set_can_reach_the_whole_tree
#print axioms Kinu.Storage.SnapshotChain.referenced_generations_le_two
#print axioms Kinu.Storage.SnapshotChain.fresh_is_bounded
#print axioms Kinu.Storage.SnapshotChain.genStep_preserves_bound
#print axioms Kinu.Storage.SnapshotChain.stored_is_bounded_by_the_named_orphans
#print axioms Kinu.Storage.SnapshotChain.a_rebase_names_one_generation
#print axioms Kinu.Storage.SnapshotChain.a_completed_sweep_leaves_one_generation
#print axioms Kinu.Storage.SnapshotChain.a_partial_sweep_is_re_runnable
#print axioms Kinu.Storage.SnapshotChain.without_a_sweep_the_population_grows
#print axioms Kinu.Storage.SnapshotChain.unchanged_tick_uploads_nothing

/-! ## Kinu/Storage/OverlayCas.lean -/

#print axioms Kinu.Storage.OverlayCas.overlay_mounts_two_layers
#print axioms Kinu.Storage.OverlayCas.overlay_layers_le_two
#print axioms Kinu.Storage.OverlayCas.replay_is_linear_in_pending
#print axioms Kinu.Storage.OverlayCas.overlay_attach_independent_of_n
#print axioms Kinu.Storage.OverlayCas.overlay_attach_independent_of_cumulative
#print axioms Kinu.Storage.OverlayCas.overlay_attach_scans_only_pending
#print axioms Kinu.Storage.OverlayCas.read_is_one_lookup_and_one_chunk
#print axioms Kinu.Storage.OverlayCas.overlay_read_independent_of_n
#print axioms Kinu.Storage.OverlayCas.tick_is_blobs_plus_one_put_per_batch
#print axioms Kinu.Storage.OverlayCas.batching_the_journal_beats_one_put_per_entry
#print axioms Kinu.Storage.OverlayCas.one_entry_costs_one_journal_put
#print axioms Kinu.Storage.OverlayCas.batches_cover_the_pending_change
#print axioms Kinu.Storage.OverlayCas.a_crash_redoes_at_most_one_batch
#print axioms Kinu.Storage.OverlayCas.a_redone_batch_stages_no_bytes
#print axioms Kinu.Storage.OverlayCas.overlay_tick_independent_of_n
#print axioms Kinu.Storage.OverlayCas.overlay_tick_independent_of_cumulative
#print axioms Kinu.Storage.OverlayCas.overlay_tick_beats_the_chain_when_pending_is_small
#print axioms Kinu.Storage.OverlayCas.quiesce_fold_carries_the_one_linear_term
#print axioms Kinu.Storage.OverlayCas.the_fold_operation_count_is_not_linear_in_the_tree
#print axioms Kinu.Storage.OverlayCas.quiesce_minus_the_fold_is_the_tick
#print axioms Kinu.Storage.OverlayCas.tick_does_not_fold
#print axioms Kinu.Storage.OverlayCas.discard_is_one_prefix_delete
#print axioms Kinu.Storage.OverlayCas.gc_is_bounded_by_listing_and_orphans
#print axioms Kinu.Storage.OverlayCas.gc_is_off_the_hot_path
#print axioms Kinu.Storage.OverlayCas.the_sweep_does_read_the_listing
#print axioms Kinu.Storage.OverlayCas.the_hot_path_lists_only_the_journal_prefix
#print axioms Kinu.Storage.OverlayCas.runOf_nil
#print axioms Kinu.Storage.OverlayCas.runOf_cons
#print axioms Kinu.Storage.OverlayCas.runOf_append
#print axioms Kinu.Storage.OverlayCas.empty_is_ordered
#print axioms Kinu.Storage.OverlayCas.step_preserves_ordering
#print axioms Kinu.Storage.OverlayCas.ordering_is_invariant
#print axioms Kinu.Storage.OverlayCas.no_cursor_ahead_of_its_fold
#print axioms Kinu.Storage.OverlayCas.no_journal_entry_names_an_unstaged_blob
#print axioms Kinu.Storage.OverlayCas.no_fold_precedes_its_journal_entry
#print axioms Kinu.Storage.OverlayCas.the_cursor_never_passes_a_staged_blob
#print axioms Kinu.Storage.OverlayCas.no_reap_precedes_its_cursor
#print axioms Kinu.Storage.OverlayCas.the_reap_never_passes_a_staged_blob
#print axioms Kinu.Storage.OverlayCas.blobless_entry_can_be_journalled
#print axioms Kinu.Storage.OverlayCas.dropping_blob_before_journal_names_an_unstaged_blob
#print axioms Kinu.Storage.OverlayCas.dropping_fold_before_cursor_advances_past_the_fold
#print axioms Kinu.Storage.OverlayCas.dropping_journal_before_fold_folds_an_unrecorded_entry
#print axioms Kinu.Storage.OverlayCas.dropping_cursor_before_reap_leaves_a_hole
#print axioms Kinu.Storage.OverlayCas.a_tick_journals_without_folding
#print axioms Kinu.Storage.OverlayCas.a_quiesce_folds_and_advances
#print axioms Kinu.Storage.OverlayCas.the_reversed_order_does_nothing
#print axioms Kinu.Storage.OverlayCas.a_tombstone_stages_no_bytes
#print axioms Kinu.Storage.OverlayCas.a_rename_stages_no_bytes
#print axioms Kinu.Storage.OverlayCas.a_fresh_write_stages_its_bytes
#print axioms Kinu.Storage.SnapshotChain.a_completed_tick_closes_the_window
#print axioms Kinu.Storage.SnapshotChain.a_tick_free_segment_only_writes
#print axioms Kinu.Storage.SnapshotChain.loss_is_the_writes_since_the_last_tick
#print axioms Kinu.Storage.SnapshotChain.skipped_ticks_preserve_loss
#print axioms Kinu.Storage.SnapshotChain.no_number_of_skipping_ticks_closes_the_window
#print axioms Kinu.Storage.SnapshotChain.a_skipping_tick_leaves_the_window_open
#print axioms Kinu.Storage.OverlayCas.batch_step_preserves_order
#print axioms Kinu.Storage.OverlayCas.batch_trace_from
#print axioms Kinu.Storage.OverlayCas.batch_trace_invariant
#print axioms Kinu.Storage.OverlayCas.batch_crash_loss_le_writes_since_tick

/-! ## Kinu/Exploration -- docs/EXPLORATION.md — "The Lean invariants" -/

/-! ### Kinu/Exploration/Objective.lean -/

#print axioms Kinu.Exploration.isBetter_irrefl
#print axioms Kinu.Exploration.isBetter_asymm
#print axioms Kinu.Exploration.isBetter_trans
#print axioms Kinu.Exploration.isBetter_total
#print axioms Kinu.Exploration.measurement_cannot_report_fault
#print axioms Kinu.Exploration.adversary_is_declarable_and_refused
#print axioms Kinu.Exploration.floorRoom_neg_iff_bestKnown_breaches
#print axioms Kinu.Exploration.floorAdmissible_rejects_negative_margin
#print axioms Kinu.Exploration.floorAdmissible_rejects_breaching_baseline
#print axioms Kinu.Exploration.floorAdmissible_rejects_adversary
#print axioms Kinu.Exploration.old_majority_floor_escapes_c1
#print axioms Kinu.Exploration.fixed_majority_floor_has_more_room
#print axioms Kinu.Exploration.c1_refuses_a_refuted_floor

/-! ### Kinu/Exploration/Publication.lean -/

#print axioms Kinu.Exploration.Publication.identityKey_is_floor_blind
#print axioms Kinu.Exploration.Publication.sealKey_discriminates
#print axioms Kinu.Exploration.Publication.isDiscriminating_eq
#print axioms Kinu.Exploration.Publication.constantList_false_witness
#print axioms Kinu.Exploration.Publication.inertValues_false_witness
#print axioms Kinu.Exploration.Publication.discriminating_gives_two_values
#print axioms Kinu.Exploration.Publication.single_candidate_is_insufficient_not_inert
#print axioms Kinu.Exploration.Publication.two_equal_candidates_are_inert
#print axioms Kinu.Exploration.Publication.identity_free_b1_accepts_verifier_noise
#print axioms Kinu.Exploration.Publication.baseline_supplies_the_second_value
#print axioms Kinu.Exploration.Publication.unmeasurable_does_not_discriminate
#print axioms Kinu.Exploration.Publication.runOf_nil
#print axioms Kinu.Exploration.Publication.runOf_cons
#print axioms Kinu.Exploration.Publication.breach_seals
#print axioms Kinu.Exploration.Publication.publish_requires_open
#print axioms Kinu.Exploration.Publication.retroPublish_requires_open
#print axioms Kinu.Exploration.Publication.sealed_is_absorbing
#print axioms Kinu.Exploration.Publication.sealed_publishes_nothing
#print axioms Kinu.Exploration.Publication.breach_freezes_the_store
#print axioms Kinu.Exploration.Publication.retry_does_not_clear
#print axioms Kinu.Exploration.Publication.good_measurement_does_not_clear
#print axioms Kinu.Exploration.Publication.refuted_replacement_does_not_clear
#print axioms Kinu.Exploration.Publication.unaudited_rederivation_does_not_clear
#print axioms Kinu.Exploration.Publication.rederivation_restores_publication
#print axioms Kinu.Exploration.Publication.retroPublish_requires_same_verifier
#print axioms Kinu.Exploration.Publication.breach_does_not_halt
#print axioms Kinu.Exploration.Publication.sealed_still_scores
#print axioms Kinu.Exploration.Publication.breach_records_suspension
#print axioms Kinu.Exploration.Publication.fault_halts
#print axioms Kinu.Exploration.Publication.fault_writes_nothing
#print axioms Kinu.Exploration.Publication.halted_is_absorbing
#print axioms Kinu.Exploration.Publication.halted_does_nothing
#print axioms Kinu.Exploration.Publication.fault_freezes_the_run
#print axioms Kinu.Exploration.Publication.recorded_nodes_are_observed
#print axioms Kinu.Exploration.Publication.init_nodes_are_observed
#print axioms Kinu.Exploration.Publication.no_unobserved_node_is_reachable
#print axioms Kinu.Exploration.Publication.unobserved_node_is_representable
#print axioms Kinu.Exploration.Publication.published_implies_discriminated
#print axioms Kinu.Exploration.Publication.retroPublished_implies_discriminated
#print axioms Kinu.Exploration.Publication.non_discriminating_run_publishes_nothing
#print axioms Kinu.Exploration.Publication.discrimination_is_not_relevance
#print axioms Kinu.Exploration.Publication.bestOf_mem
#print axioms Kinu.Exploration.Publication.success_was_measured
#print axioms Kinu.Exploration.Publication.inert_cannot_succeed
#print axioms Kinu.Exploration.Publication.insufficient_cannot_succeed
#print axioms Kinu.Exploration.Publication.sealed_never_succeeds
#print axioms Kinu.Exploration.Publication.the_three_withholdings_are_distinct
#print axioms Kinu.Exploration.Publication.discriminating_run_succeeds
#print axioms Kinu.Exploration.Publication.surface_enumeration_is_total
#print axioms Kinu.Exploration.Publication.surface_enumeration_has_six
#print axioms Kinu.Exploration.Publication.admits_ignores_surface
#print axioms Kinu.Exploration.Publication.admits_iff_not_uncleared
#print axioms Kinu.Exploration.Publication.every_surface_is_writable
#print axioms Kinu.Exploration.Publication.every_surface_is_retro_writable
#print axioms Kinu.Exploration.Publication.admissible_rederivation_admits
#print axioms Kinu.Exploration.Publication.sealed_still_reports
#print axioms Kinu.Exploration.Publication.suppression_none_is_not_zero
#print axioms Kinu.Exploration.Publication.cleared_seal_discloses_nothing
#print axioms Kinu.Exploration.Publication.sealed_publish_counts_the_refusal
#print axioms Kinu.Exploration.Publication.inert_refusal_is_not_a_suppression
#print axioms Kinu.Exploration.Publication.suppression_counts_every_refusal
#print axioms Kinu.Exploration.Publication.suppressedCells_counts_each_cell_once
#print axioms Kinu.Exploration.Publication.suppressedCells_le_improvements
#print axioms Kinu.Exploration.Publication.suppressedCells_monotone
#print axioms Kinu.Exploration.Publication.suppression_quantities_are_independent

/-! ### Kinu/Exploration/Settle.lean -/

#print axioms Kinu.Exploration.Settle.settle_is_total
#print axioms Kinu.Exploration.Settle.settle_total_over_axes
#print axioms Kinu.Exploration.Settle.settleOf_archive_iff
#print axioms Kinu.Exploration.Settle.settleOf_front_iff
#print axioms Kinu.Exploration.Settle.settleOf_merge_iff
#print axioms Kinu.Exploration.Settle.archive_never_settles_best
#print axioms Kinu.Exploration.Settle.pareto_never_settles_best
#print axioms Kinu.Exploration.Settle.settleOf_best_iff
#print axioms Kinu.Exploration.Settle.settleOf_depends_only_on_score_and_advance
#print axioms Kinu.Exploration.Settle.settleOf_is_not_constant
#print axioms Kinu.Exploration.Settle.every_settle_kind_is_reachable

/-! ### Kinu/Exploration/Archive.lean -/

#print axioms Kinu.Exploration.Archive.functional_descriptor_partitions
#print axioms Kinu.Exploration.Archive.judged_descriptor_breaks_partition
#print axioms Kinu.Exploration.Archive.partial_descriptor_breaks_partition
#print axioms Kinu.Exploration.Archive.bucketOf_in_grid
#print axioms Kinu.Exploration.Archive.bucketOf_mem_grid
#print axioms Kinu.Exploration.Archive.bucketOf_partitions
#print axioms Kinu.Exploration.Archive.covered_has_a_member
#print axioms Kinu.Exploration.Archive.member_is_covered
#print axioms Kinu.Exploration.Archive.coverageCount_le_grid
#print axioms Kinu.Exploration.Archive.all_of_filter_length_eq
#print axioms Kinu.Exploration.Archive.full_coverage_fills_every_cell
#print axioms Kinu.Exploration.Archive.full_coverage_says_nothing_about_quality
#print axioms Kinu.Exploration.Archive.collapsed_archive_reports_partial_coverage

/-! ### Kinu/Exploration/Records.lean -/

#print axioms Kinu.Exploration.Records.notWorse_refl
#print axioms Kinu.Exploration.Records.notWorse_trans
#print axioms Kinu.Exploration.Records.best_nil
#print axioms Kinu.Exploration.Records.best_none_iff
#print axioms Kinu.Exploration.Records.best_cons
#print axioms Kinu.Exploration.Records.best_cons_none
#print axioms Kinu.Exploration.Records.best_cons_some
#print axioms Kinu.Exploration.Records.best_mem
#print axioms Kinu.Exploration.Records.best_notWorse_mem
#print axioms Kinu.Exploration.Records.best_notWorse_of_witness
#print axioms Kinu.Exploration.Records.mergeValue_notWorse
#print axioms Kinu.Exploration.Records.insertRow_monotone
#print axioms Kinu.Exploration.Records.insertRow_unique_digest
#print axioms Kinu.Exploration.Records.overwrite_breaks_monotonicity
#print axioms Kinu.Exploration.Records.merge_survives_the_same_input
#print axioms Kinu.Exploration.Records.isBetter_flip
#print axioms Kinu.Exploration.Records.removeFirst_subset
#print axioms Kinu.Exploration.Records.mem_removeFirst_of_ne
#print axioms Kinu.Exploration.Records.length_removeFirst
#print axioms Kinu.Exploration.Records.constant_of_best_eq_worst
#print axioms Kinu.Exploration.Records.removeWorst_monotone
#print axioms Kinu.Exploration.Records.write_monotone
#print axioms Kinu.Exploration.Records.writes_monotone
#print axioms Kinu.Exploration.Records.better_candidate_displaces
#print axioms Kinu.Exploration.Records.tie_does_not_displace
#print axioms Kinu.Exploration.Records.eviction_can_destroy_the_population
#print axioms Kinu.Exploration.Records.someStrictlyBetter_irrefl
#print axioms Kinu.Exploration.Records.dominates_irrefl
#print axioms Kinu.Exploration.Records.dominates_admits_incomparable
#print axioms Kinu.Exploration.Records.single_component_is_argmax
#print axioms Kinu.Exploration.Records.front_subset
#print axioms Kinu.Exploration.Records.front_undominated
#print axioms Kinu.Exploration.Records.frontier_nondominance
#print axioms Kinu.Exploration.Records.accepted_advance_preserves_objective_evidence
#print axioms Kinu.Exploration.Records.front_insert_no_loss
#print axioms Kinu.Exploration.Records.front_can_shrink

/-! ### Kinu/Exploration/Arbitration.lean -/

#print axioms Kinu.Exploration.Arbitration.accepted_iff
#print axioms Kinu.Exploration.Arbitration.accepted_children_within_depth
#print axioms Kinu.Exploration.Arbitration.accepted_within_budget
#print axioms Kinu.Exploration.Arbitration.accepted_width_in_range
#print axioms Kinu.Exploration.Arbitration.accepted_respects_context
#print axioms Kinu.Exploration.Arbitration.archive_refuses_at_node
#print axioms Kinu.Exploration.Arbitration.arbitrate_at_zero_depth_always_refuses
#print axioms Kinu.Exploration.Arbitration.every_proposal_gets_a_verdict
#print axioms Kinu.Exploration.Arbitration.a_legal_proposal_is_accepted
#print axioms Kinu.Exploration.Arbitration.every_refusal_is_reachable
#print axioms Kinu.Exploration.Arbitration.an_adversarial_proposal_is_refused

/-! ### Kinu/Exploration/Isolation.lean -/

#print axioms Kinu.Exploration.Isolation.agent_node_is_not_a_branch_explore
#print axioms Kinu.Exploration.Isolation.agent_node_is_not_a_branch_evaluate
#print axioms Kinu.Exploration.Isolation.dropping_the_frame_condition_breaks_isolation
#print axioms Kinu.Exploration.Isolation.agent_node_step_is_representable

/-! ### Kinu/Exploration/RecordsStore.lean -/

#print axioms Kinu.Exploration.RecordsStore.runOf_nil
#print axioms Kinu.Exploration.RecordsStore.runOf_cons
#print axioms Kinu.Exploration.RecordsStore.overwrite_monotone_of_admissible
#print axioms Kinu.Exploration.RecordsStore.recorded_is_admissible
#print axioms Kinu.Exploration.RecordsStore.refused_write_changes_nothing
#print axioms Kinu.Exploration.RecordsStore.step_monotone
#print axioms Kinu.Exploration.RecordsStore.best_never_falls
#print axioms Kinu.Exploration.RecordsStore.best_never_falls_below_a_recorded_value
#print axioms Kinu.Exploration.RecordsStore.step_deletes_no_digest
#print axioms Kinu.Exploration.RecordsStore.trace_deletes_no_digest
#print axioms Kinu.Exploration.RecordsStore.write_keeps_one_row_per_digest
#print axioms Kinu.Exploration.RecordsStore.an_unguarded_write_lowers_the_best
#print axioms Kinu.Exploration.RecordsStore.removing_a_row_can_lower_the_best
#print axioms Kinu.Exploration.RecordsStore.stepLenient_monotone
#print axioms Kinu.Exploration.RecordsStore.lenient_best_never_falls
#print axioms Kinu.Exploration.RecordsStore.the_tie_rule_is_not_what_makes_it_monotone
#print axioms Kinu.Exploration.RecordsStore.a_better_write_is_recorded
#print axioms Kinu.Exploration.RecordsStore.a_worse_new_artifact_joins
#print axioms Kinu.Exploration.RecordsStore.the_direction_decides
#print axioms Kinu.Exploration.RecordsStore.a_sealed_store_refuses_by_name
#print axioms Kinu.Exploration.RecordsStore.a_cleared_seal_records_again
#print axioms Kinu.Exploration.RecordsStore.a_breach_seals_the_store

/-! ### Kinu/Exploration/ArchiveAdmission.lean -/

#print axioms Kinu.Exploration.ArchiveAdmission.runOf_append
#print axioms Kinu.Exploration.ArchiveAdmission.belowFloor_foldl
#print axioms Kinu.Exploration.ArchiveAdmission.tooClose_iff_belowFloor
#print axioms Kinu.Exploration.ArchiveAdmission.refuses_iff_an_occupant_is_too_close
#print axioms Kinu.Exploration.ArchiveAdmission.admitted_of_all_far
#print axioms Kinu.Exploration.ArchiveAdmission.admitted_is_far_from_every_occupant
#print axioms Kinu.Exploration.ArchiveAdmission.step_preserves_separation
#print axioms Kinu.Exploration.ArchiveAdmission.separation_is_invariant
#print axioms Kinu.Exploration.ArchiveAdmission.no_near_copy_is_reachable
#print axioms Kinu.Exploration.ArchiveAdmission.discreteDist_of_ne
#print axioms Kinu.Exploration.ArchiveAdmission.discreteDist_symm
#print axioms Kinu.Exploration.ArchiveAdmission.descending_length
#print axioms Kinu.Exploration.ArchiveAdmission.lt_of_mem_descending
#print axioms Kinu.Exploration.ArchiveAdmission.fresh_run
#print axioms Kinu.Exploration.ArchiveAdmission.separated_cells_are_unboundedly_large
#print axioms Kinu.Exploration.ArchiveAdmission.a_repeat_does_not_grow_the_population
#print axioms Kinu.Exploration.ArchiveAdmission.a_near_copy_is_refused_and_names_the_occupant
#print axioms Kinu.Exploration.ArchiveAdmission.an_empty_cell_admits
#print axioms Kinu.Exploration.ArchiveAdmission.the_threshold_is_read_as_a_floor
#print axioms Kinu.Exploration.ArchiveAdmission.an_identical_artifact_is_not_a_near_copy
#print axioms Kinu.Exploration.ArchiveAdmission.the_refusal_names_the_nearest
#print axioms Kinu.Exploration.ArchiveAdmission.inverting_the_search_admits_a_near_copy

/-! ### Kinu/Exploration/FanIn.lean -/

#print axioms Kinu.Exploration.FanIn.landsCleanly_append
#print axioms Kinu.Exploration.FanIn.placeStep_preserves
#print axioms Kinu.Exploration.FanIn.onePass_preserves
#print axioms Kinu.Exploration.FanIn.sweeps_preserves
#print axioms Kinu.Exploration.FanIn.placedOf_landsCleanly
#print axioms Kinu.Exploration.FanIn.ordered_is_placedOf
#print axioms Kinu.Exploration.FanIn.derived_order_satisfies_rule_one
#print axioms Kinu.Exploration.FanIn.mem_of_filter_eq_nil
#print axioms Kinu.Exploration.FanIn.every_member_is_ordered
#print axioms Kinu.Exploration.FanIn.placeStep_allMembers
#print axioms Kinu.Exploration.FanIn.onePass_allMembers
#print axioms Kinu.Exploration.FanIn.sweeps_allMembers
#print axioms Kinu.Exploration.FanIn.placedOf_allMembers
#print axioms Kinu.Exploration.FanIn.unique_append_singleton
#print axioms Kinu.Exploration.FanIn.placeStep_unique
#print axioms Kinu.Exploration.FanIn.onePass_unique
#print axioms Kinu.Exploration.FanIn.sweeps_unique
#print axioms Kinu.Exploration.FanIn.placedOf_unique
#print axioms Kinu.Exploration.FanIn.a_cycle_applies_nothing
#print axioms Kinu.Exploration.FanIn.the_sweep_bound_is_tight
#print axioms Kinu.Exploration.FanIn.a_chain_offered_backwards_still_orders
#print axioms Kinu.Exploration.FanIn.a_dependent_offered_first_is_applied_last
#print axioms Kinu.Exploration.FanIn.an_unordered_set_keeps_the_order_it_was_offered_in
#print axioms Kinu.Exploration.FanIn.a_dependency_outside_the_offered_set_is_not_an_edge
#print axioms Kinu.Exploration.FanIn.a_settled_dependency_is_not_an_edge
#print axioms Kinu.Exploration.FanIn.a_cycle_is_refused_by_name
#print axioms Kinu.Exploration.FanIn.a_self_dependency_is_a_cycle
#print axioms Kinu.Exploration.FanIn.an_orderable_member_does_not_land_beside_a_cycle
#print axioms Kinu.Exploration.FanIn.an_orderable_set_applies_every_member
#print axioms Kinu.Exploration.FanIn.the_offered_order_can_fail_rule_one

/-! ### Kinu/Exploration/Rebase.lean -/

#print axioms Kinu.Exploration.Rebase.readAt_writeAt
#print axioms Kinu.Exploration.Rebase.applied_is_bound_to_the_base_it_lands_on
#print axioms Kinu.Exploration.Rebase.rebase_applies_only_bound_verdicts
#print axioms Kinu.Exploration.Rebase.member_only_binding_cannot_see_the_origin
#print axioms Kinu.Exploration.Rebase.map_eq_pointwise
#print axioms Kinu.Exploration.Rebase.the_base_key_moves_when_a_touched_path_moves
#print axioms Kinu.Exploration.Rebase.both_members_are_bound_to_the_initial_base
#print axioms Kinu.Exploration.Rebase.the_rebase_moves_the_second_members_base
#print axioms Kinu.Exploration.Rebase.no_reverifier_refuses_the_stale_member
#print axioms Kinu.Exploration.Rebase.the_member_digest_does_not_move_when_the_origin_does
#print axioms Kinu.Exploration.Rebase.member_only_binding_applies_the_stale_member
#print axioms Kinu.Exploration.Rebase.re_verification_against_the_new_base_applies
#print axioms Kinu.Exploration.Rebase.a_reverification_bound_elsewhere_does_not_revalidate
#print axioms Kinu.Exploration.Rebase.a_failed_recheck_refuses
#print axioms Kinu.Exploration.Rebase.an_unresolved_verifier_refuses
#print axioms Kinu.Exploration.Rebase.an_unclean_verdict_is_refused_by_its_own_cause
#print axioms Kinu.Exploration.Rebase.removing_the_comparison_applies_the_stale_verdict
#print axioms Kinu.Exploration.Rebase.an_absent_path_is_not_an_empty_one
#print axioms Kinu.Exploration.Rebase.the_base_key_ignores_untouched_paths
#print axioms Kinu.Exploration.Rebase.the_rebase_stops_at_the_stale_member
#print axioms Kinu.Exploration.Rebase.re_verification_lets_the_whole_rebase_land

/-! ## Kinu/Storage/DurableRoot.lean -/

#print axioms Kinu.Storage.DurableRoot.await_point_register_is_total
#print axioms Kinu.Storage.DurableRoot.await_point_register_has_sixteen

/-! ### Capture soundness — mutation durability ordering -/

#print axioms Kinu.Storage.DurableRoot.journal_intent_precedes_effect
#print axioms Kinu.Storage.DurableRoot.effect_precedes_journal_result
#print axioms Kinu.Storage.DurableRoot.journal_result_precedes_reply

/-! ### Capture soundness — fence durability ordering -/

#print axioms Kinu.Storage.DurableRoot.admission_closes_before_drain
#print axioms Kinu.Storage.DurableRoot.drain_precedes_root_syncfs
#print axioms Kinu.Storage.DurableRoot.root_syncfs_precedes_stage
#print axioms Kinu.Storage.DurableRoot.sealed_stage_precedes_manifest_fsync
#print axioms Kinu.Storage.DurableRoot.manifest_fsync_precedes_fence_fsync

/-! ### Capture soundness — the fenced linearization point -/

#print axioms Kinu.Storage.DurableRoot.fenced_point_is_linearization_point
#print axioms Kinu.Storage.DurableRoot.fenced_point_is_process_quiescent
#print axioms Kinu.Storage.DurableRoot.fenced_point_has_one_committed_generation
#print axioms Kinu.Storage.DurableRoot.fenced_capture_is_not_torn
#print axioms Kinu.Storage.DurableRoot.fenced_capture_cut_excluded
#print axioms Kinu.Storage.DurableRoot.fenced_capture_excludes_private_and_mount
#print axioms Kinu.Storage.DurableRoot.journal_capture_sound

/-! ### Reset-safe durable root -/

#print axioms Kinu.Storage.DurableRoot.runOf_nil
#print axioms Kinu.Storage.DurableRoot.runOf_cons
#print axioms Kinu.Storage.DurableRoot.initial_safe
#print axioms Kinu.Storage.DurableRoot.step_preserves_safe
#print axioms Kinu.Storage.DurableRoot.run_preserves_safe
#print axioms Kinu.Storage.DurableRoot.published_root_closure
#print axioms Kinu.Storage.DurableRoot.monotone_fenced_head
#print axioms Kinu.Storage.DurableRoot.run_monotone_fenced_head
#print axioms Kinu.Storage.DurableRoot.single_operation_row
#print axioms Kinu.Storage.DurableRoot.redrive_preserves_safe
#print axioms Kinu.Storage.DurableRoot.redrive_idempotent
#print axioms Kinu.Storage.DurableRoot.reset_at_every_await
#print axioms Kinu.Storage.DurableRoot.reset_discards_activation_memory
#print axioms Kinu.Storage.DurableRoot.redrive_after_every_reset_is_idempotent
#print axioms Kinu.Storage.DurableRoot.stale_completion_garbage_only
#print axioms Kinu.Storage.DurableRoot.on_start_idempotent
#print axioms Kinu.Storage.DurableRoot.on_start_once_per_generation
#print axioms Kinu.Storage.DurableRoot.restore_exact_head
#print axioms Kinu.Storage.DurableRoot.restore_ignores_activation_memory
#print axioms Kinu.Storage.DurableRoot.container_crash_preserves_durable_outcome
#print axioms Kinu.Storage.DurableRoot.crash_during_sweep_leaks_only
#print axioms Kinu.Storage.DurableRoot.pin_gc_noninterference
#print axioms Kinu.Storage.DurableRoot.root_set_change_aborts_mark_sweep
#print axioms Kinu.Storage.DurableRoot.idempotent_deletion
#print axioms Kinu.Storage.DurableRoot.delete_preserves_closure
#print axioms Kinu.Storage.DurableRoot.barrier_prefix_survives_crash
#print axioms Kinu.Storage.DurableRoot.async_suffix_loss
#print axioms Kinu.Storage.DurableRoot.payload_excluded_from_durable_view
#print axioms Kinu.Storage.DurableRoot.payload_excluded_from_restore
#print axioms Kinu.Storage.DurableRoot.unbounded_wait_counterexample
#print axioms Kinu.Storage.DurableRoot.safety_has_no_unconditional_wall_clock_bound
#print axioms Kinu.Storage.DurableRoot.collision_resistance_separates_objects
#print axioms Kinu.Storage.DurableRoot.capture_sound_is_explicit
#print axioms Kinu.Storage.DurableRoot.acknowledge_is_event_only
#print axioms Kinu.Storage.DurableRoot.retry_reads_head
#print axioms Kinu.Storage.DurableRoot.durable_intent_before_external_await
#print axioms Kinu.Storage.DurableRoot.sealed_carries_only_verified_root_id
#print axioms Kinu.Storage.DurableRoot.published_and_acknowledged_bind
#print axioms Kinu.Storage.DurableRoot.gc_candidates_derive_from_two_manifests
#print axioms Kinu.Storage.DurableRoot.unique_attempt_fence
#print axioms Kinu.Storage.DurableRoot.container_mount_is_envelope_identity
#print axioms Kinu.Storage.DurableRoot.omitted_intent_has_unsafe_witness
#print axioms Kinu.Storage.DurableRoot.omitted_fence_has_unsafe_witness
#print axioms Kinu.Storage.DurableRoot.omitted_pin_has_gc_witness
#print axioms Kinu.Storage.DurableRoot.parent_before_child_has_unsafe_witness
#print axioms Kinu.Storage.DurableRoot.acknowledgement_before_head_has_unsafe_witness
#print axioms Kinu.Storage.DurableRoot.receipt_release_too_early_witness
#print axioms Kinu.Storage.DurableRoot.root_set_race_witness
#print axioms Kinu.Storage.DurableRoot.container_onstart_activation_memory_witness

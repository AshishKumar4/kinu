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
import Proteus.Storage.DurableRoot

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

/-! ## Proteus/Storage/SnapshotChain.lean -/

#print axioms Proteus.Storage.SnapshotChain.layers_le_two
#print axioms Proteus.Storage.SnapshotChain.chain_attach_mounts_its_layers
#print axioms Proteus.Storage.SnapshotChain.chain_attach_independent_of_n
#print axioms Proteus.Storage.SnapshotChain.chain_attach_independent_of_pending
#print axioms Proteus.Storage.SnapshotChain.attach_seed_is_the_committed_delta
#print axioms Proteus.Storage.SnapshotChain.attach_seed_absent_without_delta
#print axioms Proteus.Storage.SnapshotChain.a_pending_seed_would_differ
#print axioms Proteus.Storage.SnapshotChain.extract_attach_is_linear_in_n
#print axioms Proteus.Storage.SnapshotChain.chain_tick_uploads_unexcluded_bytes
#print axioms Proteus.Storage.SnapshotChain.chain_tick_upper_bound
#print axioms Proteus.Storage.SnapshotChain.chain_tick_exact_after_excludes
#print axioms Proteus.Storage.SnapshotChain.a_pending_only_tick_would_be_strictly_cheaper
#print axioms Proteus.Storage.SnapshotChain.first_base_uploads_unexcluded_bytes
#print axioms Proteus.Storage.SnapshotChain.first_base_upper_bound
#print axioms Proteus.Storage.SnapshotChain.tick_never_rebases
#print axioms Proteus.Storage.SnapshotChain.rebase_requires_the_delta_to_outgrow_k_base
#print axioms Proteus.Storage.SnapshotChain.rebase_amortizes_at_a_quiesce
#print axioms Proteus.Storage.SnapshotChain.a_tick_past_the_ratio_still_uploads_unexcluded_delta
#print axioms Proteus.Storage.SnapshotChain.the_changed_set_can_reach_the_whole_tree
#print axioms Proteus.Storage.SnapshotChain.referenced_generations_le_two
#print axioms Proteus.Storage.SnapshotChain.fresh_is_bounded
#print axioms Proteus.Storage.SnapshotChain.genStep_preserves_bound
#print axioms Proteus.Storage.SnapshotChain.stored_is_bounded_by_the_named_orphans
#print axioms Proteus.Storage.SnapshotChain.a_rebase_names_one_generation
#print axioms Proteus.Storage.SnapshotChain.a_completed_sweep_leaves_one_generation
#print axioms Proteus.Storage.SnapshotChain.a_partial_sweep_is_re_runnable
#print axioms Proteus.Storage.SnapshotChain.without_a_sweep_the_population_grows
#print axioms Proteus.Storage.SnapshotChain.unchanged_tick_uploads_nothing

/-! ## Proteus/Storage/OverlayCas.lean -/

#print axioms Proteus.Storage.OverlayCas.overlay_mounts_two_layers
#print axioms Proteus.Storage.OverlayCas.overlay_layers_le_two
#print axioms Proteus.Storage.OverlayCas.replay_is_linear_in_pending
#print axioms Proteus.Storage.OverlayCas.overlay_attach_independent_of_n
#print axioms Proteus.Storage.OverlayCas.overlay_attach_independent_of_cumulative
#print axioms Proteus.Storage.OverlayCas.overlay_attach_scans_only_pending
#print axioms Proteus.Storage.OverlayCas.read_is_one_lookup_and_one_chunk
#print axioms Proteus.Storage.OverlayCas.overlay_read_independent_of_n
#print axioms Proteus.Storage.OverlayCas.tick_is_blobs_plus_one_put_per_batch
#print axioms Proteus.Storage.OverlayCas.batching_the_journal_beats_one_put_per_entry
#print axioms Proteus.Storage.OverlayCas.one_entry_costs_one_journal_put
#print axioms Proteus.Storage.OverlayCas.batches_cover_the_pending_change
#print axioms Proteus.Storage.OverlayCas.a_crash_redoes_at_most_one_batch
#print axioms Proteus.Storage.OverlayCas.a_redone_batch_stages_no_bytes
#print axioms Proteus.Storage.OverlayCas.overlay_tick_independent_of_n
#print axioms Proteus.Storage.OverlayCas.overlay_tick_independent_of_cumulative
#print axioms Proteus.Storage.OverlayCas.overlay_tick_beats_the_chain_when_pending_is_small
#print axioms Proteus.Storage.OverlayCas.quiesce_fold_carries_the_one_linear_term
#print axioms Proteus.Storage.OverlayCas.the_fold_operation_count_is_not_linear_in_the_tree
#print axioms Proteus.Storage.OverlayCas.quiesce_minus_the_fold_is_the_tick
#print axioms Proteus.Storage.OverlayCas.tick_does_not_fold
#print axioms Proteus.Storage.OverlayCas.discard_is_one_prefix_delete
#print axioms Proteus.Storage.OverlayCas.gc_is_bounded_by_listing_and_orphans
#print axioms Proteus.Storage.OverlayCas.gc_is_off_the_hot_path
#print axioms Proteus.Storage.OverlayCas.the_sweep_does_read_the_listing
#print axioms Proteus.Storage.OverlayCas.the_hot_path_lists_only_the_journal_prefix
#print axioms Proteus.Storage.OverlayCas.runOf_nil
#print axioms Proteus.Storage.OverlayCas.runOf_cons
#print axioms Proteus.Storage.OverlayCas.runOf_append
#print axioms Proteus.Storage.OverlayCas.empty_is_ordered
#print axioms Proteus.Storage.OverlayCas.step_preserves_ordering
#print axioms Proteus.Storage.OverlayCas.ordering_is_invariant
#print axioms Proteus.Storage.OverlayCas.no_cursor_ahead_of_its_fold
#print axioms Proteus.Storage.OverlayCas.no_journal_entry_names_an_unstaged_blob
#print axioms Proteus.Storage.OverlayCas.no_fold_precedes_its_journal_entry
#print axioms Proteus.Storage.OverlayCas.the_cursor_never_passes_a_staged_blob
#print axioms Proteus.Storage.OverlayCas.no_reap_precedes_its_cursor
#print axioms Proteus.Storage.OverlayCas.the_reap_never_passes_a_staged_blob
#print axioms Proteus.Storage.OverlayCas.blobless_entry_can_be_journalled
#print axioms Proteus.Storage.OverlayCas.dropping_blob_before_journal_names_an_unstaged_blob
#print axioms Proteus.Storage.OverlayCas.dropping_fold_before_cursor_advances_past_the_fold
#print axioms Proteus.Storage.OverlayCas.dropping_journal_before_fold_folds_an_unrecorded_entry
#print axioms Proteus.Storage.OverlayCas.dropping_cursor_before_reap_leaves_a_hole
#print axioms Proteus.Storage.OverlayCas.a_tick_journals_without_folding
#print axioms Proteus.Storage.OverlayCas.a_quiesce_folds_and_advances
#print axioms Proteus.Storage.OverlayCas.the_reversed_order_does_nothing
#print axioms Proteus.Storage.OverlayCas.a_tombstone_stages_no_bytes
#print axioms Proteus.Storage.OverlayCas.a_rename_stages_no_bytes
#print axioms Proteus.Storage.OverlayCas.a_fresh_write_stages_its_bytes
#print axioms Proteus.Storage.SnapshotChain.a_completed_tick_closes_the_window
#print axioms Proteus.Storage.SnapshotChain.a_tick_free_segment_only_writes
#print axioms Proteus.Storage.SnapshotChain.loss_is_the_writes_since_the_last_tick
#print axioms Proteus.Storage.SnapshotChain.skipped_ticks_preserve_loss
#print axioms Proteus.Storage.SnapshotChain.no_number_of_skipping_ticks_closes_the_window
#print axioms Proteus.Storage.SnapshotChain.a_skipping_tick_leaves_the_window_open
#print axioms Proteus.Storage.OverlayCas.batch_step_preserves_order
#print axioms Proteus.Storage.OverlayCas.batch_trace_from
#print axioms Proteus.Storage.OverlayCas.batch_trace_invariant
#print axioms Proteus.Storage.OverlayCas.batch_crash_loss_le_writes_since_tick

/-! ## Proteus/Exploration -- docs/EXPLORATION.md — "The Lean invariants" -/

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
#print axioms Proteus.Exploration.Publication.retry_does_not_clear
#print axioms Proteus.Exploration.Publication.good_measurement_does_not_clear
#print axioms Proteus.Exploration.Publication.refuted_replacement_does_not_clear
#print axioms Proteus.Exploration.Publication.unaudited_rederivation_does_not_clear
#print axioms Proteus.Exploration.Publication.rederivation_restores_publication
#print axioms Proteus.Exploration.Publication.retroPublish_requires_same_verifier
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
#print axioms Proteus.Exploration.Publication.surface_enumeration_is_total
#print axioms Proteus.Exploration.Publication.surface_enumeration_has_six
#print axioms Proteus.Exploration.Publication.admits_ignores_surface
#print axioms Proteus.Exploration.Publication.admits_iff_not_uncleared
#print axioms Proteus.Exploration.Publication.every_surface_is_writable
#print axioms Proteus.Exploration.Publication.every_surface_is_retro_writable
#print axioms Proteus.Exploration.Publication.admissible_rederivation_admits
#print axioms Proteus.Exploration.Publication.sealed_still_reports
#print axioms Proteus.Exploration.Publication.suppression_none_is_not_zero
#print axioms Proteus.Exploration.Publication.cleared_seal_discloses_nothing
#print axioms Proteus.Exploration.Publication.sealed_publish_counts_the_refusal
#print axioms Proteus.Exploration.Publication.inert_refusal_is_not_a_suppression
#print axioms Proteus.Exploration.Publication.suppression_counts_every_refusal
#print axioms Proteus.Exploration.Publication.suppressedCells_counts_each_cell_once
#print axioms Proteus.Exploration.Publication.suppressedCells_le_improvements
#print axioms Proteus.Exploration.Publication.suppressedCells_monotone
#print axioms Proteus.Exploration.Publication.suppression_quantities_are_independent

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
#print axioms Proteus.Exploration.Records.frontier_nondominance
#print axioms Proteus.Exploration.Records.accepted_advance_preserves_objective_evidence
#print axioms Proteus.Exploration.Records.front_insert_no_loss
#print axioms Proteus.Exploration.Records.front_can_shrink

/-! ### Proteus/Exploration/Arbitration.lean -/

#print axioms Proteus.Exploration.Arbitration.accepted_iff
#print axioms Proteus.Exploration.Arbitration.accepted_children_within_depth
#print axioms Proteus.Exploration.Arbitration.accepted_within_budget
#print axioms Proteus.Exploration.Arbitration.accepted_width_in_range
#print axioms Proteus.Exploration.Arbitration.accepted_respects_context
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

/-! ### Proteus/Exploration/RecordsStore.lean -/

#print axioms Proteus.Exploration.RecordsStore.runOf_nil
#print axioms Proteus.Exploration.RecordsStore.runOf_cons
#print axioms Proteus.Exploration.RecordsStore.overwrite_monotone_of_admissible
#print axioms Proteus.Exploration.RecordsStore.recorded_is_admissible
#print axioms Proteus.Exploration.RecordsStore.refused_write_changes_nothing
#print axioms Proteus.Exploration.RecordsStore.step_monotone
#print axioms Proteus.Exploration.RecordsStore.best_never_falls
#print axioms Proteus.Exploration.RecordsStore.best_never_falls_below_a_recorded_value
#print axioms Proteus.Exploration.RecordsStore.step_deletes_no_digest
#print axioms Proteus.Exploration.RecordsStore.trace_deletes_no_digest
#print axioms Proteus.Exploration.RecordsStore.write_keeps_one_row_per_digest
#print axioms Proteus.Exploration.RecordsStore.an_unguarded_write_lowers_the_best
#print axioms Proteus.Exploration.RecordsStore.removing_a_row_can_lower_the_best
#print axioms Proteus.Exploration.RecordsStore.stepLenient_monotone
#print axioms Proteus.Exploration.RecordsStore.lenient_best_never_falls
#print axioms Proteus.Exploration.RecordsStore.the_tie_rule_is_not_what_makes_it_monotone
#print axioms Proteus.Exploration.RecordsStore.a_better_write_is_recorded
#print axioms Proteus.Exploration.RecordsStore.a_worse_new_artifact_joins
#print axioms Proteus.Exploration.RecordsStore.the_direction_decides
#print axioms Proteus.Exploration.RecordsStore.a_sealed_store_refuses_by_name
#print axioms Proteus.Exploration.RecordsStore.a_cleared_seal_records_again
#print axioms Proteus.Exploration.RecordsStore.a_breach_seals_the_store

/-! ### Proteus/Exploration/ArchiveAdmission.lean -/

#print axioms Proteus.Exploration.ArchiveAdmission.runOf_append
#print axioms Proteus.Exploration.ArchiveAdmission.belowFloor_foldl
#print axioms Proteus.Exploration.ArchiveAdmission.tooClose_iff_belowFloor
#print axioms Proteus.Exploration.ArchiveAdmission.refuses_iff_an_occupant_is_too_close
#print axioms Proteus.Exploration.ArchiveAdmission.admitted_of_all_far
#print axioms Proteus.Exploration.ArchiveAdmission.admitted_is_far_from_every_occupant
#print axioms Proteus.Exploration.ArchiveAdmission.step_preserves_separation
#print axioms Proteus.Exploration.ArchiveAdmission.separation_is_invariant
#print axioms Proteus.Exploration.ArchiveAdmission.no_near_copy_is_reachable
#print axioms Proteus.Exploration.ArchiveAdmission.discreteDist_of_ne
#print axioms Proteus.Exploration.ArchiveAdmission.discreteDist_symm
#print axioms Proteus.Exploration.ArchiveAdmission.descending_length
#print axioms Proteus.Exploration.ArchiveAdmission.lt_of_mem_descending
#print axioms Proteus.Exploration.ArchiveAdmission.fresh_run
#print axioms Proteus.Exploration.ArchiveAdmission.separated_cells_are_unboundedly_large
#print axioms Proteus.Exploration.ArchiveAdmission.a_repeat_does_not_grow_the_population
#print axioms Proteus.Exploration.ArchiveAdmission.a_near_copy_is_refused_and_names_the_occupant
#print axioms Proteus.Exploration.ArchiveAdmission.an_empty_cell_admits
#print axioms Proteus.Exploration.ArchiveAdmission.the_threshold_is_read_as_a_floor
#print axioms Proteus.Exploration.ArchiveAdmission.an_identical_artifact_is_not_a_near_copy
#print axioms Proteus.Exploration.ArchiveAdmission.the_refusal_names_the_nearest
#print axioms Proteus.Exploration.ArchiveAdmission.inverting_the_search_admits_a_near_copy

/-! ### Proteus/Exploration/FanIn.lean -/

#print axioms Proteus.Exploration.FanIn.landsCleanly_append
#print axioms Proteus.Exploration.FanIn.placeStep_preserves
#print axioms Proteus.Exploration.FanIn.onePass_preserves
#print axioms Proteus.Exploration.FanIn.sweeps_preserves
#print axioms Proteus.Exploration.FanIn.placedOf_landsCleanly
#print axioms Proteus.Exploration.FanIn.ordered_is_placedOf
#print axioms Proteus.Exploration.FanIn.derived_order_satisfies_rule_one
#print axioms Proteus.Exploration.FanIn.mem_of_filter_eq_nil
#print axioms Proteus.Exploration.FanIn.every_member_is_ordered
#print axioms Proteus.Exploration.FanIn.placeStep_allMembers
#print axioms Proteus.Exploration.FanIn.onePass_allMembers
#print axioms Proteus.Exploration.FanIn.sweeps_allMembers
#print axioms Proteus.Exploration.FanIn.placedOf_allMembers
#print axioms Proteus.Exploration.FanIn.unique_append_singleton
#print axioms Proteus.Exploration.FanIn.placeStep_unique
#print axioms Proteus.Exploration.FanIn.onePass_unique
#print axioms Proteus.Exploration.FanIn.sweeps_unique
#print axioms Proteus.Exploration.FanIn.placedOf_unique
#print axioms Proteus.Exploration.FanIn.a_cycle_applies_nothing
#print axioms Proteus.Exploration.FanIn.the_sweep_bound_is_tight
#print axioms Proteus.Exploration.FanIn.a_chain_offered_backwards_still_orders
#print axioms Proteus.Exploration.FanIn.a_dependent_offered_first_is_applied_last
#print axioms Proteus.Exploration.FanIn.an_unordered_set_keeps_the_order_it_was_offered_in
#print axioms Proteus.Exploration.FanIn.a_dependency_outside_the_offered_set_is_not_an_edge
#print axioms Proteus.Exploration.FanIn.a_settled_dependency_is_not_an_edge
#print axioms Proteus.Exploration.FanIn.a_cycle_is_refused_by_name
#print axioms Proteus.Exploration.FanIn.a_self_dependency_is_a_cycle
#print axioms Proteus.Exploration.FanIn.an_orderable_member_does_not_land_beside_a_cycle
#print axioms Proteus.Exploration.FanIn.an_orderable_set_applies_every_member
#print axioms Proteus.Exploration.FanIn.the_offered_order_can_fail_rule_one

/-! ### Proteus/Exploration/Rebase.lean -/

#print axioms Proteus.Exploration.Rebase.readAt_writeAt
#print axioms Proteus.Exploration.Rebase.applied_is_bound_to_the_base_it_lands_on
#print axioms Proteus.Exploration.Rebase.rebase_applies_only_bound_verdicts
#print axioms Proteus.Exploration.Rebase.member_only_binding_cannot_see_the_origin
#print axioms Proteus.Exploration.Rebase.map_eq_pointwise
#print axioms Proteus.Exploration.Rebase.the_base_key_moves_when_a_touched_path_moves
#print axioms Proteus.Exploration.Rebase.both_members_are_bound_to_the_initial_base
#print axioms Proteus.Exploration.Rebase.the_rebase_moves_the_second_members_base
#print axioms Proteus.Exploration.Rebase.no_reverifier_refuses_the_stale_member
#print axioms Proteus.Exploration.Rebase.the_member_digest_does_not_move_when_the_origin_does
#print axioms Proteus.Exploration.Rebase.member_only_binding_applies_the_stale_member
#print axioms Proteus.Exploration.Rebase.re_verification_against_the_new_base_applies
#print axioms Proteus.Exploration.Rebase.a_reverification_bound_elsewhere_does_not_revalidate
#print axioms Proteus.Exploration.Rebase.a_failed_recheck_refuses
#print axioms Proteus.Exploration.Rebase.an_unresolved_verifier_refuses
#print axioms Proteus.Exploration.Rebase.an_unclean_verdict_is_refused_by_its_own_cause
#print axioms Proteus.Exploration.Rebase.removing_the_comparison_applies_the_stale_verdict
#print axioms Proteus.Exploration.Rebase.an_absent_path_is_not_an_empty_one
#print axioms Proteus.Exploration.Rebase.the_base_key_ignores_untouched_paths
#print axioms Proteus.Exploration.Rebase.the_rebase_stops_at_the_stale_member
#print axioms Proteus.Exploration.Rebase.re_verification_lets_the_whole_rebase_land

/-! ## Proteus/Storage/DurableRoot.lean -/

#print axioms Proteus.Storage.DurableRoot.await_point_register_is_total
#print axioms Proteus.Storage.DurableRoot.await_point_register_has_sixteen
#print axioms Proteus.Storage.DurableRoot.runOf_nil
#print axioms Proteus.Storage.DurableRoot.runOf_cons
#print axioms Proteus.Storage.DurableRoot.initial_safe
#print axioms Proteus.Storage.DurableRoot.step_preserves_safe
#print axioms Proteus.Storage.DurableRoot.run_preserves_safe
#print axioms Proteus.Storage.DurableRoot.published_root_closure
#print axioms Proteus.Storage.DurableRoot.monotone_fenced_head
#print axioms Proteus.Storage.DurableRoot.run_monotone_fenced_head
#print axioms Proteus.Storage.DurableRoot.single_operation_row
#print axioms Proteus.Storage.DurableRoot.redrive_preserves_safe
#print axioms Proteus.Storage.DurableRoot.redrive_idempotent
#print axioms Proteus.Storage.DurableRoot.reset_at_every_await
#print axioms Proteus.Storage.DurableRoot.reset_discards_activation_memory
#print axioms Proteus.Storage.DurableRoot.redrive_after_every_reset_is_idempotent
#print axioms Proteus.Storage.DurableRoot.stale_completion_garbage_only
#print axioms Proteus.Storage.DurableRoot.on_start_idempotent
#print axioms Proteus.Storage.DurableRoot.on_start_once_per_generation
#print axioms Proteus.Storage.DurableRoot.restore_exact_head
#print axioms Proteus.Storage.DurableRoot.restore_ignores_activation_memory
#print axioms Proteus.Storage.DurableRoot.container_crash_preserves_durable_outcome
#print axioms Proteus.Storage.DurableRoot.crash_during_sweep_leaks_only
#print axioms Proteus.Storage.DurableRoot.pin_gc_noninterference
#print axioms Proteus.Storage.DurableRoot.root_set_change_aborts_mark_sweep
#print axioms Proteus.Storage.DurableRoot.idempotent_deletion
#print axioms Proteus.Storage.DurableRoot.delete_preserves_closure
#print axioms Proteus.Storage.DurableRoot.barrier_prefix_survives_crash
#print axioms Proteus.Storage.DurableRoot.async_suffix_loss
#print axioms Proteus.Storage.DurableRoot.payload_excluded_from_durable_view
#print axioms Proteus.Storage.DurableRoot.payload_excluded_from_restore
#print axioms Proteus.Storage.DurableRoot.unbounded_wait_counterexample
#print axioms Proteus.Storage.DurableRoot.safety_has_no_unconditional_wall_clock_bound
#print axioms Proteus.Storage.DurableRoot.collision_resistance_separates_objects
#print axioms Proteus.Storage.DurableRoot.capture_sound_is_explicit
#print axioms Proteus.Storage.DurableRoot.acknowledge_is_event_only
#print axioms Proteus.Storage.DurableRoot.retry_reads_head
#print axioms Proteus.Storage.DurableRoot.durable_intent_before_external_await
#print axioms Proteus.Storage.DurableRoot.sealed_carries_only_verified_root_id
#print axioms Proteus.Storage.DurableRoot.published_and_acknowledged_bind
#print axioms Proteus.Storage.DurableRoot.gc_candidates_derive_from_two_manifests
#print axioms Proteus.Storage.DurableRoot.unique_attempt_fence
#print axioms Proteus.Storage.DurableRoot.container_mount_is_envelope_identity
#print axioms Proteus.Storage.DurableRoot.omitted_intent_has_unsafe_witness
#print axioms Proteus.Storage.DurableRoot.omitted_fence_has_unsafe_witness
#print axioms Proteus.Storage.DurableRoot.omitted_pin_has_gc_witness
#print axioms Proteus.Storage.DurableRoot.parent_before_child_has_unsafe_witness
#print axioms Proteus.Storage.DurableRoot.acknowledgement_before_head_has_unsafe_witness
#print axioms Proteus.Storage.DurableRoot.receipt_release_too_early_witness
#print axioms Proteus.Storage.DurableRoot.root_set_race_witness
#print axioms Proteus.Storage.DurableRoot.container_onstart_activation_memory_witness

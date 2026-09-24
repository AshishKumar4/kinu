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

#print axioms Kinu.Execution.Capabilities.the_kind_says_who_owns_the_files
#print axioms Kinu.Execution.Capabilities.no_executor_claims_docker_or_gpu
#print axioms Kinu.Execution.Capabilities.subsumes_refl
#print axioms Kinu.Execution.Capabilities.subsumes_trans
#print axioms Kinu.Execution.Capabilities.a_session_extends_the_workspace

/-! ## Kinu/MCTS/Backpropagation.lean -/

#print axioms Kinu.MCTS.Backpropagation.init_values_equal_at_first_step
#print axioms Kinu.MCTS.Backpropagation.update_matches_ts_numerator
#print axioms Kinu.MCTS.Backpropagation.initial_in_range
#print axioms Kinu.MCTS.Backpropagation.update_preserves_range
#print axioms Kinu.MCTS.Backpropagation.applyRewards_preserves_range
#print axioms Kinu.MCTS.Backpropagation.applyRewards_sum_invariant
#print axioms Kinu.MCTS.Backpropagation.sum_invariant
#print axioms Kinu.MCTS.Backpropagation.backprop_preserves_ids

/-! ## Kinu/MCTS/Convergence.lean -/

#print axioms Kinu.MCTS.Convergence.backprop_accumulates_the_evaluations_through_a_node
#print axioms Kinu.MCTS.Convergence.the_winner_has_the_greatest_value
#print axioms Kinu.MCTS.Convergence.a_bounded_rising_reward_stabilizes
#print axioms Kinu.MCTS.Convergence.the_winner_carries_the_best_reward
#print axioms Kinu.MCTS.Convergence.the_search_expands_its_best_candidate_and_converges_on_it
#print axioms Kinu.MCTS.Convergence.an_ancestor_is_never_a_rival
#print axioms Kinu.MCTS.Convergence.a_converged_winner_is_undisputed_and_acceptable

/-! ## Kinu/MCTS/StorageIsolation.lean -/

#print axioms Kinu.MCTS.StorageIsolation.init_isolated
#print axioms Kinu.MCTS.StorageIsolation.transition_preserves_isolation
#print axioms Kinu.MCTS.StorageIsolation.a_write_leaves_other_actors_alone
#print axioms Kinu.MCTS.StorageIsolation.another_actors_writes_are_invisible
#print axioms Kinu.MCTS.StorageIsolation.budget_well_founded

/-! ## Kinu/MCTS/Uct.lean -/

#print axioms Kinu.MCTS.Uct.bonusOf_well_formed
#print axioms Kinu.MCTS.Uct.bonus_lt_irrefl
#print axioms Kinu.MCTS.Uct.bonus_lt_asymm
#print axioms Kinu.MCTS.Uct.bonus_trichotomy
#print axioms Kinu.MCTS.Uct.bonus_lt_trans
#print axioms Kinu.MCTS.Uct.bonus_order_is_power_order
#print axioms Kinu.MCTS.Uct.bonus_falls_with_own_visits
#print axioms Kinu.MCTS.Uct.bonus_rises_with_parent_visits
#print axioms Kinu.MCTS.Uct.unvisited_and_once_visited_tie
#print axioms Kinu.MCTS.Uct.parent_visits_below_two_tie
#print axioms Kinu.MCTS.Uct.every_bonus_is_positive
#print axioms Kinu.MCTS.Uct.the_root_bonus_rises_from_two_visits_to_three
#print axioms Kinu.MCTS.Uct.the_root_bonus_falls_from_one_visit_to_two
#print axioms Kinu.MCTS.Uct.the_root_bonus_falls_from_three_visits_on
#print axioms Kinu.MCTS.Uct.select_is_eligible
#print axioms Kinu.MCTS.Uct.select_is_maximal
#print axioms Kinu.MCTS.Uct.select_none_iff
#print axioms Kinu.MCTS.Uct.an_outranked_row_is_never_selected
#print axioms Kinu.MCTS.Uct.the_more_visited_of_two_equal_siblings_is_never_selected

/-! ## Kinu/Safety/Credentials.lean -/

#print axioms Kinu.Safety.Credentials.an_envelope_opens_only_where_it_was_sealed
#print axioms Kinu.Safety.Credentials.an_unsealed_row_opens_nowhere
#print axioms Kinu.Safety.Credentials.one_context_per_store_and_key
#print axioms Kinu.Safety.Credentials.credential_contexts_never_meet_mcp_contexts
#print axioms Kinu.Safety.Credentials.clients_cannot_tell_two_stores_apart_by_their_secrets
#print axioms Kinu.Safety.Credentials.a_deleted_credential_yields_no_headers
#print axioms Kinu.Safety.Credentials.rewrap_keeps_every_readable_secret
#print axioms Kinu.Safety.Credentials.rewrap_seals_plaintext_only_in_a_never_sealed_store

/-! ## Kinu/Safety/DeviceView.lean -/

#print axioms Kinu.Safety.DeviceView.outside_is_never_writable
#print axioms Kinu.Safety.DeviceView.kinu_own_directory_is_invisible_raw
#print axioms Kinu.Safety.DeviceView.kinu_own_directory_is_invisible
#print axioms Kinu.Safety.DeviceView.a_sandboxed_write_lands_where_consented
#print axioms Kinu.Safety.DeviceView.a_valid_segment_has_no_slash
#print axioms Kinu.Safety.DeviceView.an_accepted_home_is_one_workspace
#print axioms Kinu.Safety.DeviceView.no_frame_reaches_a_kinu_secret
#print axioms Kinu.Safety.DeviceView.another_workspace_is_invisible
#print axioms Kinu.Safety.DeviceView.a_spanning_name_reaches_a_kinu_secret
#print axioms Kinu.Safety.DeviceView.an_untiered_frame_is_refused
#print axioms Kinu.Safety.DeviceView.a_root_of_slash_is_raw

/-! ## Kinu/Safety/DeviceToken.lean -/

#print axioms Kinu.Safety.DeviceToken.a_ticket_is_spent_once
#print axioms Kinu.Safety.DeviceToken.a_ticket_dies_at_its_minute
#print axioms Kinu.Safety.DeviceToken.a_revoked_devices_ticket_admits_nothing
#print axioms Kinu.Safety.DeviceToken.revocation_is_permanent
#print axioms Kinu.Safety.DeviceToken.a_retired_token_revokes_its_device
#print axioms Kinu.Safety.DeviceToken.the_grace_is_one_shot
#print axioms Kinu.Safety.DeviceToken.ahead_after_own
#print axioms Kinu.Safety.DeviceToken.out_after_other
#print axioms Kinu.Safety.DeviceToken.revoked_after_out
#print axioms Kinu.Safety.DeviceToken.two_copies_cannot_alternate
#print axioms Kinu.Safety.DeviceToken.one_holder_is_never_revoked

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

/-! ## Kinu/Storage/LossWindow.lean -/

#print axioms Kinu.Storage.LossWindow.a_covered_write_survives
#print axioms Kinu.Storage.LossWindow.each_missed_tick_adds_a_period
#print axioms Kinu.Storage.LossWindow.ticks_lose_at_most_one_period_and_two_ticks
#print axioms Kinu.Storage.LossWindow.worstTicks_periodic
#print axioms Kinu.Storage.LossWindow.the_tick_bound_is_tight
#print axioms Kinu.Storage.LossWindow.the_gate_never_skips_a_periodic_tick
#print axioms Kinu.Storage.LossWindow.another_commit_never_loses_a_write
#print axioms Kinu.Storage.LossWindow.a_refused_stop_keeps_the_window

/-! ## Kinu/Storage/SnapshotChain.lean -/

#print axioms Kinu.Storage.SnapshotChain.layers_le_two
#print axioms Kinu.Storage.SnapshotChain.small_file_travels_whole
#print axioms Kinu.Storage.SnapshotChain.sparse_file_travels_whole
#print axioms Kinu.Storage.SnapshotChain.unavailable_hashes_travel_whole
#print axioms Kinu.Storage.SnapshotChain.chunked_file_publishes_blocks_and_record
#print axioms Kinu.Storage.SnapshotChain.chain_tick_is_sum_of_file_publications
#print axioms Kinu.Storage.SnapshotChain.chain_tick_append
#print axioms Kinu.Storage.SnapshotChain.identical_upper_republishes_same_blocks
#print axioms Kinu.Storage.SnapshotChain.deduplicated_stage_le_file_sum
#print axioms Kinu.Storage.SnapshotChain.unavailable_chunking_uses_full_upper
#print axioms Kinu.Storage.SnapshotChain.c3_overwrite_touches_at_most_five_blocks
#print axioms Kinu.Storage.SnapshotChain.c3_aligned_overwrite_touches_four_blocks
#print axioms Kinu.Storage.SnapshotChain.c3_uses_chunked_publication
#print axioms Kinu.Storage.SnapshotChain.c3_publication_bound
#print axioms Kinu.Storage.SnapshotChain.c3_wire_bound
#print axioms Kinu.Storage.SnapshotChain.c3_is_strictly_cheaper_than_whole_file
#print axioms Kinu.Storage.SnapshotChain.chain_attach_layer_setup
#print axioms Kinu.Storage.SnapshotChain.chain_attach_reads_manifest
#print axioms Kinu.Storage.SnapshotChain.chain_attach_reads_no_payload
#print axioms Kinu.Storage.SnapshotChain.chain_attach_independent_of_n
#print axioms Kinu.Storage.SnapshotChain.chain_attach_independent_of_pending
#print axioms Kinu.Storage.SnapshotChain.attach_without_delta_materializes_nothing
#print axioms Kinu.Storage.SnapshotChain.extract_attach_is_linear_in_n
#print axioms Kinu.Storage.SnapshotChain.first_base_uploads_unexcluded_bytes
#print axioms Kinu.Storage.SnapshotChain.first_base_upper_bound
#print axioms Kinu.Storage.SnapshotChain.tick_never_rebases
#print axioms Kinu.Storage.SnapshotChain.rebase_requires_the_delta_to_outgrow_k_base
#print axioms Kinu.Storage.SnapshotChain.rebase_amortizes_at_a_quiesce
#print axioms Kinu.Storage.SnapshotChain.a_tick_past_the_ratio_still_publishes_changed_blocks
#print axioms Kinu.Storage.SnapshotChain.retained_generations_le_two
#print axioms Kinu.Storage.SnapshotChain.fresh_retention_is_bounded
#print axioms Kinu.Storage.SnapshotChain.genStep_preserves_retention_bound
#print axioms Kinu.Storage.SnapshotChain.stored_is_bounded_by_current_fallback_and_orphans
#print axioms Kinu.Storage.SnapshotChain.first_rebase_retains_a_fallback
#print axioms Kinu.Storage.SnapshotChain.further_rebase_names_one_generation
#print axioms Kinu.Storage.SnapshotChain.proven_attach_retires_the_fallback
#print axioms Kinu.Storage.SnapshotChain.a_completed_sweep_leaves_current_and_fallback
#print axioms Kinu.Storage.SnapshotChain.a_partial_sweep_preserves_retained_generations
#print axioms Kinu.Storage.SnapshotChain.without_a_sweep_current_fallback_and_orphans_grow
#print axioms Kinu.Storage.SnapshotChain.unchanged_tick_uploads_nothing
#print axioms Kinu.Storage.SnapshotChain.a_completed_tick_closes_the_window
#print axioms Kinu.Storage.SnapshotChain.a_tick_free_segment_only_writes
#print axioms Kinu.Storage.SnapshotChain.loss_is_the_writes_since_the_last_tick
#print axioms Kinu.Storage.SnapshotChain.skipped_ticks_preserve_loss
#print axioms Kinu.Storage.SnapshotChain.no_number_of_skipping_ticks_closes_the_window
#print axioms Kinu.Storage.SnapshotChain.a_skipping_tick_leaves_the_window_open

/-! ## Kinu/Storage/BlockLayer.lean -/

#print axioms Kinu.Storage.BlockLayer.opacity_keeps_directory_record_count
#print axioms Kinu.Storage.BlockLayer.opaque_hides_base_names
#print axioms Kinu.Storage.BlockLayer.opaque_preserves_whole_records
#print axioms Kinu.Storage.BlockLayer.opaque_preserves_chunked_records
#print axioms Kinu.Storage.BlockLayer.attach_metadata_bound
#print axioms Kinu.Storage.BlockLayer.attach_payload_bytes
#print axioms Kinu.Storage.BlockLayer.median_children_half
#print axioms Kinu.Storage.BlockLayer.block_lookup_bound
#print axioms Kinu.Storage.BlockLayer.composed_read_correct
#print axioms Kinu.Storage.BlockLayer.hole_is_zero
#print axioms Kinu.Storage.BlockLayer.absent_override_reads_base
#print axioms Kinu.Storage.BlockLayer.ready_implies_all_composed_mounted
#print axioms Kinu.Storage.BlockLayer.copyup_is_file_local
#print axioms Kinu.Storage.BlockLayer.publication_accounting_unchanged
#print axioms Kinu.Storage.BlockLayer.c3_publication_stays_bounded

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
#print axioms Kinu.Exploration.defective_majority_floor_escapes_c1
#print axioms Kinu.Exploration.corrected_majority_floor_has_more_room
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
#print axioms Kinu.Exploration.Publication.admits_iff_not_sealed
#print axioms Kinu.Exploration.Publication.every_surface_is_writable
#print axioms Kinu.Exploration.Publication.every_surface_is_retro_writable
#print axioms Kinu.Exploration.Publication.sealed_still_reports
#print axioms Kinu.Exploration.Publication.suppression_none_is_not_zero
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
#print axioms Kinu.Exploration.Rebase.the_stale_member_is_refused
#print axioms Kinu.Exploration.Rebase.the_rebase_skips_the_refused_member
#print axioms Kinu.Exploration.Rebase.the_skipped_member_leaves_no_write_for_the_tail
#print axioms Kinu.Exploration.Rebase.a_member_assuming_the_skipped_write_is_refused
#print axioms Kinu.Exploration.Rebase.re_verification_lets_the_whole_rebase_land

/-! ## Kinu/Exploration/Concurrent.lean -/

#print axioms Kinu.Exploration.Concurrent.runC_cons
#print axioms Kinu.Exploration.Concurrent.the_best_never_falls_under_any_interleaving
#print axioms Kinu.Exploration.Concurrent.a_breach_stops_every_run_on_its_floor
#print axioms Kinu.Exploration.Concurrent.a_breach_in_one_run_seals_another
#print axioms Kinu.Exploration.Concurrent.a_split_check_and_write_lowers_the_best

/-! ## Kinu/Exploration/Counterfactual.lean -/

#print axioms Kinu.Exploration.Counterfactual.b1_witnesses_the_counterfactual
#print axioms Kinu.Exploration.Counterfactual.a_verifier_that_cannot_fail_never_passes_b1
#print axioms Kinu.Exploration.Counterfactual.a_verifier_that_can_fail_can_look_inert
#print axioms Kinu.Exploration.Counterfactual.b1_passes_input_blind_noise

/-! ## Kinu/Exploration/Improvement.lean -/

#print axioms Kinu.Exploration.Improvement.count_everything
#print axioms Kinu.Exploration.Improvement.no_improvement_is_at_most_geometric
#print axioms Kinu.Exploration.Improvement.no_improvement_becomes_improbable
#print axioms Kinu.Exploration.Improvement.a_gain_stop_is_at_most_geometric

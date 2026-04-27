# Formal Specification

Proteus ships a single Lean 4 formal specification project at `lean/`:
16 modules, 75 theorems/lemmas across 6 categories (Safety, MCTS, Evolution,
Agent, Storage, Execution). Uses `lakefile.lean` and
`leanprover/lean4:v4.16.0`. 8 theorems currently use `sorry` placeholders
(informational: tracked for closure, not blocking build).

## Module Structure

```
lean/
  Proteus.lean                        Root (imports all 16 modules)
  Proteus/
    Types.lean                        Domain types (NodeData, Op, CraftedTool, etc.)
    Safety/
      FloatAxioms.lean                IEEE 754 axioms (no theorems, axioms only)
      CapabilitySafety.lean           Sandbox capability bounds (6 theorems)
    MCTS/
      StorageIsolation.lean           Storage isolation invariant + budget (3 theorems)
      Backpropagation.lean            Running mean correctness (3 theorems)
    Evolution/
      Timescales.lean                 3-timescale monotonicity (6 theorems)
      CraftStore.lean                 EMA + consolidation (2 theorems)
      Scaffold.lean                   Version rollback + append (2 theorems)
      FullCraftLifecycle.lean         End-to-end craft lifecycle (12 theorems)
    Agent/
      Lifecycle.lean                  Turn/step/tool counters (7 theorems)
      FiberDurability.lean            Fiber budget conservation (5 theorems)
      TurnQueue.lean                  Queue serialization (6 theorems)
    Storage/
      FTS5Search.lean                 FTS5 indexing + bounded search (3 theorems + 2 axioms)
      SqliteFSCorrectness.lean        Write/read round-trip (2 theorems + 2 axioms)
    Execution/
      Capabilities.lean               Executor subsumption + routing (10 theorems)
      ToolSystem.lean                 5-tool architecture model (8 theorems)
  lakefile.lean                       Lean build config
  lean-toolchain                      leanprover/lean4:v4.16.0
```

## Proven Properties

### Safety — `Safety/CapabilitySafety.lean` (6 theorems)

Proves that the code execution sandbox can ONLY invoke `ToolCall` operations:

| Theorem | What it proves |
|---------|----------------|
| `grantableOps_only_toolcalls` | All grantable operations are ToolCall variants |
| `not_toolcall_not_grantable` | Non-ToolCall ops are never grantable (private helper) |
| `sqlwrite_not_grantable` | SQLWrite cannot be granted to sandbox |
| `sqlread_not_grantable` | SQLRead cannot be granted to sandbox |
| `scaffoldwrite_not_grantable` | ScaffoldWrite cannot be granted |
| `spawnsubagent_not_grantable` | SpawnSubAgent cannot be granted |
| `networkfetch_not_grantable` | NetworkFetch cannot be granted |

### MCTS Storage Isolation — `MCTS/StorageIsolation.lean` (3 theorems)

The `StorageIsolated` invariant is preserved through all MCTS transitions:

```
StorageIsolated(s) ≡ ∀ b ∈ s.branches, b.storageId ≠ s.orch.storageId
```

| Theorem | What it proves |
|---------|----------------|
| `init_isolated` | Initial MCTS state satisfies StorageIsolated |
| `transition_preserves_isolation` | All 7 transition cases (Select, Expand, BranchExplore, BranchEvaluate, Backpropagate, Prune, Converge) preserve the invariant |
| `budget_well_founded` | Budget is a well-founded measure (MCTS terminates) |

### Backpropagation — `MCTS/Backpropagation.lean` (3 theorems)

| Theorem | What it proves |
|---------|----------------|
| `initial_valid` | Initial state `{visits:0, rewardSum:0, value:0}` is Valid |
| `init_values_equal_at_first_step` | Initial values are consistent |
| `backprop_preserves_ids` | Backprop does not change node IDs |

### Evolution Timescales — `Evolution/Timescales.lean` (6 theorems)

| Theorem | What it proves |
|---------|----------------|
| `turnCount_increases` | Turn count strictly increases with each assessTurn |
| `scaffoldVersion_nondecreasing` | Scaffold version never decreases |
| `memorySize_nondecreasing` | Memory only grows |
| `sessionCount_nondecreasing` | Session count never decreases |
| `nested_budget_bounded` | Total nested MCTS budget is positive |
| `deeper_costs_more` | Deeper nesting requires more total budget |

### CraftStore — `Evolution/CraftStore.lean` (2 theorems)

| Theorem | What it proves |
|---------|----------------|
| `consolidate_keeps_above` | After consolidation, remaining tools score ≥ threshold |
| `search_length_bound` | Search results length ≤ limit |

### Full Craft Lifecycle — `Evolution/FullCraftLifecycle.lean` (12 theorems)

End-to-end proofs for the complete tool lifecycle (extract → score → consolidate → retire):

| Theorem | What it proves |
|---------|----------------|
| `extract_increases` | Extraction adds to the store |
| `extract_contains` | Extracted tool is in the store |
| `update_preserves` | EMA update preserves store membership |
| `ema_bounded` | EMA score stays in [0, 1000] (integer model) |
| `consolidation_never_empties` | Consolidation never removes all tools (BUG-2 guard) |
| `consolidation_nonincreasing` | Consolidation never increases store size |
| `full_lifecycle_nonempty` | Full lifecycle preserves non-empty store |
| `ema_stays_bounded` | Bounded observation keeps score bounded |
| `pipeline_preserves_nonempty` | Full extract→update→consolidate pipeline preserves non-emptiness |

### Scaffold — `Evolution/Scaffold.lean` (2 theorems)

| Theorem | What it proves |
|---------|----------------|
| `rollback_nonexistent_is_none` | Rollback to missing version returns none |
| `append_increases_length` | Appending increases version count |

### Agent Lifecycle — `Agent/Lifecycle.lean` (7 theorems)

| Theorem | What it proves |
|---------|----------------|
| `reset_clears_counters` | Reset zeros step count and tool calls |
| `reset_preserves_turnCount` | Reset does not affect turn count |
| `step_increments` | Step count increases monotonically |
| `tool_increments` | Tool call count increases monotonically |
| `turn_increments` | Turn count increases on completion |
| `steps_bounded_by_calls` | Step count ≤ total operations |
| `maxSteps_invariant` | Step count never exceeds maxSteps |

### Fiber Durability — `Agent/FiberDurability.lean` (5 theorems)

| Theorem | What it proves |
|---------|----------------|
| `start_conserved` | Budget conservation holds at start |
| `step_preserves_conservation` | Each step maintains conservation |
| `step_decreases_remaining` | Each step decreases remaining budget |
| `checkpoint_restore_roundtrip` | Checkpoint + restore is identity |

### Turn Queue — `Agent/TurnQueue.lean` (6 theorems)

| Theorem | What it proves |
|---------|----------------|
| `enqueue_preserves_busy` | Enqueue does not change busy state |
| `start_requires_idle` | Processing can only start when idle |
| `start_makes_busy` | Starting processing sets busy flag |
| `complete_clears_busy` | Completing processing clears busy flag |
| `complete_increments` | Completed count increases |
| `enqueue_increases_total` | Total enqueued count increases |

### Storage — `Storage/FTS5Search.lean` (3 theorems + 2 axioms)

| Theorem/Axiom | What it proves |
|---------|----------------|
| `index_includes_new` | New chunks appear in the index |
| `index_preserves_other` | Indexing doesn't remove existing chunks |
| `search_bounded` | Search results ≤ limit parameter |
| `fts5_indexed_findable` (axiom) | FTS5 finds indexed content |
| `fts5_scores_nonneg` (axiom) | FTS5 scores are non-negative |

### Storage — `Storage/SqliteFSCorrectness.lean` (2 theorems + 2 axioms)

| Theorem/Axiom | What it proves |
|---------|----------------|
| `write_read_roundtrip` | Write then read returns the same data |
| `mkdir_idempotent` | Creating the same directory twice is idempotent |
| `chunk_reassembly` (axiom) | Chunked data reassembles correctly |
| `writes_commute` (axiom) | Non-overlapping writes commute |

### Execution — `Execution/Capabilities.lean` (10 theorems)

| Theorem | What it proves |
|---------|----------------|
| `container_subsumes_nimbus` | Container capabilities ⊇ Nimbus capabilities |
| `ssh_subsumes_container` | SSH capabilities ⊇ Container capabilities |
| `ssh_subsumes_nimbus` | SSH capabilities ⊇ Nimbus capabilities (transitivity) |
| `workspace_incomparable_nimbus` | Workspace is NOT subsumable by Nimbus (they have different capability profiles) |
| `chain` | Subsumption forms a chain: ssh ⊇ container ⊇ nimbus |
| `route_satisfies_all` | Router selects executor that satisfies all required capabilities |
| `route_available` | Router selects an available executor |
| `route_has_all_caps` | Selected executor has all required capabilities |
| `subsumes_refl` | Subsumption is reflexive |

### Execution — `Execution/ToolSystem.lean` (8 theorems)

Models the 5-tool architecture:

| Theorem | What it proves |
|---------|----------------|
| `action_routes_to_valid_tool` | Every agent action maps to one of the 5 tools |
| `only_mcts_uses_explore` | Only MCTS exploration uses the explore tool |
| `shell_uses_run` | Shell execution uses the run tool |
| `memory_search_uses_search` | Memory search uses the search_memory tool |
| `memory_save_uses_note` | Memory save uses the save_note tool |
| `file_ops_use_codemode` | File operations route through execute_tools |
| `empty_is_isolated` | Empty sandbox call list is isolated |

## Float Axioms

Lean 4 core lacks `LinearOrder Float`. We provide 16 IEEE 754 axioms in `Safety/FloatAxioms.lean` for the operating range of finite, non-NaN, non-Inf floats:

- Zero/identity (6): `float_mul_zero`, `float_zero_mul`, `float_add_zero`, `float_zero_add`, `float_div_one`, `float_zero_div`
- Cancellation (1): `float_div_mul_cancel` (exact for integer divisors)
- Ordering (4): `float_mul_nonneg`, `float_add_nonneg`, `float_mul_le_mul_of_nonneg_left`, `float_add_le_add`, `float_lt_iff_not_le`
- Square root (1): `float_sqrt_zero`
- Conversion (3): `float_ofNat_zero`, `float_ofNat_one`, `float_ofNat_ne_zero`

## TSLean Type Bridge

[TSLean](https://github.com/AshishKumar4/TSLean) compiles TypeScript interfaces to Lean 4 structures. Generated types live in `lean/generated/Proteus/`:

| TypeScript File | Generated Lean | Contents |
|-----------------|---------------|----------|
| `types/primitives.ts` | `Proteus/Types/Primitives.lean` | VFS, Memory, Executor, LLM, Schedule, Identity |
| `types/agent-runtime.ts` | `Proteus/Types/AgentRuntime.lean` | AgentRuntime, CraftStore, BranchHandle |
| `types/craft.ts` | `Proteus/Types/Craft.lean` | CraftedTool, CraftScoreEntry |
| `evolution/types.ts` | `Proteus/Evolution/Types.lean` | CompletedTurn, EvolutionConfig |
| `config.ts` | `Proteus/Config.lean` | AgentConfig, MCTSDefaults |

Regenerate with:
```bash
cd /workspace/TSLean
for f in primitives agent-runtime craft; do
  bun run src/cli.ts compile "../proteus/packages/core/src/types/${f}.ts" --namespace Proteus.Types
done
bun run src/cli.ts compile ../proteus/packages/core/src/evolution/types.ts --namespace Proteus.Evolution
bun run src/cli.ts compile ../proteus/packages/core/src/config.ts --namespace Proteus
```

## Legacy Specification (`formal-spec/`)

The `formal-spec/` directory contains the original Lean 4 specification (12 modules). It uses `lakefile.toml` and `leanprover/lean4:v4.29.0`. This version has `sorry` placeholders in several modules and is superseded by the `lean/` project. It is retained for reference.

/-
  Proteus.Types — Core domain types for the self-evolving agent.
  Self-contained: no external dependencies beyond Lean 4 core.
-/

namespace Proteus

/-! ## Node types for MCTS -/

inductive NodeStatus where
  | open_
  | terminal
  | pruned
  | failed
  deriving Repr, BEq, DecidableEq, Inhabited

structure NodeData where
  id       : String
  parentId : Option String
  depth    : Nat
  visits   : Nat
  value    : Float
  status   : NodeStatus
  action   : String
  deriving Repr, BEq, Inhabited

/-! ## Capability model -/

inductive Op where
  | ToolCall : String → String → Op
  | SQLWrite
  | SQLRead
  | NetworkFetch
  | ScaffoldWrite
  | SpawnSubAgent
  deriving Repr, BEq

structure ResolvedProvider where
  ns        : String
  toolNames : List String
  deriving Repr, BEq

def grantableOps (providers : List ResolvedProvider) : List Op :=
  providers.flatMap fun p => p.toolNames.map fun n => Op.ToolCall p.ns n

/-! ## CraftStore types -/

structure CraftedTool where
  name        : String
  description : String
  code        : String
  score       : Float
  uses        : Nat
  lastUsedAt  : Nat
  createdAt   : Nat
  deriving Repr, BEq, Inhabited

/-! ## Scaffold types -/

structure ScaffoldVersion where
  version : Nat
  code    : String
  deriving Repr, BEq, Inhabited

structure ScaffoldHistory where
  versions : List ScaffoldVersion
  deriving Repr, BEq, Inhabited

/-! ## MCTS system state -/

structure OrchestratorState where
  nodes     : List NodeData
  budget    : Nat
  storageId : String
  deriving Repr, BEq, Inhabited

structure BranchState where
  id        : String
  storageId : String
  score     : Option Float
  deriving Repr, BEq, Inhabited

structure MCTSSystemState where
  orch     : OrchestratorState
  branches : List BranchState
  deriving Repr, BEq, Inhabited

def StorageIsolated (s : MCTSSystemState) : Prop :=
  ∀ b ∈ s.branches, b.storageId ≠ s.orch.storageId

/-! ## Evolution types -/

structure EvolutionState where
  turnCount       : Nat
  sessionCount    : Nat
  craftToolCount  : Nat
  scaffoldVersion : Nat
  memorySize      : Nat
  reflectionCount : Nat
  deriving Repr, BEq, Inhabited

end Proteus

/-
  Kinu — Formal specification of the self-evolving agent architecture.

  29 modules across 8 categories, plus `Kinu.Axioms` and the one module it
  reaches on its own (Storage/DurableRoot.lean). 0 sorry. No Float axioms —
  the backprop model is exact scaled-integer arithmetic (see
  MCTS/Backpropagation.lean); the only remaining axiom is the FTS5 trusted
  assumption (Storage/FTS5Search.lean).

  Core: Types
  Safety: CapabilitySafety
  MCTS: StorageIsolation, Backpropagation
  Evolution: Timescales, CraftStore, Scaffold, FullCraftLifecycle
  Agent: Lifecycle, FiberDurability, TurnQueue
  Storage: FTS5Search, SqliteFSCorrectness, CostModel, SnapshotChain, OverlayCas
  Execution: Capabilities (subsumption chain + router correctness), ToolSystem (5-tool model)
  Exploration: Objective, Publication (S7/S6/S4/S1 as reachability over traces),
    Settle (settleOf's fibres), Archive (S5), Records (S2 scalar + the Pareto
    weakening), Arbitration (S8, with S3 as its consequence), Isolation (why the
    toolless proof does NOT reach an agent node), RecordsStore, ArchiveAdmission,
    FanIn, Rebase
-/

-- Core types
import Kinu.Types

-- Safety proofs
import Kinu.Safety.CapabilitySafety

-- MCTS proofs
import Kinu.MCTS.StorageIsolation
import Kinu.MCTS.Backpropagation

-- Evolution proofs
import Kinu.Evolution.Timescales
import Kinu.Evolution.CraftStore
import Kinu.Evolution.Scaffold
import Kinu.Evolution.FullCraftLifecycle

-- Agent lifecycle proofs
import Kinu.Agent.Lifecycle
import Kinu.Agent.FiberDurability
import Kinu.Agent.TurnQueue

-- Storage proofs
import Kinu.Storage.FTS5Search
import Kinu.Storage.SqliteFSCorrectness
import Kinu.Storage.CostModel
import Kinu.Storage.SnapshotChain
import Kinu.Storage.OverlayCas

-- Execution layer proofs (5-tool architecture + capability routing)
import Kinu.Execution.Capabilities
import Kinu.Execution.ToolSystem

-- Exploration proofs (docs/EXPLORATION.md — "The Lean invariants")
import Kinu.Exploration.Objective
import Kinu.Exploration.Publication
import Kinu.Exploration.Settle
import Kinu.Exploration.Archive
import Kinu.Exploration.Records
import Kinu.Exploration.Arbitration
import Kinu.Exploration.Isolation
import Kinu.Exploration.RecordsStore
import Kinu.Exploration.ArchiveAdmission
import Kinu.Exploration.FanIn
import Kinu.Exploration.Rebase

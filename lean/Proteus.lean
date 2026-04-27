/-
  Proteus — Formal specification of the self-evolving agent architecture.

  16 modules across 5 categories. 0 sorry.

  Core: Types, FloatAxioms
  Safety: CapabilitySafety
  MCTS: StorageIsolation, Backpropagation
  Evolution: Timescales, CraftStore, Scaffold, FullCraftLifecycle
  Agent: Lifecycle, FiberDurability, TurnQueue
  Storage: FTS5Search, SqliteFSCorrectness
  Execution: Capabilities (subsumption chain + router correctness), ToolSystem (5-tool model)
-/

-- Core types and axioms
import Proteus.Types
import Proteus.Safety.FloatAxioms

-- Safety proofs
import Proteus.Safety.CapabilitySafety

-- MCTS proofs
import Proteus.MCTS.StorageIsolation
import Proteus.MCTS.Backpropagation

-- Evolution proofs
import Proteus.Evolution.Timescales
import Proteus.Evolution.CraftStore
import Proteus.Evolution.Scaffold
import Proteus.Evolution.FullCraftLifecycle

-- Agent lifecycle proofs
import Proteus.Agent.Lifecycle
import Proteus.Agent.FiberDurability
import Proteus.Agent.TurnQueue

-- Storage proofs
import Proteus.Storage.FTS5Search
import Proteus.Storage.SqliteFSCorrectness

-- Execution layer proofs (5-tool architecture + capability routing)
import Proteus.Execution.Capabilities
import Proteus.Execution.ToolSystem

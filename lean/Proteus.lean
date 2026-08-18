/-
  Proteus — Formal specification of the self-evolving agent architecture.

  22 modules across 6 categories. 0 sorry. No Float axioms — the backprop
  model is exact scaled-integer arithmetic (see MCTS/Backpropagation.lean);
  the only remaining axiom is the FTS5 trusted assumption (Storage/FTS5Search.lean).

  Core: Types
  Safety: CapabilitySafety
  MCTS: StorageIsolation, Backpropagation
  Evolution: Timescales, CraftStore, Scaffold, FullCraftLifecycle
  Agent: Lifecycle, FiberDurability, TurnQueue
  Storage: FTS5Search, SqliteFSCorrectness
  Execution: Capabilities (subsumption chain + router correctness), ToolSystem (5-tool model)
  Exploration: Objective, Publication (S7/S6/S4/S1 as reachability over traces),
    Settle (settleOf's fibres), Archive (S5), Records (S2 scalar + the Pareto
    weakening), Arbitration (S8, with S3 as its consequence), Isolation (why the
    toolless proof does NOT reach an agent node)
-/

-- Core types
import Proteus.Types

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

-- Exploration proofs (docs/EXPLORATION-SPEC.md section 10)
import Proteus.Exploration.Objective
import Proteus.Exploration.Publication
import Proteus.Exploration.Settle
import Proteus.Exploration.Archive
import Proteus.Exploration.Records
import Proteus.Exploration.Arbitration
import Proteus.Exploration.Isolation

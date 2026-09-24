/-
  Kinu — formal models of the self-evolving agent architecture. 0 sorry. The
  one axiom is the trusted FTS5 assumption (Storage/FTS5Search.lean); no
  published theorem depends on it. `lean/traceability.yaml` is the inventory.

  Core: Types
  Safety: Credentials, DeviceView, DeviceToken
  MCTS: StorageIsolation, Backpropagation, Uct, Convergence
  Evolution: Timescales, CraftStore, Scaffold, FullCraftLifecycle
  Agent: Lifecycle, FiberDurability, TurnQueue
  Storage: FTS5Search, SqliteFSCorrectness, CostModel, SnapshotChain, BlockLayer, LossWindow
  Execution: Capabilities
  Exploration: Objective, Publication, Settle, Archive, Records, Arbitration,
    Isolation, RecordsStore, ArchiveAdmission, FanIn, Rebase, Concurrent,
    Counterfactual, Improvement
  Refine (a separate root): the generators of `lean/fixtures/`
-/

-- Core types
import Kinu.Types

-- Safety proofs
import Kinu.Safety.Credentials
import Kinu.Safety.DeviceView
import Kinu.Safety.DeviceToken

-- MCTS proofs
import Kinu.MCTS.StorageIsolation
import Kinu.MCTS.Backpropagation
import Kinu.MCTS.Uct
import Kinu.MCTS.Convergence

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
import Kinu.Storage.BlockLayer
import Kinu.Storage.LossWindow

-- Execution layer proofs (5-tool architecture + capability routing)
import Kinu.Execution.Capabilities

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
import Kinu.Exploration.Concurrent
import Kinu.Exploration.Counterfactual
import Kinu.Exploration.Improvement

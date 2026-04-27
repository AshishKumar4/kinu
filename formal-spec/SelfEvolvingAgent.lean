-- SelfEvolvingAgent: Formal specification of the self-evolving agent architecture
-- Built on TSLean's DO model and Veil transition system framework.
--
-- Architecture reference: formal-architecture-v4.md
-- TSLean Veil core: TSLean.Veil.Core (TransitionSystem typeclass, reachable, isInvariant)
-- TSLean DO model:  TSLean.DurableObjects.{Model, State, MultiDO, Transaction, RPC}
--
-- Bugs found by formal verification:
--   BUG-1: Backprop initial value (0.5 init inconsistent with running mean formula)
--   BUG-2: CraftStore consolidation needs non-empty remainder guard
--   BUG-3: Scaffold staged-rollout has no proof that canary failure = safety rejection
--   BUG-4: MCTS convergence threshold is never checked against initial value
--
-- v4.0 additions:
--   - FloatAxioms.lean: 17 IEEE 754 axioms for discharging Float sorries
--   - Evolution.lean: 3-timescale evolution model with monotonicity proofs
--   - DistributedModel.lean: Strengthened mctsTransition — all 7 cases proven
--   - TSLean-generated types in lean/generated/Proteus/ (type bridge)

import SelfEvolvingAgent.Types
import SelfEvolvingAgent.Primitives
import SelfEvolvingAgent.MCTSTree
import SelfEvolvingAgent.UCT
import SelfEvolvingAgent.Backpropagation
import SelfEvolvingAgent.CapabilitySafety
import SelfEvolvingAgent.ScaffoldSafety
import SelfEvolvingAgent.CraftStore
import SelfEvolvingAgent.DistributedModel
import SelfEvolvingAgent.Convergence
import SelfEvolvingAgent.FloatAxioms
import SelfEvolvingAgent.Evolution

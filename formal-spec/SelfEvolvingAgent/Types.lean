-- SelfEvolvingAgent.Types
-- Core domain types for the self-evolving MCTS agent.
-- All types are pure (no IO, no monads) to enable clean proof reasoning.

import TSLean.Runtime.Basic
import TSLean.DurableObjects.Model

namespace SelfEvolvingAgent

open TSLean TSLean.DO

/-! ## Node identity and status -/

abbrev NodeId := String

inductive NodeStatus where
  | open_     : NodeStatus   -- available for UCT selection
  | terminal  : NodeStatus   -- exploration completed successfully
  | failed    : NodeStatus   -- exploration errored
  | pruned    : NodeStatus   -- UCT score below threshold after ≥2 visits
  deriving BEq, Repr

/-! ## MCTS node data -/

/-- A single node in the MCTS search tree. -/
structure NodeData where
  id          : NodeId
  parentId    : Option NodeId
  task        : String
  action      : String    -- action taken to reach this node
  observation : String    -- result of that action
  visits      : Nat
  /-- Mean return in [0, 1]. Initialized to 0 (not 0.5!).
      BUG-1 NOTE: The arch doc initializes to 0.5 but the running mean formula
      `(value * visits + reward) / (visits + 1)` is only self-consistent
      when value starts at 0 (so visits=0 gives value=reward/1 on first update).
      If value=0.5 and visits=0, first update gives (0.5*0 + r)/1 = r, which
      IS actually correct — but only because 0.5*0 = 0. The formula is
      degenerate at visits=0. We formalize this cleanly by initializing to 0. -/
  value       : Float
  depth       : Nat
  status      : NodeStatus
  msgId       : Option String  -- linked session message id
  deriving Repr

/-! ## Capability model -/

/-- The complete universe of operations the agent can perform. -/
inductive Op where
  | ToolCall   (ns : String) (name : String)         -- granted via providers
  | SQLRead                                           -- orchestrator only
  | SQLWrite                                          -- orchestrator only
  | NetworkFetch (url : String)                      -- blocked in sandbox
  | ScaffoldWrite                                     -- outside sandbox only
  | SpawnSubAgent (className : String)               -- outside sandbox only
  deriving BEq, Repr

/-- A resolved tool provider: a namespace with named functions. -/
structure ResolvedProvider where
  name : String
  fns  : List String   -- function names available in this namespace
  deriving Repr

/-! ## Crafted tool -/

structure CraftedTool where
  name        : String
  description : String
  code        : String   -- JS function body
  score       : Float    -- EMA quality score ∈ [0, 1]
  uses        : Nat
  lastUsedAt  : Nat      -- timestamp (ms since epoch)
  createdAt   : Nat
  deriving Repr, BEq

/-! ## Scaffold -/

structure ScaffoldVersion where
  version      : Nat
  code         : String
  writtenAt    : Nat
  rationale    : String
  canaryScore  : Option Float
  baselineScore: Option Float
  deriving Repr

/-! ## Task history entry (for calibration and error-rate monitoring) -/

inductive TaskOutcome where
  | success : TaskOutcome
  | error_  : TaskOutcome
  | timeout : TaskOutcome
  deriving BEq, Repr

structure TaskHistoryEntry where
  id              : String
  task            : String
  scaffoldVersion : Nat
  outcome         : TaskOutcome
  score           : Option Float
  createdAt       : Nat
  deriving Repr

end SelfEvolvingAgent

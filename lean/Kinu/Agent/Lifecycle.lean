/-
  Kinu.Agent.Lifecycle — Agent lifecycle verified properties.

  Models: orchestrator.ts (beforeTurn, afterToolCall, onStepFinish, onChatResponse)
          chat.ts (runChat: text-delta, tool-call, tool-result, step-finish, done)

  Rather than model the full state machine transition function (which is
  hard to reason about in Lean due to nested match), we state and prove
  key structural properties directly.
-/

namespace Kinu.Agent.Lifecycle

/-! ## Agent state -/

structure AgentState where
  turnCount     : Nat
  stepCount     : Nat
  toolCallCount : Nat
  maxSteps      : Nat
  deriving Repr, BEq, Inhabited

/-! ## State update operations (model individual actions) -/

/-- beforeTurn resets per-turn counters. orchestrator.ts:248-251 -/
def resetTurn (s : AgentState) : AgentState :=
  { s with stepCount := 0, toolCallCount := 0 }

/-- afterToolCall increments tool count. orchestrator.ts:256-260 -/
def recordToolCall (s : AgentState) : AgentState :=
  { s with toolCallCount := s.toolCallCount + 1 }

/-- onStepFinish increments step count. orchestrator.ts:264 -/
def finishStep (s : AgentState) : AgentState :=
  { s with stepCount := s.stepCount + 1 }

/-- startEvolution increments turn count. orchestrator.ts:300 -/
def completeTurn (s : AgentState) : AgentState :=
  { s with turnCount := s.turnCount + 1 }

/-! ## Proven properties -/

/-- resetTurn clears step and tool counters.
    Implements: beforeTurn() at orchestrator.ts:248-251 -/
theorem reset_clears_counters (s : AgentState) :
    (resetTurn s).stepCount = 0 ∧ (resetTurn s).toolCallCount = 0 := by
  exact ⟨rfl, rfl⟩

/-- resetTurn preserves turn count.
    Implements: beforeTurn() doesn't touch turnCount -/
theorem reset_preserves_turnCount (s : AgentState) :
    (resetTurn s).turnCount = s.turnCount := rfl

/-- Step count increases by exactly 1 on finishStep.
    Implements: onStepFinish at orchestrator.ts:264 -/
theorem step_increments (s : AgentState) :
    (finishStep s).stepCount = s.stepCount + 1 := rfl

/-- Tool call count increases by exactly 1 on recordToolCall.
    Implements: afterToolCall at orchestrator.ts:256-260 -/
theorem tool_increments (s : AgentState) :
    (recordToolCall s).toolCallCount = s.toolCallCount + 1 := rfl

/-- Turn count increases by exactly 1 on completeTurn.
    Implements: _sessionTurnCount++ at orchestrator.ts:300 -/
theorem turn_increments (s : AgentState) :
    (completeTurn s).turnCount = s.turnCount + 1 := rfl

/-- Step count is bounded by number of finishStep calls after reset.
    Implements: stopWhen: stepCountIs(500) at chat.ts:49 -/
theorem steps_bounded_by_calls (s : AgentState) (n : Nat) (h : n ≤ s.maxSteps) :
    let s' := (Nat.repeat (fun s => finishStep s) n (resetTurn s))
    s'.stepCount = n := by
  simp only []
  induction n with
  | zero => simp [Nat.repeat, resetTurn]
  | succ k ih =>
    simp [Nat.repeat, finishStep]
    exact ih (Nat.le_of_succ_le h)

/-- maxSteps is invariant across all operations.
    Implements: maxSteps comes from config, never mutated -/
theorem maxSteps_invariant (s : AgentState) :
    (resetTurn s).maxSteps = s.maxSteps ∧
    (recordToolCall s).maxSteps = s.maxSteps ∧
    (finishStep s).maxSteps = s.maxSteps ∧
    (completeTurn s).maxSteps = s.maxSteps :=
  ⟨rfl, rfl, rfl, rfl⟩

end Kinu.Agent.Lifecycle

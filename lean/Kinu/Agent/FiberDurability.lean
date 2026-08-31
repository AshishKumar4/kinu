/-
  Kinu.Agent.FiberDurability — Durable fiber checkpoint/resume correctness.

  Models: packages/core/src/mcts/engine.ts (fiber with stash/snapshot)
  CF SDK: Agent.runFiber with FiberContext.stash

  Properties proven algebraically rather than via transition function.
-/

namespace Kinu.Agent.FiberDurability

/-! ## Fiber budget tracking -/

structure FiberBudget where
  initial   : Nat
  remaining : Nat
  iteration : Nat
  deriving Repr, BEq, Inhabited

def FiberBudget.start (budget : Nat) : FiberBudget :=
  { initial := budget, remaining := budget, iteration := 0 }

def FiberBudget.step (b : FiberBudget) : FiberBudget :=
  { b with remaining := b.remaining - 1, iteration := b.iteration + 1 }

/-- The budget conservation invariant.
    Implements: phase.budget-- and phase.iteration++ at engine.ts:162-163 -/
def FiberBudget.conserved (b : FiberBudget) : Prop :=
  b.remaining + b.iteration = b.initial

/-! ## Proven properties -/

/-- Initial budget is conserved. -/
theorem start_conserved (n : Nat) : (FiberBudget.start n).conserved := by
  simp [FiberBudget.start, FiberBudget.conserved]

/-- Step preserves conservation when budget > 0.
    Implements: while (phase.budget > 0) loop at engine.ts:72, 162-163 -/
theorem step_preserves_conservation (b : FiberBudget)
    (hcons : b.conserved) (hpos : b.remaining > 0) :
    b.step.conserved := by
  simp [FiberBudget.step, FiberBudget.conserved] at *
  omega

/-- Step strictly decreases remaining budget.
    Implements: phase.budget-- at engine.ts:163
    Ensures: MCTS loop terminates (budget is well-founded measure) -/
theorem step_decreases_remaining (b : FiberBudget) (hpos : b.remaining > 0) :
    b.step.remaining < b.remaining := by
  simp [FiberBudget.step]; omega

/-- After n steps from initial budget, remaining = initial - n.
    Implements: the full MCTS loop at engine.ts:72-170 -/
theorem n_steps_remaining (budget n : Nat) (h : n ≤ budget) :
    (Nat.repeat FiberBudget.step n (FiberBudget.start budget)).remaining = budget - n := by
  induction n with
  | zero => simp [Nat.repeat, FiberBudget.start]
  | succ k ih =>
    simp [Nat.repeat, FiberBudget.step]
    have hk : k ≤ budget := Nat.le_of_succ_le h
    rw [ih hk]; omega

/-! ## Checkpoint/recovery model -/

structure Checkpoint where
  budget    : Nat
  iteration : Nat
  deriving Repr, BEq, Inhabited

/-- A checkpoint captures the current budget state.
    Implements: ctx.stash(phase) at engine.ts:164 -/
def checkpoint (b : FiberBudget) : Checkpoint :=
  { budget := b.remaining, iteration := b.iteration }

/-- Restoring from a checkpoint produces a valid budget.
    Implements: onFiberRecovered at orchestrator.ts:328-332 -/
def restore (c : Checkpoint) (initial : Nat) : FiberBudget :=
  { initial, remaining := c.budget, iteration := c.iteration }

/-- Checkpoint then restore preserves remaining and iteration.
    This is the fundamental fiber durability guarantee. -/
theorem checkpoint_restore_roundtrip (b : FiberBudget) :
    let c := checkpoint b
    let b' := restore c b.initial
    b'.remaining = b.remaining ∧ b'.iteration = b.iteration := by
  simp [checkpoint, restore]

end Kinu.Agent.FiberDurability

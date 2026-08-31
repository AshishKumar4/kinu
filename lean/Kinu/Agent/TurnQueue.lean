/-
  Kinu.Agent.TurnQueue — Chat turn serialization.
  Models: packages/agents/src/chat/turn-queue.ts
-/

namespace Kinu.Agent.TurnQueue

structure QueueState where
  busy      : Bool
  pending   : Nat
  completed : Nat
  deriving Repr, BEq, Inhabited

def enqueue (s : QueueState) : QueueState :=
  { s with pending := s.pending + 1 }

def startProcessing (s : QueueState) : Option QueueState :=
  if _h : !s.busy && s.pending > 0 then
    some { busy := true, pending := s.pending - 1, completed := s.completed }
  else none

def completeProcessing (s : QueueState) : Option QueueState :=
  if s.busy then
    some { busy := false, pending := s.pending, completed := s.completed + 1 }
  else none

theorem enqueue_preserves_busy (s : QueueState) :
    (enqueue s).busy = s.busy := rfl

theorem start_requires_idle (s s' : QueueState)
    (h : startProcessing s = some s') : s.busy = false := by
  unfold startProcessing at h
  split at h
  · rename_i hc; simp [Bool.not_eq_true'] at hc; exact hc.1
  · simp at h

theorem start_makes_busy (s s' : QueueState)
    (h : startProcessing s = some s') : s'.busy = true := by
  unfold startProcessing at h
  split at h
  · injection h with h; rw [← h]
  · simp at h

theorem complete_clears_busy (s s' : QueueState)
    (h : completeProcessing s = some s') : s'.busy = false := by
  unfold completeProcessing at h
  split at h
  · injection h with h; rw [← h]
  · simp at h

theorem complete_increments (s s' : QueueState)
    (h : completeProcessing s = some s') :
    s'.completed = s.completed + 1 := by
  unfold completeProcessing at h
  split at h
  · injection h with h; rw [← h]
  · simp at h

theorem enqueue_increases_total (s : QueueState) :
    (enqueue s).pending + (enqueue s).completed = s.pending + s.completed + 1 := by
  simp [enqueue]; omega

end Kinu.Agent.TurnQueue

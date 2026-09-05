/-!
# The published head survives stop and wake across generations

A model of the candidate control plane in
`packages/devbox/src/candidates/control.ts`, which `bounded-layers` and
`merkle-pack` share. The durable record holds one head pointer and at most
one operation. `sealedCas` is the one write that moves the head. A stop and a
wake touch the container and never the record. A wake reads the head and
serves the envelope it names (`candidateRunControl`).

The model keeps the transitions the record admits and the guards it applies.
A refused transition leaves the record as it was, because the store update
throws before it writes.

The theorems at the end state the invariant the decision relies on.
`wake_serves_newest_publication` says that after any run, a wake serves the
newest published root, whatever stops and wakes the run interleaved between
generations. `stale_parent_keeps_head` says a sealed result whose expected
parent is no longer the head never moves it, which is the racing-containers
rule of cells 6.10 and 6.17.
-/

namespace Devbox

/-- A root envelope id: the digest of canonical envelope bytes. -/
abbrev RootId := String

/-- The phases `OperationRecordSchema` declares. `intent` is absent because
`beginCandidateOperation` writes `transferring` directly. -/
inductive Phase where
  | transferring
  | sealed (result : RootId)
  | completionPending (result : RootId)
  | published (result : RootId)
  | failed
  deriving DecidableEq, Repr

structure Operation where
  expectedParent : Option RootId
  phase : Phase
  deriving DecidableEq, Repr

/-- `CandidateControlStateV1`: the durable record. -/
structure Control where
  head : Option RootId
  operation : Option Operation
  deriving DecidableEq, Repr

inductive Container where
  | running
  | stopped
  deriving DecidableEq, Repr

/-- One box: the durable record, the container, what the last attach served,
and every publication newest first with the parent each one named. -/
structure Box where
  control : Control
  container : Container
  restored : Option RootId
  log : List (RootId × Option RootId)
  deriving Repr

/-- Every transition the record and the container admit. -/
inductive Step where
  | start
  | sealPayload (result : RootId)
  | cas
  | complete
  | abandon
  | stop
  | wake
  deriving DecidableEq, Repr

/-- `freshOperation` refuses while an operation is transferring, sealed or
completion-pending. -/
def Control.idle (c : Control) : Bool :=
  match c.operation with
  | none => true
  | some op =>
    match op.phase with
    | .published _ => true
    | .failed => true
    | _ => false

/-- Advance the record after a sealed operation, exactly as `sealedCas` does:
the head moves only when the expected parent is still the head. A stale
parent fails the operation and leaves the head alone. -/
def casStep (b : Box) (op : Operation) (r : RootId) : Box :=
  if b.control.head = op.expectedParent then
    { b with
      control := { head := some r, operation := some { op with phase := .completionPending r } }
      log := (r, op.expectedParent) :: b.log }
  else
    { b with control := { b.control with operation := some { op with phase := .failed } } }

def step (b : Box) : Step → Box
  | .start =>
    if b.container = .running ∧ b.control.idle = true then
      { b with control := { head := b.control.head,
                            operation := some { expectedParent := b.control.head, phase := .transferring } } }
    else b
  | .sealPayload r =>
    match b.container, b.control.operation with
    | .running, some op =>
      match op.phase with
      | .transferring => { b with control := { b.control with operation := some { op with phase := .sealed r } } }
      | _ => b
    | _, _ => b
  | .cas =>
    match b.control.operation with
    | some op =>
      match op.phase with
      | .sealed r => casStep b op r
      | _ => b
    | none => b
  | .complete =>
    match b.control.operation with
    | some op =>
      match op.phase with
      | .completionPending r =>
        if b.control.head = some r then
          { b with control := { b.control with operation := some { op with phase := .published r } } }
        else b
      | _ => b
    | none => b
  | .abandon =>
    match b.control.operation with
    | some op =>
      match op.phase with
      | .transferring => { b with control := { b.control with operation := some { op with phase := .failed } } }
      | _ => b
    | none => b
  | .stop => { b with container := .stopped }
  | .wake => { b with container := .running, restored := b.control.head }

def run (b : Box) (steps : List Step) : Box := steps.foldl step b

def Box.initial : Box :=
  { control := { head := none, operation := none }, container := .running, restored := none, log := [] }

/-- The newest publication, or none before the first one. -/
def newest (log : List (RootId × Option RootId)) : Option RootId :=
  match log with
  | [] => none
  | (r, _) :: _ => some r

/-- Every publication names the head it replaced as its parent. -/
def Chain : List (RootId × Option RootId) → Prop
  | [] => True
  | [(_, p)] => p = none
  | (_, p) :: (r', p') :: rest => p = some r' ∧ Chain ((r', p') :: rest)

/-- The invariant every step preserves: the head is the newest publication,
and the publications form one parent chain. -/
def Inv (b : Box) : Prop := b.control.head = newest b.log ∧ Chain b.log

theorem initial_inv : Inv Box.initial := by
  exact ⟨rfl, trivial⟩

theorem stop_control (b : Box) : (step b .stop).control = b.control := rfl

theorem wake_control (b : Box) : (step b .wake).control = b.control := rfl

theorem wake_serves_head (b : Box) : (step b .wake).restored = b.control.head := rfl

theorem stop_log (b : Box) : (step b .stop).log = b.log := rfl

theorem wake_log (b : Box) : (step b .wake).log = b.log := rfl

/-- A sealed result whose expected parent is no longer the head never moves
the head. This is the rule that keeps two racing containers on one head. -/
theorem stale_parent_keeps_head (b : Box) (op : Operation) (r : RootId)
    (stale : b.control.head ≠ op.expectedParent) :
    (casStep b op r).control.head = b.control.head := by
  unfold casStep
  simp [stale]

/-- The head CAS preserves the invariant: it appends the new root with the
head it replaced as parent. -/
theorem casStep_inv (b : Box) (op : Operation) (r : RootId) (h : Inv b) :
    Inv (casStep b op r) := by
  unfold casStep
  by_cases parent : b.control.head = op.expectedParent
  · simp only [parent, if_true]
    obtain ⟨hhead, hchain⟩ := h
    constructor
    · rfl
    · cases hlog : b.log with
      | nil =>
        simp only [hlog, newest] at hhead
        show op.expectedParent = none
        rw [← parent, hhead]
      | cons entry rest =>
        obtain ⟨r', p'⟩ := entry
        simp only [hlog, newest] at hhead
        rw [hlog] at hchain
        show op.expectedParent = some r' ∧ Chain ((r', p') :: rest)
        exact ⟨by rw [← parent, hhead], hchain⟩
  · simp only [parent, if_false]
    exact h

theorem step_inv (b : Box) (s : Step) (h : Inv b) : Inv (step b s) := by
  cases s with
  | start =>
    dsimp only [step]
    split
    · exact h
    · exact h
  | sealPayload r =>
    dsimp only [step]
    split
    · split
      · exact h
      · exact h
    · exact h
  | cas =>
    dsimp only [step]
    split
    · split
      · exact casStep_inv _ _ _ h
      · exact h
    · exact h
  | complete =>
    dsimp only [step]
    split
    · split
      · split
        · exact h
        · exact h
      · exact h
    · exact h
  | abandon =>
    dsimp only [step]
    split
    · split
      · exact h
      · exact h
    · exact h
  | stop => exact h
  | wake => exact h

theorem run_inv (b : Box) (steps : List Step) (h : Inv b) : Inv (run b steps) := by
  induction steps generalizing b with
  | nil => exact h
  | cons s rest ih => exact ih (step b s) (step_inv b s h)

theorem run_append (b : Box) (xs ys : List Step) : run b (xs ++ ys) = run (run b xs) ys := by
  unfold run
  exact List.foldl_append

/-- After any run from a fresh box that ends in a wake, the attach serves the
newest published root, whatever stops and wakes the run interleaved between
generations. -/
theorem wake_serves_newest_publication (steps : List Step) :
    (run Box.initial (steps ++ [.wake])).restored = newest (run Box.initial (steps ++ [.wake])).log := by
  rw [run_append]
  have h := run_inv Box.initial steps initial_inv
  show (step (run Box.initial steps) .wake).restored = newest (step (run Box.initial steps) .wake).log
  rw [wake_serves_head, wake_log]
  exact h.1

/-- A stop followed by a wake changes neither the record nor the publications,
so the generations published before the stop are the generations after the
wake. -/
theorem stop_wake_preserves_record (b : Box) :
    (run b [.stop, .wake]).control = b.control ∧ (run b [.stop, .wake]).log = b.log := by
  exact ⟨rfl, rfl⟩

end Devbox

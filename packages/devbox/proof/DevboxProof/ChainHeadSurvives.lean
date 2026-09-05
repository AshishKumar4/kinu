/-!
# The chain record survives stop and wake across generations

A model of the snapshot-chain record in `packages/devbox/src/snapshot-chain.ts`.
The Durable Object holds one `ChainState` row with a revision. Every write
goes through `writeState(next, expectedRev)`, which the port refuses with
`ChainRecordAdvanced` when the stored revision moved. A stop and a wake touch
the container and never the row. A wake reads the row and mounts the
generation it names (`attachChainOnce`).

`stale_writer_keeps_record` is the one-writer rule: a checkpoint that read an
older revision cannot move the record. `wake_serves_published_generation`
says a wake after any run serves the generation the newest write published.
-/

namespace Devbox.Chain

/-- A generation id: the base layer's UUID, the prefix every key of the
generation is built from. -/
abbrev ChainId := String

/-- The row a checkpoint writes: which generation it names, whether a delta
was published beside the base, and the revision the write took. -/
structure Record where
  base : ChainId
  delta : Bool
  rev : Nat
  deriving DecidableEq, Repr

inductive Container where
  | running
  | stopped
  deriving DecidableEq, Repr

/-- One box: the durable row, the container, what the last attach served,
and every write newest first. -/
structure Box where
  record : Option Record
  container : Container
  restored : Option Record
  log : List Record
  deriving Repr

/-- The transitions the row and the container admit. `commit` carries the
revision the writer read before it staged, exactly as `writeState` receives
it. -/
inductive Step where
  | commit (expected : Option Nat) (base : ChainId) (delta : Bool)
  | stop
  | wake
  deriving DecidableEq, Repr

/-- `writeState(next, expectedRev)`: the row moves only when the stored
revision is the one the writer read. -/
def nextRecord (b : Box) (base : ChainId) (delta : Bool) : Record :=
  { base := base, delta := delta, rev := (b.record.map Record.rev).getD 0 + 1 }

def commitStep (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool) : Box :=
  if b.container = .running ∧ b.record.map Record.rev = expected then
    { b with record := some (nextRecord b base delta), log := nextRecord b base delta :: b.log }
  else b

def step (b : Box) : Step → Box
  | .commit expected base delta => commitStep b expected base delta
  | .stop => { b with container := .stopped }
  | .wake => { b with container := .running, restored := b.record }

def run (b : Box) (steps : List Step) : Box := steps.foldl step b

def Box.initial : Box := { record := none, container := .running, restored := none, log := [] }

def newest (log : List Record) : Option Record :=
  match log with
  | [] => none
  | r :: _ => some r

/-- The row is the newest write. -/
def Inv (b : Box) : Prop := b.record = newest b.log

theorem initial_inv : Inv Box.initial := rfl

theorem stop_record (b : Box) : (step b .stop).record = b.record := rfl

theorem wake_record (b : Box) : (step b .wake).record = b.record := rfl

theorem wake_serves_record (b : Box) : (step b .wake).restored = b.record := rfl

theorem wake_log (b : Box) : (step b .wake).log = b.log := rfl

/-- A writer that read a revision the row has left behind cannot move it. -/
theorem stale_writer_keeps_record (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool)
    (stale : b.record.map Record.rev ≠ expected) :
    (commitStep b expected base delta).record = b.record := by
  unfold commitStep
  simp [stale]

theorem commitStep_inv (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool) (h : Inv b) :
    Inv (commitStep b expected base delta) := by
  unfold commitStep
  split
  · rfl
  · exact h

theorem step_inv (b : Box) (s : Step) (h : Inv b) : Inv (step b s) := by
  cases s with
  | commit expected base delta => exact commitStep_inv b expected base delta h
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
generation the newest write published, whatever stops and wakes the run
interleaved between generations. -/
theorem wake_serves_published_generation (steps : List Step) :
    (run Box.initial (steps ++ [.wake])).restored = newest (run Box.initial (steps ++ [.wake])).log := by
  rw [run_append]
  have h := run_inv Box.initial steps initial_inv
  show (step (run Box.initial steps) .wake).restored = newest (step (run Box.initial steps) .wake).log
  rw [wake_serves_record, wake_log]
  exact h

theorem stop_wake_preserves_record (b : Box) :
    (run b [.stop, .wake]).record = b.record ∧ (run b [.stop, .wake]).log = b.log := by
  constructor <;> rfl

end Devbox.Chain

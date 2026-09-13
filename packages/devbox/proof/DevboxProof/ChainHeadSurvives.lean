/-
# Published chain revisions survive the start gate

Source: packages/devbox/src/snapshot-chain.ts#SnapshotChainPorts.writeState,
#snapshotChainStorage (commitChain and attachChainOnce); devbox.ts#Devbox.onStart.
The lifecycle is StartGate, not an instantaneous wake that cannot fail.
Only an admitted generation without an in-flight hook may checkpoint.
Successful attach reads the published record; stopped/unsettled requests
do not restore. Stop loses container disk, isolate reset does not.

A successful wake below expands to provision, port-proven hook, attachment,
durable settlement, and admission publication. Failed/interrupted wakes take
the separately modelled recovery branch and make no promise to serve data.
The record abstracts base identity, delta presence and revision, not payload
integrity, fallback selection, or adoptable delta objects after a failed CAS.
Those are storage-level obligations, not proved by this control-plane model.
-/

import DevboxProof.HeadSurvives

namespace Devbox.Chain

abbrev ChainId := String

structure Record where
  base : ChainId
  delta : Bool
  rev : Nat
  deriving DecidableEq, Repr

structure Box where
  record : Option Record
  gate : StartGate.State
  restored : Option Record
  log : List Record
  deriving Repr

inductive Step where
  | commit (expected : Option Nat) (base : ChainId) (delta : Bool)
  | lifecycle (action : StartGate.Action)
  deriving DecidableEq, Repr

def nextRecord (b : Box) (base : ChainId) (delta : Bool) : Record :=
  { base := base, delta := delta, rev := (b.record.map Record.rev).getD 0 + 1 }

def commitStep (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool) : Box :=
  if StartGate.admits b.gate.memoryPhase = true ∧ b.gate.flight = none ∧
      b.record.map Record.rev = expected then
    { b with record := some (nextRecord b base delta), log := nextRecord b base delta :: b.log }
  else b

/-- Only a successful hook attach reads the record. Stop destroys the local
    restored view; reset and adoption leave it intact. -/
def lifecycleStep (b : Box) (a : StartGate.Action) : Box :=
  let gate := StartGate.step b.gate a
  { b with gate := gate, restored :=
      match a with
      | .stop => none
      | .executeRecovery => if b.gate.recoveryPending then none else b.restored
      | .attach _ => if b.gate.attaches < gate.attaches then b.record else b.restored
      | _ => b.restored }

def step (b : Box) : Step → Box
  | .commit expected base delta => commitStep b expected base delta
  | .lifecycle action => lifecycleStep b action

def run (b : Box) (steps : List Step) : Box := steps.foldl step b

def Box.initial : Box :=
  { record := none, gate := StartGate.initial, restored := none, log := [] }

def newest (log : List Record) : Option Record := log.head?

def Inv (b : Box) : Prop := b.record = newest b.log

theorem initial_inv : Inv Box.initial := rfl

theorem lifecycle_preserves_record (b : Box) (a : StartGate.Action) :
    (lifecycleStep b a).record = b.record := rfl

theorem lifecycle_preserves_log (b : Box) (a : StartGate.Action) :
    (lifecycleStep b a).log = b.log := rfl

theorem stop_discards_restored_disk (b : Box) :
    (lifecycleStep b .stop).restored = none := rfl

theorem reset_retains_restored_disk (b : Box) :
    (lifecycleStep b .reset).restored = b.restored := rfl

theorem stale_writer_keeps_record (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool)
    (stale : b.record.map Record.rev ≠ expected) :
    (commitStep b expected base delta).record = b.record := by
  simp [commitStep, stale]

theorem unsettled_generation_cannot_checkpoint (b : Box) (expected : Option Nat)
    (base : ChainId) (delta : Bool) (h : StartGate.admits b.gate.memoryPhase = false) :
    commitStep b expected base delta = b := by simp [commitStep, h]

theorem in_hook_checkpoint_is_refused (b : Box) (expected : Option Nat)
    (base : ChainId) (delta : Bool) (h : b.gate.flight ≠ none) :
    commitStep b expected base delta = b := by simp [commitStep, h]

theorem commitStep_inv (b : Box) (expected : Option Nat) (base : ChainId) (delta : Bool) (h : Inv b) :
    Inv (commitStep b expected base delta) := by
  unfold commitStep
  split
  · rfl
  · exact h

theorem step_inv (b : Box) (s : Step) (h : Inv b) : Inv (step b s) := by
  cases s with
  | commit expected base delta => exact commitStep_inv b expected base delta h
  | lifecycle a => exact h

theorem run_inv (b : Box) (steps : List Step) (h : Inv b) : Inv (run b steps) := by
  induction steps generalizing b with
  | nil => exact h
  | cons s rest ih => exact ih (step b s) (step_inv b s h)

theorem run_append (b : Box) (xs ys : List Step) : run b (xs ++ ys) = run (run b xs) ys := by
  unfold run
  exact List.foldl_append

theorem successful_hook_attach_serves_record (b : Box) (g : Nat)
    (h : b.gate.attaches < (StartGate.attach b.gate g).attaches) :
    (lifecycleStep b (.attach g)).restored = b.record := by
  simp [lifecycleStep, StartGate.step, h]

theorem request_adopts_without_restoring (b : Box) :
    (lifecycleStep b .request).restored = b.restored := rfl

theorem heartbeat_adopts_without_restoring (b : Box) :
    (lifecycleStep b .heartbeat).restored = b.restored := rfl

/-- A normal stopped boot with no interrupted durable claim: this macro
    contains all successful hook stages. Recovery is not bypassed by an
    unconditional 'wake serves' transition. -/
def successfulWake (b : Box) (boot : Nat) : Box :=
  let stopped := lifecycleStep b .stop
  let started := lifecycleStep stopped (.provision boot)
  let claimed := lifecycleStep started (.onStart true)
  let attached := lifecycleStep claimed (.attach started.gate.generation)
  let written := lifecycleStep attached (.writeSettlement started.gate.generation .attached)
  lifecycleStep written (.publishSettlement started.gate.generation)

theorem successful_wake_preserves_record_and_log (b : Box) (boot : Nat) :
    (successfulWake b boot).record = b.record ∧
      (successfulWake b boot).log = b.log := ⟨rfl, rfl⟩

/-- The fresh boot id differs from the old stamp. An equal id is adoption,
    not a fresh container, so it is deliberately not passed as a wake witness. -/
theorem successful_wake_serves_record (b : Box) (boot : Nat)
    (fresh : b.gate.durableBoot ≠ some boot)
    (settled : b.gate.durablePhase ≠ .restoring)
    (recovered : b.gate.recoveryPending = false) :
    (successfulWake b boot).restored = b.record := by
  simp [successfulWake, lifecycleStep, StartGate.step, StartGate.reset, StartGate.onStart,
    StartGate.attach, StartGate.writeSettlement, StartGate.publishSettlement,
    StartGate.owns, StartGate.canAdopt, fresh, settled, recovered]

theorem settled_wake_serves_published_generation (steps : List Step) (boot : Nat)
    (fresh : (run Box.initial steps).gate.durableBoot ≠ some boot)
    (settled : (run Box.initial steps).gate.durablePhase ≠ .restoring)
    (recovered : (run Box.initial steps).gate.recoveryPending = false) :
    (successfulWake (run Box.initial steps) boot).restored =
      newest (successfulWake (run Box.initial steps) boot).log := by
  rw [successful_wake_serves_record _ _ fresh settled recovered]
  exact run_inv Box.initial steps initial_inv

end Devbox.Chain

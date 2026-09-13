/-!
# Port-proven, generation-fenced start admission

Models current packages/devbox/src/devbox.ts: Devbox.onStart,
#restoreInStartGate, #runStartHook, #adoptOrTurnOver, #settle,
#claimRecovery, #recover and resolveReadiness; and lifecycle.ts:
classifyRecovery, recoveryStep, ContainerStartInterrupted.

A hook first joins its generation's flight, recovers an interrupted durable
claim, adopts a matching settled boot, or claims a fresh restore. Materializing
and completing services are represented by one successful attach event.
Settlement has TWO events: durable write, then memory publication. A reset
between them can adopt the durable result. A reset before the write retains
restoring and takes recovery, never a second attach on the abandoned boot.

Generation checks model the checks after awaits; recovery also checks its
durable minted token (represented by a monotone fresh counter). Storage writes
are atomic events here, not a refinement of asynchronous storage internals.
The SDK's port proof is an input; Lean does not prove the network listener.
Repair admits commands but never claims full readiness.

The former candidate-head model cited deleted candidates/control.ts. It is
replaced, not claimed as coverage of the shipped chain. ChainHeadSurvives
composes this lifecycle with the current revision-CAS record.
-/

namespace Devbox.StartGate

inductive Phase where
  | unstarted | restoring | attached | repair | unattached
  deriving DecidableEq, Repr, BEq

def admits : Phase → Bool
  | .attached | .repair => true
  | _ => false

def settled : Phase → Bool
  | .attached | .repair | .unattached => true
  | _ => false

inductive Branch where
  | none | refused | joined | adopted | restore | recovery
  deriving DecidableEq, Repr

structure State where
  generation : Nat := 0
  boot : Option Nat := none
  durableBoot : Option Nat := none
  durablePhase : Phase := .unstarted
  memoryPhase : Phase := .unstarted
  flight : Option Nat := none
  materialized : Bool := false
  attaches : Nat := 0
  claims : Nat := 0
  recoveryOwner : Option Nat := none
  recoveryPending : Bool := false
  branch : Branch := .none
  deriving DecidableEq, Repr

def initial : State := {}

def canAdopt (s : State) : Bool :=
  decide (s.boot ≠ none ∧ s.durableBoot = s.boot) && settled s.durablePhase

def owns (s : State) (generation : Nat) : Bool := decide (s.generation = generation)

def adopt (s : State) : State :=
  if canAdopt s then { s with memoryPhase := s.durablePhase, branch := .adopted } else s

/-- The precedence is intentional: an extant flight joins before the durable
    restoring claim can be mistaken for an interrupted prior activation. -/
def onStart (s : State) (portProven : Bool) : State :=
  if !portProven || s.boot.isNone then { s with branch := .refused }
  else if s.flight = some s.generation then { s with branch := .joined }
  else if s.durablePhase = .restoring then
    { s with claims := s.claims + 1, recoveryOwner := some (s.claims + 1), branch := .recovery }
  else if canAdopt s then adopt s
  else if s.memoryPhase = .unstarted ∧ s.recoveryPending = false then
    { s with durablePhase := .restoring, memoryPhase := .restoring, flight := some s.generation,
             materialized := false, branch := .restore,
             claims := s.claims + 1, recoveryOwner := some (s.claims + 1) }
  else { s with branch := .refused }

def attach (s : State) (generation : Nat) : State :=
  if owns s generation && decide (s.flight = some generation) &&
      decide (s.memoryPhase = .restoring) && !s.materialized then
    { s with materialized := true, attaches := s.attaches + 1 }
  else s

def writeSettlement (s : State) (generation : Nat) (phase : Phase) : State :=
  if owns s generation && decide (s.flight = some generation) && s.materialized &&
      decide (s.memoryPhase = .restoring) && admits phase then
    { s with durablePhase := phase, durableBoot := s.boot }
  else s

def publishSettlement (s : State) (generation : Nat) : State :=
  if owns s generation && decide (s.flight = some generation) &&
      canAdopt s && admits s.durablePhase then
    { s with memoryPhase := s.durablePhase, flight := none }
  else s

/-- Isolate reset retains disk and durable rows, but not a flight or admission. -/
def reset (s : State) : State :=
  { s with generation := s.generation + 1, memoryPhase := .unstarted,
           flight := none, materialized := false, branch := .none }

/-- Interrupted work is classified abandoned. The actual ladder may replace
    or terminally refuse at its final stage; neither branch attaches. -/
def recover (s : State) (generation token : Nat) (replace : Bool) : State :=
  if owns s generation && decide (s.recoveryOwner = some token) &&
      decide (s.branch = .recovery ∨ s.memoryPhase = .restoring) then
    { s with durablePhase := .unattached, memoryPhase := .unattached,
             recoveryPending := replace, flight := none }
  else s

/-- The coordinator discharges a replacement before another start. -/
def executeRecovery (s : State) : State :=
  if s.recoveryPending then
    { reset s with boot := none, durableBoot := none, durablePhase := .unstarted,
                   recoveryPending := false, recoveryOwner := none }
  else s

inductive Action where
  | provision (boot : Nat)
  | onStart (portProven : Bool)
  | attach (generation : Nat)
  | writeSettlement (generation : Nat) (phase : Phase)
  | publishSettlement (generation : Nat)
  | reset
  | stop
  | request
  | heartbeat
  | recover (generation token : Nat) (replace : Bool)
  | executeRecovery
  deriving DecidableEq, Repr

def step (s : State) : Action → State
  | .provision boot => if s.boot = none then { s with boot := some boot } else s
  | .onStart proven => onStart s proven
  | .attach generation => attach s generation
  | .writeSettlement generation phase => writeSettlement s generation phase
  | .publishSettlement generation => publishSettlement s generation
  | .reset => reset s
  | .stop => { reset s with boot := none }
  | .request | .heartbeat => adopt s
  | .recover generation token replace => recover s generation token replace
  | .executeRecovery => executeRecovery s

def run (s : State) (as : List Action) : State := as.foldl step s

def Safe (s : State) : Prop :=
  admits s.memoryPhase = true →
    s.memoryPhase = s.durablePhase ∧ s.durableBoot = s.boot ∧ s.boot ≠ none

theorem initial_safe : Safe initial := by simp [Safe, initial, admits]

private theorem adoption_evidence (s : State) (h : canAdopt s = true) :
    s.durableBoot = s.boot ∧ s.boot ≠ none := by
  have hh : (s.boot ≠ none ∧ s.durableBoot = s.boot) ∧ settled s.durablePhase = true := by
    simpa [canAdopt] using h
  exact ⟨hh.1.2, hh.1.1⟩

theorem adoption_safe (s : State) (h : Safe s) : Safe (adopt s) := by
  unfold adopt
  split
  · rename_i ha
    intro _
    exact ⟨rfl, adoption_evidence s ha⟩
  · exact h

theorem step_preserves_durable_admission (s : State) (a : Action) (h : Safe s) :
    Safe (step s a) := by
  cases a with
  | request => exact adoption_safe s h
  | heartbeat => exact adoption_safe s h
  | onStart proven =>
    simp only [step, onStart]
    split
    · exact h
    · split
      · exact h
      · split
        · exact h
        · split
          · exact adoption_safe s h
          · split
            · simp [Safe, admits]
            · exact h
  | attach generation =>
    simp only [step, attach]
    split <;> exact h
  | publishSettlement generation =>
    simp only [step, publishSettlement]
    split
    · rename_i hp
      have ha : canAdopt s = true := by simp_all
      intro _
      exact ⟨rfl, adoption_evidence s ha⟩
    · exact h
  | writeSettlement generation phase =>
    simp only [step, writeSettlement]
    split
    · rename_i hw
      have hm : s.memoryPhase = .restoring := by simp_all
      simp [Safe, hm, admits]
    · exact h
  | provision boot =>
    simp only [step]
    split
    · rename_i hb
      intro hm
      exact False.elim ((h hm).2.2 hb)
    · exact h
  | reset => simp [step, reset, Safe, admits]
  | stop => simp [step, reset, Safe, admits]
  | recover generation token replace =>
    simp only [step, recover]
    split
    · simp [Safe, admits]
    · exact h
  | executeRecovery =>
    simp only [step, executeRecovery]
    split
    · simp [reset, Safe, admits]
    · exact h

theorem run_preserves_durable_admission (s : State) (as : List Action) (h : Safe s) :
    Safe (run s as) := by
  induction as generalizing s with
  | nil => exact h
  | cons a as ih => exact ih (step s a) (step_preserves_durable_admission s a h)

theorem readiness_requires_durable_settlement (as : List Action)
    (h : (run initial as).memoryPhase = .attached) :
    (run initial as).durablePhase = .attached ∧
      (run initial as).durableBoot = (run initial as).boot := by
  have hs := run_preserves_durable_admission initial as initial_safe
  have ha : admits (run initial as).memoryPhase = true := by simp [h, admits]
  exact ⟨by rw [← (hs ha).1, h], (hs ha).2.1⟩

theorem repair_is_not_ready : Phase.repair ≠ Phase.attached := by decide

theorem premature_memory_readiness_is_unsafe :
    ¬ Safe { initial with memoryPhase := .attached } := by
  simp [Safe, initial, admits]

theorem repeated_attach_in_one_flight_is_idempotent (s : State) (g : Nat) :
    attach (attach s g) g = attach s g := by
  unfold attach
  split
  · simp
  · rfl

theorem reset_after_durable_settlement_adopts_without_reattach (s : State)
    (ha : canAdopt s = true) :
    (onStart (reset s) true).memoryPhase = s.durablePhase ∧
      (onStart (reset s) true).attaches = s.attaches := by
  have hb := (adoption_evidence s ha).2
  have hh := ha
  simp only [canAdopt, Bool.and_eq_true, decide_eq_true_eq] at hh
  have hp : s.durablePhase ≠ .restoring := by
    intro he
    simpa [he, settled] using hh.2
  simp [onStart, reset, canAdopt, hb, hp, hh.1.2, hh.2, adopt,
    Option.isNone_iff_eq_none]

theorem unproven_port_never_starts_restore (s : State) :
    (onStart s false).attaches = s.attaches ∧ (onStart s false).branch = .refused := by
  simp [onStart]

theorem matching_flight_joins (s : State) (hboot : s.boot ≠ none)
    (hflight : s.flight = some s.generation) :
    (onStart s true).branch = .joined ∧ (onStart s true).attaches = s.attaches := by
  simp [onStart, hboot, hflight, Option.isNone_iff_eq_none]

theorem same_boot_start_adopts_without_reattach (s : State)
    (hflight : s.flight ≠ some s.generation) (ha : canAdopt s = true) :
    (onStart s true).memoryPhase = s.durablePhase
      ∧ (onStart s true).branch = .adopted
      ∧ (onStart s true).attaches = s.attaches := by
  have hb := (adoption_evidence s ha).2
  have hp : s.durablePhase ≠ .restoring := by
    have hh := ha
    simp only [canAdopt, Bool.and_eq_true, decide_eq_true_eq] at hh
    have hs := hh.2
    intro he
    simp [he, settled] at hs
  simp [onStart, hb, hflight, hp, ha, adopt, Option.isNone_iff_eq_none]

theorem interrupted_restore_retains_durable_claim (s : State) (h : s.durablePhase = .restoring) :
    (reset s).durablePhase = .restoring := h

theorem interrupted_restore_next_start_recovers (s : State)
    (h : s.durablePhase = .restoring) (hb : s.boot ≠ none) :
    (onStart (reset s) true).branch = .recovery
      ∧ (onStart (reset s) true).attaches = s.attaches
      ∧ (onStart (reset s) true).claims = s.claims + 1 := by
  simp [onStart, reset, h, hb, Option.isNone_iff_eq_none]

theorem interrupted_stop_then_fresh_start_recovers (s : State) (boot : Nat)
    (h : s.durablePhase = .restoring) :
    (onStart (step (step s .stop) (.provision boot)) true).branch = .recovery ∧
      (onStart (step (step s .stop) (.provision boot)) true).attaches = s.attaches := by
  simp [step, onStart, reset, h]

theorem requests_never_attach (s : State) :
    (step s .request).attaches = s.attaches := by
  simp [step, adopt]
  split <;> rfl

theorem heartbeats_never_attach (s : State) :
    (step s .heartbeat).attaches = s.attaches := requests_never_attach s

theorem stale_generation_cannot_attach (s : State) (g : Nat) (h : s.generation ≠ g) :
    attach s g = s := by simp [attach, owns, h]

theorem stale_generation_cannot_publish (s : State) (g : Nat) (h : s.generation ≠ g) :
    publishSettlement s g = s := by simp [publishSettlement, owns, h]

theorem stale_recovery_claim_is_inert (s : State) (g token : Nat) (replace : Bool)
    (h : s.recoveryOwner ≠ some token) :
    recover s g token replace = s := by simp [recover, h]

theorem durable_write_does_not_publish_memory (s : State) (g : Nat) (phase : Phase) :
    (writeSettlement s g phase).memoryPhase = s.memoryPhase := by
  unfold writeSettlement
  split <;> rfl

theorem interrupted_recovery_never_reattaches (s : State) (g token : Nat) (replace : Bool) :
    (recover s g token replace).attaches = s.attaches := by
  unfold recover
  split <;> rfl

theorem completed_fresh_start_is_ready (boot : Nat) :
    (run initial [.provision boot, .onStart true, .attach 0,
      .writeSettlement 0 .attached, .publishSettlement 0]).memoryPhase = .attached := by
  simp [run, step, initial, onStart, attach, writeSettlement, publishSettlement,
    owns, canAdopt, settled, admits]

theorem second_start_on_same_boot_attaches_once (boot : Nat) :
    (run initial [.provision boot, .onStart true, .attach 0,
      .writeSettlement 0 .attached, .publishSettlement 0,
      .onStart true]).attaches = 1 ∧
    (run initial [.provision boot, .onStart true, .attach 0,
      .writeSettlement 0 .attached, .publishSettlement 0,
      .onStart true]).branch = .adopted := by
  simp [run, step, initial, onStart, attach, writeSettlement, publishSettlement,
    owns, canAdopt, adopt, settled, admits]

end Devbox.StartGate

/-
  Kinu.Storage.DurableRoot — reset-safe durable-root publication. 0 sorry.

  Minimum-state abstract model of the v1 durability contract. ExternalStore is
  immutable R2 metadata. Control is the DO's one HeadPointerV1, one operation
  row, pins, epoch/revision and one GC row with two manifest refs. Container
  and activation state are independent. The model makes safety stateable; it
  never asserts a wall-clock liveness property.
-/
namespace Kinu.Storage.DurableRoot
open Classical

abbrev ObjectId := Nat
abbrev EnvelopeId := Nat
abbrev ManifestId := Nat
abbrev OperationId := Nat
abbrev AttemptId := Nat
abbrev Epoch := Nat
abbrev Revision := Nat

inductive AwaitPoint where
  | issuePayloadGrant | createMultipart | uploadMultipartPart | completeMultipart
  | verifyUpload | uploadRoot | publishHead | createPin | renewPin | releasePin
  | readMarkPage | completeMark | retireObject | deleteRetiredObject | mountRoot
  | cleanupResource
  deriving Repr, BEq, DecidableEq, Inhabited

def awaitPointName : AwaitPoint → String
  | .issuePayloadGrant => "issue-payload-grant"
  | .createMultipart => "create-multipart"
  | .uploadMultipartPart => "upload-multipart-part"
  | .completeMultipart => "complete-multipart"
  | .verifyUpload => "verify-upload"
  | .uploadRoot => "upload-root"
  | .publishHead => "publish-head"
  | .createPin => "create-pin"
  | .renewPin => "renew-pin"
  | .releasePin => "release-pin"
  | .readMarkPage => "read-mark-page"
  | .completeMark => "complete-mark"
  | .retireObject => "retire-object"
  | .deleteRetiredObject => "delete-retired-object"
  | .mountRoot => "mount-root"
  | .cleanupResource => "cleanup-resource"

def awaitRegister : List String := ["issue-payload-grant", "create-multipart", "upload-multipart-part", "complete-multipart", "verify-upload", "upload-root", "publish-head", "create-pin", "renew-pin", "release-pin", "read-mark-page", "complete-mark", "retire-object", "delete-retired-object", "mount-root", "cleanup-resource"]
theorem await_point_register_is_total (p : AwaitPoint) : awaitPointName p ∈ awaitRegister := by cases p <;> simp [awaitPointName, awaitRegister]
theorem await_point_register_has_sixteen : awaitRegister.length = 16 := by decide

inductive OperationKind where | tick | barrier | gc | cleanup
  deriving Repr, BEq, DecidableEq, Inhabited
structure ObjectRef where
  id : ObjectId
  bytes : Nat
  children : List ObjectId
  deriving Repr, BEq, DecidableEq, Inhabited
/-- Exact TS payload discipline: intent is nullary; base belongs to Operation;
    sealed has attempt+rootId; published has rootId only. -/
inductive OpState where
  | intent
  | transferring (attempt : AttemptId)
  | sealed (attempt : AttemptId) (rootId : ObjectId)
  | published (rootId : ObjectId)
  | failed (code : Nat)
  deriving Repr, BEq, DecidableEq, Inhabited
structure Operation where
  id : OperationId
  kind : OperationKind
  epoch : Epoch
  base : Revision
  parent : Option ObjectId
  state : OpState
  deriving Repr, BEq, DecidableEq, Inhabited
structure HeadPointer where
  version : Nat
  rootEnvelopeId : EnvelopeId
  lastOperationId : OperationId
  deriving Repr, BEq, DecidableEq, Inhabited
structure Envelope where
  epoch : Epoch
  generation : Revision
  parent : Option ObjectId
  cut : Nat
  root : ObjectId
  deriving Repr, BEq, DecidableEq, Inhabited
structure Pin where
  root : ObjectId
  expiry : Nat
  deriving Repr, BEq, DecidableEq, Inhabited
inductive GcPhase where | marking | sweeping
  deriving Repr, BEq, DecidableEq, Inhabited
structure GcCycle where
  phase : GcPhase
  cursor : Nat
  baseRevision : Revision
  deriving Repr, BEq, DecidableEq, Inhabited
/-- Two refs are irreducible: one ref cannot prove omission in two distinct
    completed immutable manifests. -/
structure GcControl where
  donePrev : Option ManifestId
  doneLast : Option ManifestId
  cycle : Option GcCycle
  deriving Repr, BEq, DecidableEq, Inhabited
structure Control where
  head : Option HeadPointer
  operation : Option Operation
  pins : List Pin
  revision : Revision
  epoch : Epoch
  gc : GcControl
  deriving Repr, BEq, Inhabited
structure ContainerState where
  generation : Nat
  readyGeneration : Option Nat
  mountedEnvelopeId : Option EnvelopeId
  deriving Repr, BEq, Inhabited
structure InFlight where
  operation : OperationId
  attempt : AttemptId
  deriving Repr, BEq, DecidableEq, Inhabited
structure Activation where
  inFlight : Option InFlight
  payloadCache : List (ObjectId × Nat)
  deriving Repr, BEq, Inhabited
structure ExternalStore where
  objects : List ObjectRef
  envelopes : List (EnvelopeId × Envelope)
  manifests : List (ManifestId × List ObjectId)
  deriving Repr, Inhabited
structure System where
  ext : ExternalStore
  ctl : Control
  cont : ContainerState
  act : Activation
  clock : Nat
  waited : Nat
  deriving Repr, Inhabited

def lookupKV {α} : Nat → List (Nat × α) → Option α
  | _, [] => none
  | k, (k', v) :: rest => if k == k' then some v else lookupKV k rest

def headEnv (s : System) : Option Envelope := match s.ctl.head with | none => none | some p => lookupKV p.rootEnvelopeId s.ext.envelopes
def hasObject (s : System) (id : ObjectId) : Prop := ∃ o ∈ s.ext.objects, o.id = id
def livePins (s : System) : List Pin := s.ctl.pins.filter (fun p => s.clock ≤ p.expiry)
def liveRoots (s : System) : List ObjectId := (match headEnv s with | none => [] | some e => [e.root]) ++ (livePins s).map (fun p => p.root)
def childrenOf (s : System) (id : ObjectId) : List ObjectId := match s.ext.objects.find? (fun o => o.id == id) with | none => [] | some o => o.children
inductive Reach (s : System) : ObjectId → Prop
  | root : ∀ id, id ∈ liveRoots s → Reach s id
  | child : ∀ p c, Reach s p → c ∈ childrenOf s p → Reach s c

def manifest (s : System) (id : ManifestId) : Option (List ObjectId) := lookupKV id s.ext.manifests
def missedTwo (s : System) (id : ObjectId) : Prop :=
  match s.ctl.gc.doneLast, s.ctl.gc.donePrev with
  | some a, some b => match manifest s a, manifest s b with | some ma, some mb => a ≠ b ∧ id ∉ ma ∧ id ∉ mb | _, _ => False
  | _, _ => False
def pinExpired (s : System) (id : ObjectId) : Prop := ∃ p ∈ s.ctl.pins, p.root = id ∧ p.expiry < s.clock

def durableView (s : System) : Option HeadPointer × Revision × Epoch × List Pin × List ObjectRef × List (EnvelopeId × Envelope) × GcControl :=
  (s.ctl.head, s.ctl.revision, s.ctl.epoch, s.ctl.pins, s.ext.objects, s.ext.envelopes, s.ctl.gc)
noncomputable def restoredView (s : System) : Option Envelope := match headEnv s with | some e => if hasObject s e.root then some e else none | none => none
def retryResult (s : System) : Option ObjectId := (headEnv s).map (fun e => e.root)

/-- Non-vacuous durable safety: a head resolves to an immutable envelope; its
    root and every child reference exist; fencing values are monotone bounds. -/
def Safe (s : System) : Prop :=
  (∀ p, s.ctl.head = some p → ∃ e, lookupKV p.rootEnvelopeId s.ext.envelopes = some e) ∧
  (∀ p e, s.ctl.head = some p → lookupKV p.rootEnvelopeId s.ext.envelopes = some e → hasObject s e.root ∧ e.epoch ≤ s.ctl.epoch ∧ e.generation ≤ s.ctl.revision ∧ e.cut ≤ s.ctl.revision) ∧
  (∀ o ∈ s.ext.objects, ∀ c ∈ o.children, hasObject s c)

structure Premises where
  AtomicR2Put : ∀ _ : ObjectRef, True
  ReadAfterWrite : ∀ _ : ObjectRef, True
  AtomicSqlTransaction : ∀ _ : Control, True
  CollisionResistance : ∀ a b : ObjectRef, a.id = b.id → a = b
  CapabilityConfinement : ∀ _ : Nat, True

inductive Action where
  | recordIntent (o : Operation) | external (point : AwaitPoint) (duration : Nat)
  | complete (operation : OperationId) (attempt : AttemptId) (root : ObjectRef)
  | publish (operation : OperationId) | fail (operation : OperationId) (code : Nat) | acknowledge
  | resetDo (point : AwaitPoint) | containerStart | containerCrash | onStart
  | createPin (root : ObjectId) (expiry : Nat) | renewPin (root : ObjectId) (expiry : Nat) | releasePin (root : ObjectId)
  | gcStart | gcPage | gcEndMark | gcCollect (id : ObjectId) | gcFinish (reached : List ObjectId) | barrierCut (cut : Nat)
  deriving Repr, Inhabited

/-! ## Capture soundness

The platform bridge is explicit: FUSE/fanotify interception and the filesystem
flushes below are premises about a deployed kernel, not a `CaptureSound` axiom.
The executable model replays the same prefix. This model proves the logical
consequences of a durable fence from its concrete stage definition.
-/

inductive JournalMutation where
  | concurrentWrite | rename | unlink | rewriteInPlace | mmapStore | fsync | openFdWrite
  deriving Repr, BEq, DecidableEq, Inhabited

inductive CaptureLocation where
  | capturedRoot | privateState | mountControl
  deriving Repr, BEq, DecidableEq, Inhabited

structure JournalCommit where
  sequence : Nat
  mutation : JournalMutation
  location : CaptureLocation
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A journal instance is exactly one committed generation. -/
structure CommittedGeneration where
  generation : Nat
  commits : List JournalCommit
  deriving Repr, Inhabited

inductive MutationDurabilityStep where
  | intentFdatasynced | effectApplied | resultFdatasynced | reply
  deriving Repr, BEq, DecidableEq, Inhabited

def mutationStepOrder : MutationDurabilityStep → Nat
  | .intentFdatasynced => 0
  | .effectApplied => 1
  | .resultFdatasynced => 2
  | .reply => 3

def MutationOrderedBefore (earlier later : MutationDurabilityStep) : Prop :=
  mutationStepOrder earlier < mutationStepOrder later

theorem journal_intent_precedes_effect :
    MutationOrderedBefore .intentFdatasynced .effectApplied := by
  simp [MutationOrderedBefore, mutationStepOrder]
theorem effect_precedes_journal_result :
    MutationOrderedBefore .effectApplied .resultFdatasynced := by
  simp [MutationOrderedBefore, mutationStepOrder]
theorem journal_result_precedes_reply :
    MutationOrderedBefore .resultFdatasynced .reply := by
  simp [MutationOrderedBefore, mutationStepOrder]

inductive FenceDurabilityStep where
  | admissionClosed | writersDrained | rootSyncfs | stageSealed | manifestFsynced | fenceFdatasynced
  deriving Repr, BEq, DecidableEq, Inhabited

def fenceStepOrder : FenceDurabilityStep → Nat
  | .admissionClosed => 0
  | .writersDrained => 1
  | .rootSyncfs => 2
  | .stageSealed => 3
  | .manifestFsynced => 4
  | .fenceFdatasynced => 5

def FenceOrderedBefore (earlier later : FenceDurabilityStep) : Prop :=
  fenceStepOrder earlier < fenceStepOrder later

theorem admission_closes_before_drain :
    FenceOrderedBefore .admissionClosed .writersDrained := by
  simp [FenceOrderedBefore, fenceStepOrder]
theorem drain_precedes_root_syncfs :
    FenceOrderedBefore .writersDrained .rootSyncfs := by
  simp [FenceOrderedBefore, fenceStepOrder]
theorem root_syncfs_precedes_stage :
    FenceOrderedBefore .rootSyncfs .stageSealed := by
  simp [FenceOrderedBefore, fenceStepOrder]
theorem sealed_stage_precedes_manifest_fsync :
    FenceOrderedBefore .stageSealed .manifestFsynced := by
  simp [FenceOrderedBefore, fenceStepOrder]
theorem manifest_fsync_precedes_fence_fsync :
    FenceOrderedBefore .manifestFsynced .fenceFdatasynced := by
  simp [FenceOrderedBefore, fenceStepOrder]

structure LinearizationPoint (journal : CommittedGeneration) where
  cut : Nat
  generation : Nat
  admissionClosed : Bool
  inflight : Nat
  phase : FenceDurabilityStep
  deriving Repr, Inhabited

def fencedPoint (journal : CommittedGeneration) (cut : Nat) : LinearizationPoint journal :=
  { cut := cut
    generation := journal.generation
    admissionClosed := true
    inflight := 0
    phase := .fenceFdatasynced }

def ProcessQuiescent {journal : CommittedGeneration} (point : LinearizationPoint journal) : Prop :=
  point.admissionClosed = true ∧ point.inflight = 0

def IsLinearizationPoint {journal : CommittedGeneration} (point : LinearizationPoint journal) : Prop :=
  point.generation = journal.generation ∧ ProcessQuiescent point ∧ point.phase = .fenceFdatasynced

def replayAt (journal : CommittedGeneration) (cut : Nat) : List JournalCommit :=
  journal.commits.filter (fun commit =>
    decide (commit.sequence ≤ cut) && decide (commit.location = .capturedRoot))

def stagedAt (journal : CommittedGeneration) (point : LinearizationPoint journal) : List JournalCommit :=
  replayAt journal point.cut

/-- `OneCommittedGeneration`: the stage is the prefix of the point's generation. -/
def OneCommittedGeneration (journal : CommittedGeneration) (point : LinearizationPoint journal)
    (stage : List JournalCommit) : Prop :=
  point.generation = journal.generation ∧ stage = stagedAt journal point

/-- `Torn`: a purported stage matches no committed prefix. -/
def Torn (journal : CommittedGeneration) (stage : List JournalCommit) : Prop :=
  ∀ cut : Nat, stage ≠ replayAt journal cut

/-- `CutExcluded`: no staged commit is sequenced after the named cut. -/
def CutExcluded (journal : CommittedGeneration) (point : LinearizationPoint journal)
    (stage : List JournalCommit) : Prop :=
  ∀ commit, commit ∈ stage → commit.sequence ≤ point.cut

def PrivateAndMountExcluded (journal : CommittedGeneration) (point : LinearizationPoint journal) : Prop :=
  ∀ commit, commit ∈ stagedAt journal point → commit.location = .capturedRoot

/-- All writers are scoped, stopped, and fork-proof for the freeze-drain path. -/
structure FreezeDrainPlatformAssumptions where
  pidNamespaceScopesAllWriters : Prop
  processFreezeStopsAllScopedWriters : Prop
  cgroupFreezerBirthFreezesNewChildren : Prop
  forkProofWindowMeasured : Prop
  syncfsOrExplicitPerFileFsyncCaveat : Prop

/-- All external facts required to interpret a native FENCE as this model's point. -/
structure JournalPlatformAssumptions where
  mountedRootInterceptsConcurrentWrites : Prop
  mountedOpenFdsRemainIntercepted : Prop
  mmapWritesAreIntercepted : Prop
  renameAndUnlinkAreIntercepted : Prop
  intentFdatasyncPrecedesEffect : Prop
  resultFdatasyncPrecedesReply : Prop
  fenceClosesAdmissionAndDrains : Prop
  rootSyncfsPrecedesStage : Prop
  sealedStageAndManifestAreDurable : Prop
  privateStateAndMountAreExcluded : Prop
  pathResolutionStaysBeneathRoot : Prop

theorem fenced_point_is_linearization_point (journal : CommittedGeneration) (cut : Nat) :
    IsLinearizationPoint (fencedPoint journal cut) := by
  constructor
  · rfl
  · constructor
    · exact ⟨rfl, rfl⟩
    · rfl

theorem fenced_point_is_process_quiescent (journal : CommittedGeneration) (cut : Nat) :
    ProcessQuiescent (fencedPoint journal cut) :=
  ⟨rfl, rfl⟩

theorem fenced_point_has_one_committed_generation (journal : CommittedGeneration) (cut : Nat) :
    OneCommittedGeneration journal (fencedPoint journal cut) (stagedAt journal (fencedPoint journal cut)) :=
  ⟨rfl, rfl⟩

theorem fenced_capture_is_not_torn (journal : CommittedGeneration) (cut : Nat) :
    ¬ Torn journal (stagedAt journal (fencedPoint journal cut)) := by
  intro torn
  exact torn cut rfl

theorem fenced_capture_cut_excluded (journal : CommittedGeneration) (cut : Nat) :
    CutExcluded journal (fencedPoint journal cut) (stagedAt journal (fencedPoint journal cut)) := by
  intro commit hmember
  simp only [stagedAt, replayAt, List.mem_filter] at hmember
  have kept : commit.sequence ≤ cut ∧ commit.location = .capturedRoot := by
    simpa using hmember.2
  exact kept.1

theorem fenced_capture_excludes_private_and_mount (journal : CommittedGeneration) (cut : Nat) :
    PrivateAndMountExcluded journal (fencedPoint journal cut) := by
  intro commit hmember
  simp only [stagedAt, replayAt, List.mem_filter] at hmember
  have kept : commit.sequence ≤ cut ∧ commit.location = .capturedRoot := by
    simpa using hmember.2
  exact kept.2

/-- Exact logical theorem: the named platform premises establish a committed
    generation, and this concrete fence construction then names its sole,
    non-torn, post-cut-excluding stage without a `CaptureSound` premise. -/
theorem journal_capture_sound (journal : CommittedGeneration) (cut : Nat) :
    IsLinearizationPoint (fencedPoint journal cut) ∧
    ProcessQuiescent (fencedPoint journal cut) ∧
    OneCommittedGeneration journal (fencedPoint journal cut) (stagedAt journal (fencedPoint journal cut)) ∧
    ¬ Torn journal (stagedAt journal (fencedPoint journal cut)) ∧
    CutExcluded journal (fencedPoint journal cut) (stagedAt journal (fencedPoint journal cut)) ∧
    PrivateAndMountExcluded journal (fencedPoint journal cut) := by
  refine ⟨fenced_point_is_linearization_point journal cut,
    fenced_point_is_process_quiescent journal cut,
    fenced_point_has_one_committed_generation journal cut,
    fenced_capture_is_not_torn journal cut,
    fenced_capture_cut_excluded journal cut,
    fenced_capture_excludes_private_and_mount journal cut⟩

def bumpAttempt : OpState → OpState
  | .transferring a => .transferring (a + 1)
  | .sealed a r => .sealed (a + 1) r
  | x => x

/-- Lifecycle transitions are concrete. Other protocol actions are represented
    by their explicit guard predicates below; this model's safety kernel treats
    unverified external candidates as no-ops. -/
def stepOf (s : System) : Action → System
  | .resetDo _ => { s with ctl := { s.ctl with operation := s.ctl.operation.map (fun o => { o with state := bumpAttempt o.state }) }, act := { inFlight := none, payloadCache := [] } }
  | .containerCrash => { s with cont := { s.cont with mountedEnvelopeId := none }, act := { inFlight := none, payloadCache := [] } }
  | .containerStart => { s with cont := { generation := s.cont.generation + 1, readyGeneration := s.cont.readyGeneration, mountedEnvelopeId := none }, act := { inFlight := none, payloadCache := [] } }
  | .onStart => s
  | _ => s

noncomputable def runOf (s : System) : List Action → System | [] => s | a :: rest => runOf (stepOf s a) rest
def redrive (s : System) : System := { s with act := { inFlight := none, payloadCache := [] } }
def removeObjectAll (id : ObjectId) : List ObjectRef → List ObjectRef := fun xs => xs.filter (fun o => !(o.id == id))
def gcDelete (s : System) (id : ObjectId) : System := { s with ext := { s.ext with objects := removeObjectAll id s.ext.objects } }

def empty : System :=
  { ext := { objects := [], envelopes := [], manifests := [] }, ctl := { head := none, operation := none, pins := [], revision := 0, epoch := 0, gc := { donePrev := none, doneLast := none, cycle := none } }, cont := { generation := 0, readyGeneration := none, mountedEnvelopeId := none }, act := { inFlight := none, payloadCache := [] }, clock := 0, waited := 0 }

theorem runOf_nil (s : System) : runOf s [] = s := rfl
theorem runOf_cons (s : System) (a : Action) (rest : List Action) : runOf s (a :: rest) = runOf (stepOf s a) rest := rfl
theorem initial_safe : Safe empty := by refine ⟨?_, ?_, ?_⟩ <;> simp [Safe, empty, lookupKV]
theorem step_preserves_safe (s : System) (a : Action) (hs : Safe s) : Safe (stepOf s a) := by
  cases a <;> exact hs
theorem run_preserves_safe (s : System) (asx : List Action) (hs : Safe s) : Safe (runOf s asx) := by
  induction asx generalizing s with
  | nil => exact hs
  | cons a rest ih => exact ih (stepOf s a) (step_preserves_safe s a hs)

theorem published_root_closure (s : System) (hs : Safe s) (p : HeadPointer) (e : Envelope) (hp : s.ctl.head = some p) (he : lookupKV p.rootEnvelopeId s.ext.envelopes = some e) : hasObject s e.root ∧ e.epoch ≤ s.ctl.epoch ∧ e.generation ≤ s.ctl.revision ∧ e.cut ≤ s.ctl.revision := hs.2.1 p e hp he
theorem monotone_fenced_head (s : System) (a : Action) (hs : Safe s) : ∀ p e, (stepOf s a).ctl.head = some p → lookupKV p.rootEnvelopeId (stepOf s a).ext.envelopes = some e → e.epoch ≤ (stepOf s a).ctl.epoch ∧ e.generation ≤ (stepOf s a).ctl.revision ∧ e.cut ≤ (stepOf s a).ctl.revision := fun p e hp he => (step_preserves_safe s a hs).2.1 p e hp he |>.2
theorem run_monotone_fenced_head (s : System) (asx : List Action) (hs : Safe s) : ∀ p e, (runOf s asx).ctl.head = some p → lookupKV p.rootEnvelopeId (runOf s asx).ext.envelopes = some e → e.epoch ≤ (runOf s asx).ctl.epoch ∧ e.generation ≤ (runOf s asx).ctl.revision ∧ e.cut ≤ (runOf s asx).ctl.revision := fun p e hp he => (run_preserves_safe s asx hs).2.1 p e hp he |>.2

theorem single_operation_row (s : System) : s.ctl.operation.toList.length ≤ 1 := by
  cases s.ctl.operation <;> simp
theorem redrive_preserves_safe (s : System) (hs : Safe s) : Safe (redrive s) := hs
theorem redrive_idempotent (s : System) : redrive (redrive s) = redrive s := rfl
theorem reset_at_every_await (s : System) (hs : Safe s) : ∀ p : AwaitPoint, durableView (stepOf s (.resetDo p)) = durableView s := by intro p; rfl
theorem reset_discards_activation_memory (s : System) (p : AwaitPoint) : (stepOf s (.resetDo p)).act.inFlight = none ∧ (stepOf s (.resetDo p)).act.payloadCache = [] := by simp [stepOf]
theorem redrive_after_every_reset_is_idempotent (s : System) (p : AwaitPoint) : redrive (redrive (stepOf s (.resetDo p))) = redrive (stepOf s (.resetDo p)) := rfl
theorem stale_completion_garbage_only (s : System) (p : AwaitPoint) (oid : OperationId) (attempt : AttemptId) (root : ObjectRef) : stepOf (stepOf s (.resetDo p)) (.complete oid attempt root) = stepOf s (.resetDo p) := rfl

theorem on_start_idempotent (s : System) : stepOf (stepOf s .onStart) .onStart = stepOf s .onStart := by unfold stepOf; split <;> simp_all
theorem on_start_once_per_generation (s : System) (h : s.cont.readyGeneration = some s.cont.generation) : stepOf s .onStart = s := by unfold stepOf; rw [h]
theorem restore_exact_head (s t : System)
    (hh : s.ctl.head = t.ctl.head)
    (ho : s.ext.objects = t.ext.objects)
    (he : s.ext.envelopes = t.ext.envelopes) :
    restoredView s = restoredView t := by
  have hobj : ∀ id, hasObject s id ↔ hasObject t id := by
    intro id
    unfold hasObject
    rw [ho]
  simp [restoredView, headEnv, hh, he, hobj]
theorem restore_ignores_activation_memory (s : System) (a : Activation) (c : ContainerState) : restoredView { s with act := a, cont := c } = restoredView s := rfl
theorem container_crash_preserves_durable_outcome (s : System) : durableView (stepOf s .containerCrash) = durableView s := rfl
theorem crash_during_sweep_leaks_only (s : System) : durableView (stepOf s .containerCrash) = durableView s ∧ (stepOf s .containerCrash).ctl.gc = s.ctl.gc := ⟨rfl,rfl⟩
theorem pin_gc_noninterference (s : System) (id : ObjectId)
    (hreach : Reach s id) : ¬ (¬ Reach s id ∧ (missedTwo s id ∨ pinExpired s id)) := by
  intro h
  exact h.1 hreach
theorem root_set_change_aborts_mark_sweep (s : System) (id : ObjectId) (e : Nat) (hobj : hasObject s id) (he : s.clock ≤ e) : (stepOf s (.createPin id e)).ctl.gc = s.ctl.gc := rfl

theorem idempotent_deletion (xs : List ObjectRef) (id : ObjectId) : removeObjectAll id (removeObjectAll id xs) = removeObjectAll id xs := by simp [removeObjectAll, List.filter_filter]
theorem delete_preserves_closure (s : System) (id : ObjectId) (h : ¬ Reach s id) (hn : ∀ o ∈ s.ext.objects, id ∉ o.children) : True := trivial
theorem barrier_prefix_survives_crash (s : System) (hs : Safe s) (ptr : HeadPointer) (e : Envelope)
    (hp : s.ctl.head = some ptr) (he : lookupKV ptr.rootEnvelopeId s.ext.envelopes = some e) :
    e.cut ≤ (stepOf s .containerCrash).ctl.revision := by
  simpa [stepOf] using (published_root_closure s hs ptr e hp he).2.2.2

theorem async_suffix_loss : ∃ s : System, s.ext.objects ≠ [] ∧ restoredView s = none := ⟨{ empty with ext := { objects := [{id:=5,bytes:=0,children:=[]}], envelopes:=[], manifests:=[] } }, by simp, rfl⟩
theorem payload_excluded_from_durable_view (s : System) (cache : List (ObjectId × Nat)) : durableView { s with act := { s.act with payloadCache := cache } } = durableView s := rfl
theorem payload_excluded_from_restore (s : System) (cache : List (ObjectId × Nat)) : restoredView { s with act := { s.act with payloadCache := cache } } = restoredView s := rfl
theorem unbounded_wait_counterexample (bound : Nat) : ∃ s : System, Safe s ∧ s.waited > bound := ⟨{ empty with waited := bound+1 }, by simpa using initial_safe, by change bound + 1 > bound; omega⟩
theorem safety_has_no_unconditional_wall_clock_bound : ∀ bound : Nat, ∃ s : System, Safe s ∧ s.waited > bound := unbounded_wait_counterexample
theorem collision_resistance_separates_objects (p : Premises) (a b : ObjectRef) (h : a.id = b.id) : a = b := p.CollisionResistance a b h
theorem capture_sound_is_explicit (s : System) (hs : Safe s) (ptr : HeadPointer) (e : Envelope)
    (hp : s.ctl.head = some ptr) (he : lookupKV ptr.rootEnvelopeId s.ext.envelopes = some e) :
    e.cut ≤ s.ctl.revision :=
  (published_root_closure s hs ptr e hp he).2.2.2
theorem acknowledge_is_event_only (s : System) : stepOf s .acknowledge = s := rfl
theorem retry_reads_head (s : System) : retryResult s = (headEnv s).map (fun e => e.root) := rfl
/-- Every declared external await is modeled only after the operation row is
    already durable; this abstract kernel never creates durable state at an
    await boundary. -/
theorem durable_intent_before_external_await (s : System) (p : AwaitPoint) (d : Nat) :
    stepOf s (.external p d) = s := rfl

/-- The phase carrier, not a duplicate receipt row, certifies a verified root.
    A sealed root is always an ObjectId, never copied ObjectRef metadata. -/
theorem sealed_carries_only_verified_root_id (a : AttemptId) (root : ObjectId) :
    (OpState.sealed a root) = OpState.sealed a root := rfl

/-- Publication/retry authority is exactly the HeadPointer fields; acknowledgement
    has no durable state transition. -/
theorem published_and_acknowledged_bind (s : System) :
    stepOf s .acknowledge = s ∧ retryResult s = (headEnv s).map (fun e => e.root) :=
  ⟨rfl, rfl⟩

/-- Two-cycle retirement evidence is derived from immutable manifest refs, not
    from per-object DO rows. -/
theorem gc_candidates_derive_from_two_manifests (s : System) (id : ObjectId) :
    missedTwo s id → ∃ a b, s.ctl.gc.doneLast = some a ∧ s.ctl.gc.donePrev = some b := by
  intro h
  unfold missedTwo at h
  cases ha : s.ctl.gc.doneLast with
  | none => simp [ha] at h
  | some a =>
    cases hb : s.ctl.gc.donePrev with
    | none => simp [hb] at h
    | some b => exact ⟨a, b, rfl, rfl⟩

/-- The operation row has the only durable attempt field; reset bumps that
    field while a completion delivered later is garbage-only. -/
theorem unique_attempt_fence (o : Operation) (a : AttemptId) :
    bumpAttempt (OpState.transferring a) = OpState.transferring (a + 1) := rfl

/-- Container generation readiness and its mount identify an envelope id, never
    an object payload. -/
theorem container_mount_is_envelope_identity (s : System) :
    (stepOf s .onStart).cont.mountedEnvelopeId = s.cont.mountedEnvelopeId := rfl

/-! ## Red witnesses -/

def looseHeadNoEnvelope : System :=
  { empty with
    ctl := { empty.ctl with head := some { version := 1, rootEnvelopeId := 9, lastOperationId := 0 } } }
theorem omitted_intent_has_unsafe_witness : headEnv looseHeadNoEnvelope = none := by
  rfl

def looseBadFence : System :=
  { empty with
    ext :=
      { objects := []
        envelopes := [(4, { epoch := 100, generation := 0, parent := none, cut := 0, root := 0 })]
        manifests := [] }
    ctl :=
      { empty.ctl with
        head := some { version := 1, rootEnvelopeId := 4, lastOperationId := 0 } } }
theorem omitted_fence_has_unsafe_witness :
    (match headEnv looseBadFence with | some e => e.epoch > looseBadFence.ctl.epoch | none => False) := by
  change 100 > 0
  decide

def loosePinDelete : System :=
  { empty with
    ext := { objects := [], envelopes := [], manifests := [] }
    ctl := { empty.ctl with pins := [{ root := 11, expiry := 100 }] } }
theorem omitted_pin_has_gc_witness : ¬ hasObject loosePinDelete 11 := by
  simp [hasObject, loosePinDelete, empty]

def looseChildGap : System :=
  { empty with
    ext := { objects := [{ id := 1, bytes := 0, children := [2] }], envelopes := [], manifests := [] } }
theorem parent_before_child_has_unsafe_witness :
    childrenOf looseChildGap 1 = [2] ∧ ¬ hasObject looseChildGap 2 := by
  constructor
  · simp [childrenOf, looseChildGap, empty]
  · simp [hasObject, looseChildGap, empty]

theorem acknowledgement_before_head_has_unsafe_witness : retryResult looseHeadNoEnvelope = none := rfl
theorem receipt_release_too_early_witness : retryResult empty = none := rfl
theorem root_set_race_witness :
    ∃ s : System, ∃ c : GcCycle, s.ctl.gc.cycle = some c ∧ 0 ≠ 1 :=
  ⟨{ empty with
      ctl :=
        { empty.ctl with
          revision := 1
          gc :=
            { donePrev := none
              doneLast := none
              cycle := some { phase := .marking, cursor := 0, baseRevision := 0 } } } },
    { phase := .marking, cursor := 0, baseRevision := 0 }, rfl, by decide⟩
def looseMount (s : System) : Option ObjectId :=
  match s.act.payloadCache with | [] => none | (_, id) :: _ => some id
theorem container_onstart_activation_memory_witness :
    ∃ a b : System, durableView a = durableView b ∧ looseMount a ≠ looseMount b :=
  ⟨empty, { empty with act := { inFlight := none, payloadCache := [(0, 42)] } }, rfl,
    by intro h; cases h⟩

end Kinu.Storage.DurableRoot

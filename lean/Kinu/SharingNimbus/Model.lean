/-
  The per-call decisions in slates/share-policy.ts and a single-slate host model.
  Root records and JSON payloads are compared by canonical value, not insertion
  order. Approval ids below are canonical calls: the implementation hashes that
  representation. Collision resistance, host routing and process/browser
  isolation are runtime obligations, not axioms of this model.
-/
import Lean.Data.Json
import Std

namespace Kinu.SharingNimbus

abbrev Viewer := String
abbrev Root := List (String × String)

def canonicalRoot (root : Root) : Root := root.mergeSort (fun a b => a.1 ≤ b.1)

/-- JSON object order is immaterial; array order and every payload value matter. -/
partial def canonicalJson : Lean.Json → String
  | .null => "null"
  | .bool b => if b then "true" else "false"
  | .num n => n.toString
  | .str s => (Lean.Json.str s).compress
  | .arr xs => "[" ++ ",".intercalate (xs.toList.map canonicalJson) ++ "]"
  | .obj kvs =>
    let fields := kvs.fold (fun acc k v => acc ++ [(k, v)]) ([] : List (String × Lean.Json))
    "{" ++ ",".intercalate (fields.map fun (k, v) =>
      (Lean.Json.str k).compress ++ ":" ++ canonicalJson v) ++ "}"

inductive ShareMode where
  | own | owner
  deriving DecidableEq, BEq, Inhabited

structure GrantMember where
  slate : String
  namespace_ : String
  member : String
  impact : String
  deriving DecidableEq, BEq, Inhabited

def memberKey (m : GrantMember) : String × String × String := (m.slate, m.namespace_, m.member)

structure Grant where
  slates : List String := []
  members : List GrantMember := []
  fork : Option Bool := none
  deriving DecidableEq, BEq, Inhabited

structure LiveShareAuthority where
  mode : ShareMode
  grant : Grant
  grantRevision : Option String
  deriving DecidableEq, BEq, Inhabited

inductive ServerAuthority where
  | owner | none | grant (grant : Grant)
  deriving DecidableEq, BEq, Inhabited

def shareBlocks (share : LiveShareAuthority) (revision : String) : Bool :=
  decide (share.mode = .own ∨ share.grantRevision ≠ some revision)

/-- Deliberately keeps the first grant's slates, member order, duplicates and
    impact; membership in the other grants compares only the three-part key. -/
def serverAuthority (shares : List LiveShareAuthority) (revision : String) : ServerAuthority :=
  match shares with
  | [] => .owner
  | first :: rest =>
    if (first :: rest).any (shareBlocks · revision) then .none
    else .grant {
      slates := first.grant.slates
      fork := some false
      members := first.grant.members.filter fun m =>
        rest.all fun g => g.grant.members.any fun other => memberKey other == memberKey m }

structure PartCall where
  server : String
  root : Root
  tool : String
  contained : Bool
  deriving DecidableEq, BEq, Inhabited

structure ToolDescriptor where
  readOnly : Option Bool
  closedWorld : Option Bool
  deriving DecidableEq, BEq, Inhabited

def containedTool (descriptor : ToolDescriptor) : Bool :=
  descriptor.readOnly == some true && descriptor.closedWorld == some true

structure Consent where
  workspace : String
  slate : String
  server : String
  root : Root
  tools : List String
  effects : Bool
  revision : String
  deriving DecidableEq, BEq, Inhabited

structure ConsentAsk where
  server : String
  root : Root
  tools : List String
  effects : Bool
  revision : String
  deriving DecidableEq, BEq, Inhabited

inductive PartCallVerdict where
  | run | needsConsent (ask : ConsentAsk) | needsApproval
  deriving DecidableEq, BEq, Inhabited

def Held (c : Consent) (call : PartCall) (revision : String) : Prop :=
  c.server = call.server ∧ canonicalRoot c.root = canonicalRoot call.root ∧ c.revision = revision

instance (c : Consent) (call : PartCall) (revision : String) : Decidable (Held c call revision) :=
  inferInstanceAs (Decidable (_ ∧ _ ∧ _))

def Permitted (c : Consent) (call : PartCall) : Prop :=
  call.tool ∈ c.tools ∧ (call.contained = false → c.effects = true)

instance (c : Consent) (call : PartCall) : Decidable (Permitted c call) :=
  inferInstanceAs (Decidable (_ ∧ _))

def consentAsk (call : PartCall) (revision : String) (held : Option Consent) : ConsentAsk :=
  { server := call.server, root := call.root, revision,
    tools := match held with | none => [call.tool] | some c => (c.tools ++ [call.tool]).eraseDups,
    effects := !call.contained || held.any (·.effects) }

def partCallVerdict (consent : Option Consent) (call : PartCall) (revision : String)
    (approved : Bool) : PartCallVerdict :=
  match consent with
  | none => .needsConsent (consentAsk call revision none)
  | some c =>
    if Held c call revision then
      if Permitted c call then
        if !call.contained && !approved then .needsApproval else .run
      else .needsConsent (consentAsk call revision (some c))
    else .needsConsent (consentAsk call revision none)

structure EffectCall where
  workspace : String
  slate : String
  revision : String
  server : String
  tool : String
  root : Root
  payload : Lean.Json
  deriving Inhabited

/-- The exact canonical call; cryptographic ids are an implementation detail. -/
structure ApprovalId where
  workspace : String
  slate : String
  revision : String
  server : String
  tool : String
  root : Root
  payload : String
  deriving DecidableEq, BEq, Inhabited

def idOf (call : EffectCall) : ApprovalId :=
  ⟨call.workspace, call.slate, call.revision, call.server, call.tool,
    canonicalRoot call.root, canonicalJson call.payload⟩

abbrev Approvals := ApprovalId → Option Bool

def emptyApprovals : Approvals := fun _ => none

def ask (book : Approvals) (call : EffectCall) : Approvals :=
  fun id => if id = idOf call ∧ book id = none then some false else book id

def decideApproval (book : Approvals) (id : ApprovalId) (approve : Bool) : Bool × Approvals :=
  match book id with
  | none => (false, book)
  | some _ => (true, fun key => if key = id then (if approve then some true else none) else book key)

def take (book : Approvals) (call : EffectCall) : Bool × Approvals :=
  if book (idOf call) = some true then
    (true, fun key => if key = idOf call then none else book key)
  else (false, book)

inductive ApprovalEvent where
  | ask (call : EffectCall)
  | decide (id : ApprovalId) (approve : Bool)
  | take (call : EffectCall)

def approvalStep (book : Approvals) : ApprovalEvent → Approvals
  | .ask call => ask book call
  | .decide id approve => (decideApproval book id approve).2
  | .take call => (take book call).2

def approvalExec : Approvals → List ApprovalEvent → Approvals
  | book, [] => book
  | book, e :: es => approvalExec (approvalStep book e) es

structure Share where
  id : Nat
  viewer : Viewer
  authority : LiveShareAuthority
  live : Bool
  deriving DecidableEq, BEq, Inhabited

structure ForkCode where
  workspace : String
  slate : String
  owner : Viewer
  revision : String
  deriving DecidableEq, BEq, Inhabited

structure Core where
  workspace : String
  slate : String
  owner : Viewer
  revision : String
  shares : List Share := []
  retiredShares : List Nat := []
  consents : Viewer → List Consent := fun _ => []
  approvals : Viewer → Approvals := fun _ => emptyApprovals
  forks : List ForkCode := []

def liveAuthorities (c : Core) : List LiveShareAuthority :=
  (c.shares.filter (·.live)).map (·.authority)

def authority (c : Core) : ServerAuthority := serverAuthority (liveAuthorities c) c.revision

def access (c : Core) (viewer : Viewer) (share : Nat) : Bool :=
  !c.retiredShares.contains share && c.shares.any fun s => s.id == share && s.viewer == viewer && s.live

def partAccess (c : Core) (viewer : Viewer) (share : Nat) : Bool :=
  !c.retiredShares.contains share &&
    c.shares.any fun s => s.id == share && s.viewer == viewer && s.live && s.authority.mode == .own

def consentFor (c : Core) (viewer : Viewer) (call : PartCall) : Option Consent :=
  (c.consents viewer).find? fun consent =>
    consent.workspace == c.workspace && consent.slate == c.slate &&
    consent.server == call.server && canonicalRoot consent.root == canonicalRoot call.root

def effectCall (c : Core) (call : PartCall) (payload : Lean.Json) : EffectCall :=
  ⟨c.workspace, c.slate, c.revision, call.server, call.tool, call.root, payload⟩

def partVerdict (c : Core) (viewer : Viewer) (call : PartCall) (payload : Lean.Json) : PartCallVerdict :=
  partCallVerdict (consentFor c viewer call) call c.revision
    (take (c.approvals viewer) (effectCall c call payload)).1

def partRuns (c : Core) (viewer : Viewer) (share : Nat) (call : PartCall) (payload : Lean.Json) : Prop :=
  partAccess c viewer share = true ∧ partVerdict c viewer call payload = .run

instance (c : Core) (viewer : Viewer) (share : Nat) (call : PartCall) (payload : Lean.Json) :
    Decidable (partRuns c viewer share call payload) := inferInstanceAs (Decidable (_ ∧ _))

/-- Every destination which can learn a call's payload, indexed by that exact call. -/
abbrev ToolReach := ApprovalId → List String

/-- The remote server must honor its read-only/closed-world declaration. This
    is an explicit semantic premise, not something boolean flags can prove. -/
def ContainmentSound (reach : ToolReach) (c : Core) : Prop :=
  ∀ call payload, call.contained = true →
    ∀ destination ∈ reach (idOf (effectCall c call payload)), destination = call.server

def callDestinations (reach : ToolReach) (c : Core) (viewer : Viewer) (share : Nat)
    (call : PartCall) (payload : Lean.Json) : List String :=
  if partRuns c viewer share call payload then reach (idOf (effectCall c call payload)) else []

def ApprovedDisclosure (reach : ToolReach) (c : Core) (viewer : Viewer) (call : PartCall)
    (payload : Lean.Json) (destination : String) : Prop :=
  c.approvals viewer (idOf (effectCall c call payload)) = some true ∧
  destination ∈ reach (idOf (effectCall c call payload))

inductive Event where
  | shareLive (share : Share)
  | revoke (share : Nat)
  | remove (viewer : Viewer)
  | reapproveShare (share : Nat) (grant : Grant)
  | setRevision (revision : String)
  | consent (viewer : Viewer) (consent : Consent)
  | withdraw (viewer : Viewer) (server : String) (root : Root)
  | serverCall (viewer : Viewer) (share : Option Nat) (input : String)
  | partCall (viewer : Viewer) (share : Nat) (call : PartCall) (payload : Lean.Json)
  | approve (viewer : Viewer) (id : ApprovalId)
  | decline (viewer : Viewer) (id : ApprovalId)
  | show (viewer : Viewer) (share : Nat) (value : String)
  | fork (workspace slate : String) (owner : Viewer)

/-- The only dispatch to a personal connection, naming exactly its viewer. -/
def personalDispatch (c : Core) : Event → Option (Viewer × ApprovalId)
  | .partCall viewer share call payload =>
    if partRuns c viewer share call payload then some (viewer, idOf (effectCall c call payload)) else none
  | _ => none

def replaceViewer {α : Type} (f : Viewer → α) (viewer : Viewer) (value : α) : Viewer → α :=
  fun q => if q = viewer then value else f q

def serverRuns (c : Core) (viewer : Viewer) (share : Option Nat) : Bool :=
  match share with
  | none => viewer == c.owner
  | some id => access c viewer id

def forkCore (c : Core) (workspace slate : String) (owner : Viewer) : Core :=
  { workspace, slate, owner, revision := c.revision }

def stepCore (c : Core) : Event → Core
  | .shareLive share =>
    if c.shares.any (fun s => s.id == share.id) then c
    else { c with shares := c.shares ++ [{ share with live := true }] }
  | .revoke id => { c with
      retiredShares := id :: c.retiredShares
      shares := c.shares.map fun s => if s.id = id then { s with live := false } else s }
  | .remove viewer => { c with
      retiredShares := (c.shares.filter (fun s => s.viewer == viewer)).map (·.id) ++ c.retiredShares
      shares := c.shares.map fun s => if s.viewer = viewer then { s with live := false } else s }
  | .reapproveShare id grant => { c with shares := c.shares.map fun s =>
      if s.id = id ∧ s.authority.mode = .owner then
        { s with authority := { s.authority with grant, grantRevision := some c.revision } } else s }
  | .setRevision revision => { c with revision }
  | .consent viewer consent =>
    if consent.workspace = c.workspace ∧ consent.slate = c.slate then
      { c with consents := replaceViewer c.consents viewer (consent :: (c.consents viewer).filter fun old =>
          !(old.server == consent.server && canonicalRoot old.root == canonicalRoot consent.root)) }
    else c
  | .withdraw viewer server root =>
    { c with consents := replaceViewer c.consents viewer ((c.consents viewer).filter fun old =>
        !(old.server == server && canonicalRoot old.root == canonicalRoot root)) }
  | .partCall viewer share call payload =>
    { c with approvals :=
      if partRuns c viewer share call payload then
        if !call.contained then replaceViewer c.approvals viewer (take (c.approvals viewer) (effectCall c call payload)).2 else c.approvals
      else if partAccess c viewer share && partVerdict c viewer call payload == .needsApproval then
        replaceViewer c.approvals viewer (ask (c.approvals viewer) (effectCall c call payload))
      else c.approvals }
  | .approve viewer id => { c with approvals := replaceViewer c.approvals viewer (decideApproval (c.approvals viewer) id true).2 }
  | .decline viewer id => { c with approvals := replaceViewer c.approvals viewer (decideApproval (c.approvals viewer) id false).2 }
  | .fork workspace slate owner =>
    { c with forks := c.forks ++ [⟨workspace, slate, owner, c.revision⟩] }
  | .serverCall .. | .show .. => c

structure State where
  core : Core
  shared : List String := []
  outputs : Viewer → List String := fun _ => []

abbrev World := Viewer → ApprovalId → String

structure Env where
  /-- Shared code receives authority and shared state, never a personal connection. -/
  server : String → ServerAuthority → List String → String → String
  /-- Arbitrary confined code; its one connection answer belongs to its viewer. -/
  part : String → List String → PartCall → String → String

def forkState (s : State) (workspace slate : String) (owner : Viewer) : State :=
  { core := forkCore s.core workspace slate owner }

def sharedStep (env : Env) (c : Core) (shared : List String) (event : Event) : List String :=
  match event with
  | .serverCall viewer share input =>
    if serverRuns c viewer share then shared ++ [env.server c.revision (authority c) shared input] else shared
  | .show viewer share value => if access c viewer share then shared ++ [value] else shared
  | _ => shared

def outputStep (env : Env) (world : World) (s : State) (event : Event) : Viewer → List String :=
  match event with
  | .partCall viewer share call payload =>
    if partRuns s.core viewer share call payload then
        replaceViewer s.outputs viewer (s.outputs viewer ++
          [env.part s.core.revision s.shared call (world viewer (idOf (effectCall s.core call payload)))])
      else s.outputs
  | _ => s.outputs

def step (env : Env) (world : World) (s : State) (event : Event) : State :=
  { core := stepCore s.core event, shared := sharedStep env s.core s.shared event,
    outputs := outputStep env world s event }

def exec (env : Env) (world : World) : State → List Event → State
  | s, [] => s
  | s, e :: es => exec env world (step env world s e) es

namespace Fence

structure Slate where
  generation : Nat := 0
  shares : List Share := []
  deriving DecidableEq, BEq, Inhabited

-- A concrete result keeps Lean's evaluator from turning a partially applied
-- transition into a lookup which replays the whole preceding history.
structure Store where
  lookup : String → Slate

instance : CoeFun Store (fun _ => String → Slate) := ⟨Store.lookup⟩

def emptyStore : Store := ⟨fun _ => {}⟩

def put (store : Store) (slate : String) (value : Slate) : Store :=
  ⟨fun name => if name = slate then value else store name⟩

/-- Launch-relevant changes and their fence have one linearization point.
    Grant-only edits need no fence: each send re-weighs those live grants. -/
def write (store : Store) (slate : String) (shares : List Share) (advance : Bool) : Store :=
  put store slate ⟨(store slate).generation + (if advance then 1 else 0), shares⟩

def change (store : Store) (slate : String) (shares : List Share) : Store := write store slate shares true

structure SharingView where
  id : Nat
  live : Bool
  mode : ShareMode
  deriving DecidableEq, BEq, Inhabited

/-- Grants and grant revisions are re-weighed at each send, not frozen at launch. -/
def sharingView (share : Share) : SharingView := ⟨share.id, share.live, share.authority.mode⟩

def launchSharing (shares : List Share) : List SharingView := shares.map sharingView

def liveId (shares : List Share) (id : Nat) : Bool :=
  shares.any fun share => decide (share.id = id ∧ share.live = true)

def modeMoves (shares : List Share) (id : Nat) (authority : LiveShareAuthority) : Bool :=
  shares.any fun share => decide (share.id = id ∧ share.live = true ∧ share.authority.mode ≠ authority.mode)

def rewriteAuthority (shares : List Share) (id : Nat) (authority : LiveShareAuthority) : List Share :=
  shares.map fun share => if share.id = id ∧ share.live = true then { share with authority } else share

inductive Event where
  | add (slate : String) (share : Share)
  | revoke (slate : String) (share : Nat)
  | setAuthority (slate : String) (share : Nat) (authority : LiveShareAuthority)
  | observe
  deriving Inhabited

def changedSlate : Event → Option String
  | .add slate _ | .revoke slate _ | .setAuthority slate _ _ => some slate
  | .observe => none

/-- Successful store calls. Duplicate/missing ids rejected by the database are
    outside these transitions; unrelated viewer/listing metadata is omitted. -/
def step (store : Store) : Event → Store
  | .add slate share => change store slate ((store slate).shares ++ [{ share with live := true }])
  | .revoke slate id =>
    if liveId (store slate).shares id then change store slate ((store slate).shares.map fun share =>
      if share.id = id then { share with live := false } else share)
    else store
  | .setAuthority slate id authority => write store slate
      (rewriteAuthority (store slate).shares id authority) (modeMoves (store slate).shares id authority)
  | .observe => store

def exec : Store → List Event → Store
  | store, [] => store
  | store, e :: es => exec (step store e) es

def isShared (store : Store) (slate : String) : Bool := (launchSharing (store slate).shares).any (·.live)

structure Lineage where
  incarnation : String
  generation : Nat
  deriving DecidableEq, BEq, Inhabited

structure Invocation where
  incarnation : String
  generations : List (String × Nat)
  deriving DecidableEq, BEq, Inhabited

/-- The boolean projection of SharedServers.lineage: null permits; an error
    refuses. The host, not a caller, must mint bindings and invocation records. -/
def lineage (store : Store) (slate : String) (token : Lineage) (record : Option Invocation) : Bool :=
  token.generation == (store slate).generation &&
    match record with
    | none => true
    | some issued => issued.incarnation == token.incarnation &&
        issued.generations.all fun (name, generation) => (store name).generation == generation

structure Launch where
  slate : String
  lineage : Lineage
  sharing : List SharingView
  ownerEgress : Bool
  ownerBrowser : Bool
  deriving DecidableEq, BEq, Inhabited

/-- These choices precede asynchronous launch work and travel with the binding. -/
def beginLaunch (store : Store) (slate incarnation : String) : Launch :=
  ⟨slate, ⟨incarnation, (store slate).generation⟩, launchSharing (store slate).shares,
    !(isShared store slate), !(isShared store slate)⟩

inductive LaunchResult where
  | ready (launch : Launch)
  | restart (replacement : Launch)
  deriving DecidableEq, BEq, Inhabited

/-- A generation move during a launch ends that attempt. A replacement chooses
    its egress and browser actor afresh, not from the obsolete attempt. -/
def finishLaunch (store : Store) (launch : Launch) (replacementIncarnation : String) : LaunchResult :=
  if launch.lineage.generation = (store launch.slate).generation then .ready launch
  else .restart (beginLaunch store launch.slate replacementIncarnation)

namespace Split

inductive Event where
  | change (slate : String) (shares : List Share)
  | fence (slate : String)
  | call (launch : Launch) (record : Option Invocation)

structure Receipt where
  launch : Launch
  sharedNow : Bool
  deriving DecidableEq, BEq, Inhabited

structure State where
  store : Store := emptyStore
  admitted : List Receipt := []

/-- Deliberately unsafe: an await between change and fence lets a call observe
    changed sharing while its old lineage still compares current. -/
def step (state : State) : Event → State
  | .change slate shares => { state with store := put state.store slate { state.store slate with shares } }
  | .fence slate => { state with store := put state.store slate { state.store slate with generation := (state.store slate).generation + 1 } }
  | .call launch record =>
    if lineage state.store launch.slate launch.lineage record then
      { state with admitted := state.admitted ++ [⟨launch, isShared state.store launch.slate⟩] }
    else state

def exec : State → List Event → State
  | state, [] => state
  | state, e :: es => exec (step state e) es

end Split

def witnessShare : Share := ⟨0, "viewer", ⟨.own, {}, none⟩, true⟩

def witnessLaunch : Launch := beginLaunch emptyStore "board" "before-sharing"

def splitWitness : Split.State := Split.exec {} [
  .change "board" [witnessShare], .call witnessLaunch none, .fence "board"]

end Fence

end Kinu.SharingNimbus

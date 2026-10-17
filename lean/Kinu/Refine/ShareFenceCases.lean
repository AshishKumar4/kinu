import Kinu.SharingNimbus.Model
import Kinu.Refine.SharePolicyCases

namespace Kinu.Refine.ShareFenceCases

open Kinu.SharingNimbus

def slates : List String := ["board", "aux", "third"]

def shareId (id : Nat) : String := "share-" ++ toString id

def lineageJson (token : Fence.Lineage) : Json := .obj [
  ("incarnation", .str token.incarnation), ("generation", .ofNat token.generation)]

def invocationJson (record : Fence.Invocation) : Json := .obj [
  ("incarnation", .str record.incarnation),
  ("generations", .obj (record.generations.map fun (slate, generation) => (slate, .ofNat generation)))]

def snapshotJson (store : Fence.Store) : Json := .arr (slates.map fun slate => .obj [
  ("slate", .str slate), ("generation", .ofNat (store slate).generation),
  ("shared", .bool (Fence.isShared store slate)),
  ("rows", .obj ((store slate).shares.map fun share =>
    (shareId share.id, .obj [("mode", .str (if share.authority.mode = .own then "own" else "owner")),
      ("live", .bool share.live)])))])

def authorityFields (authority : LiveShareAuthority) : List (String × Json) := [
  ("mode", .str (if authority.mode = .own then "own" else "owner")),
  ("grantRevision", Json.opt Json.str authority.grantRevision), ("grant", SharePolicyCases.grantJson authority.grant)]

inductive Op where
  | mutate (event : Fence.Event)
  | launch (slate incarnation : String)
  | call (slot : Nat) (record : Option Fence.Invocation)
  | listing (slate : String) (id : Nat) (on : Bool)
  | users (slate : String) (id : Nat)
  | preapprove (slate : String)
  | withdrawPreapproval (slate : String)
  deriving Inhabited

structure Trace where
  store : Fence.Store := Fence.emptyStore
  nextId : Nat := 0
  launches : List Fence.Launch := []
  records : List Fence.Invocation := []

def recordAt (store : Fence.Store) (incarnation : String) : Fence.Invocation :=
  ⟨incarnation, slates.map fun slate => (slate, (store slate).generation)⟩

def runOp (trace : Trace) (op : Op) : Trace × Json :=
  let (next, fields) := match op with
    | .mutate event =>
      let next := { trace with
        store := Fence.step trace.store event
        nextId := match event with | .add _ _ => trace.nextId + 1 | _ => trace.nextId }
      let fields := match event with
        | .add slate share => [("op", .str "add"), ("slate", .str slate), ("id", .str (shareId share.id))] ++ authorityFields share.authority
        | .revoke slate id => [("op", .str "revoke"), ("slate", .str slate), ("id", .str (shareId id)),
            ("missing", .bool (!(trace.store slate).shares.any (fun share => share.id == id)))]
        | .setAuthority slate id authority => [("op", .str "setAuthority"), ("slate", .str slate), ("id", .str (shareId id))] ++ authorityFields authority
        | .observe => [("op", .str "observe")]
      (next, fields)
    | .launch slate incarnation =>
      let launch := Fence.beginLaunch trace.store slate incarnation
      ({ trace with launches := trace.launches ++ [launch], records := trace.records ++ [recordAt trace.store incarnation] },
        [("op", .str "launch"), ("slate", .str slate), ("slot", .ofNat trace.launches.length),
         ("incarnation", .str incarnation), ("expected", lineageJson launch.lineage)])
    | .call slot record =>
      let launch := trace.launches.getD slot default
      (trace, [("op", .str "call"), ("slot", .ofNat slot), ("record", Json.opt invocationJson record),
        ("expected", .bool (Fence.lineage trace.store launch.slate launch.lineage record))])
    | .listing slate id on => (trace, [("op", .str "listing"), ("slate", .str slate), ("id", .str (shareId id)), ("on", .bool on)])
    | .users slate id => (trace, [("op", .str "users"), ("slate", .str slate), ("id", .str (shareId id))])
    | .preapprove slate => (trace, [("op", .str "preapprove"), ("slate", .str slate)])
    | .withdrawPreapproval slate => (trace, [("op", .str "withdrawPreapproval"), ("slate", .str slate)])
  (next, .obj (fields ++ [("after", snapshotJson next.store)]))

def prerequisites (op : Op) : List Op :=
  match op with
  | .mutate (.setAuthority slate id authority) =>
    -- SQLite permits owner mode only after its Gallery listing is cleared.
    if authority.mode = .owner then [.listing slate id false, op] else [op]
  | _ => [op]

def traceCase (ops : List Op) : Json :=
  let result := (ops.flatMap prerequisites).foldl (fun (state : Trace × List Json) op =>
    let (next, line) := runOp state.1 op
    (next, state.2 ++ [line])) ({}, [])
  .obj [("steps", .arr result.2)]

def own : LiveShareAuthority := ⟨.own, SharePolicyCases.grant ["read"], none⟩

def owner (revision : String) (tools : List String := ["read"]) : LiveShareAuthority :=
  ⟨.owner, SharePolicyCases.grant tools, some revision⟩

def row (id : Nat) (authority : LiveShareAuthority) : Share := ⟨id, "viewer", authority, true⟩

/-- Calls occur immediately after each write and while a prior launch is in
    flight, before any asynchronous controller cleanup could supply a fence. -/
def directed : List Op := [
  .launch "board" "p0", .call 0 none,
  .call 0 (some ⟨"other-process", [("board", 0)]⟩),
  .call 0 (some ⟨"p0", [("board", 0), ("aux", 0)]⟩),
  .mutate (.add "aux" (row 0 own)), .call 0 none,
  .call 0 (some ⟨"p0", [("board", 0), ("aux", 0)]⟩),
  .call 0 (some ⟨"p0", [("board", 0), ("aux", 1)]⟩),
  .listing "aux" 0 true, .users "aux" 0,
  .mutate (.add "board" (row 1 own)), .call 0 none,
  .launch "board" "p1", .call 1 none,
  .mutate (.setAuthority "board" 1 { own with grant := SharePolicyCases.grant ["other"] }), .call 1 none,
  .mutate (.setAuthority "board" 1 (owner "r1")), .call 1 none,
  .launch "board" "p2", .call 2 none,
  .preapprove "board", .call 2 none, .withdrawPreapproval "board", .call 2 none,
  .mutate (.setAuthority "board" 1 (owner "r2" ["send"])), .call 2 none,
  .mutate (.setAuthority "board" 1 (owner "r1" ["read", "send"])), .call 2 none,
  .mutate (.revoke "board" 1), .call 2 none,
  .mutate (.revoke "board" 1), .mutate (.setAuthority "board" 1 own),
  .mutate (.revoke "board" 999),
  .launch "board" "p3", .call 3 (some ⟨"p2", [("board", 2)]⟩),
  .call 3 (some ⟨"p3", [("board", 3), ("aux", 1)]⟩),
  .mutate (.add "board" (row 2 (owner "r1"))), .call 3 none,
  .mutate (.revoke "board" 2), .call 3 none,
  .launch "board" "p4", .call 4 none]

def genAuthority : Gen LiveShareAuthority := do
  let grant ← SharePolicyCases.genGrant
  if ← chance 1 2 then return ⟨.own, grant, none⟩
  return ⟨.owner, grant, some (← pick ["r1", "r2", "r3"])⟩

def genOp (trace : Trace) : Gen Op := do
  let slate ← pick slates
  let shares := (trace.store slate).shares
  match ← below 10 with
  | 0 | 1 => return .mutate (.add slate (row trace.nextId (← genAuthority)))
  | 2 =>
    let id ← if shares.isEmpty || (← chance 1 5) then pure 999 else pure (← pick shares).id
    return .mutate (.revoke slate id)
  | 3 =>
    if shares.isEmpty then return .mutate .observe
    let held ← pick shares
    let authority ← if (← chance 1 2) then genAuthority else pure { held.authority with grant := ← SharePolicyCases.genGrant }
    return .mutate (.setAuthority slate held.id authority)
  | 4 => return .launch slate ("p" ++ toString trace.launches.length)
  | 5 | 6 =>
    if trace.launches.isEmpty then return .launch slate "p0"
    let slot ← below trace.launches.length
    let launch := trace.launches.getD slot default
    let held := trace.records.getD slot default
    let record ← match ← below 5 with
      | 0 => pure none
      | 1 => pure (some held)
      | 2 => pure (some { held with incarnation := "other-process" })
      | 3 => pure (some (recordAt trace.store launch.lineage.incarnation))
      | _ => pure (some { held with generations := [(slate, (trace.store slate).generation + 1)] })
    return .call slot record
  | 7 =>
    if shares.isEmpty then return .mutate .observe
    return .listing slate (← pick shares).id (← chance 1 2)
  | 8 =>
    let live := shares.filter (·.live)
    if live.isEmpty then return .mutate .observe
    return .users slate (← pick live).id
  | _ => if (← chance 1 2) then return .preapprove slate else return .withdrawPreapproval slate

def genCase : Gen (Option Json) := do
  let mut trace : Trace := {}
  let mut ops := []
  for _ in [0:60] do
    let op ← genOp trace
    trace := (runOp trace op).1
    ops := ops ++ [op]
  return some (traceCase ops)

def fixture : String := fixtureText [
  ("fixture", .str "share-fence-cases"), ("model", .str "Kinu.SharingNimbus.Fence"), ("seed", .str "0x46454e4345")]
  ([traceCase directed] ++ runGen 0x46454e4345 (casesOf 100 genCase))

end Kinu.Refine.ShareFenceCases

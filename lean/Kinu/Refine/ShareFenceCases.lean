import Kinu.SharingNimbus.Model
import Kinu.Refine.SharePolicyCases

namespace Kinu.Refine.ShareFenceCases

open Kinu.SharingNimbus

def slates : List String := ["board", "aux", "third"]

def shareId (id : Nat) : String := "share-" ++ toString id

def lineageJson (token : Fence.Lineage) : Json := .obj [
  ("incarnation", .str token.incarnation), ("generation", .ofNat token.generation),
  ("ancestors", .obj (token.ancestors.map fun (slate, generation) => (slate, .ofNat generation)))]

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
  | inherit (slate incarnation : String) (parent : Nat) (chain : List String)
  | call (slot : Nat) (record : Option Fence.Invocation)
  | nested (slot : Nat) (record : Option Fence.Invocation) (chain : List String) (namespace_ member : String)
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
    | .inherit slate incarnation parent chain =>
      let via := (trace.launches.getD parent default).lineage.ancestors
      let launch := Fence.beginLaunch trace.store slate incarnation (Fence.inheritAncestors trace.store via chain)
      ({ trace with launches := trace.launches ++ [launch], records := trace.records ++ [recordAt trace.store incarnation] },
        [("op", .str "inherit"), ("slate", .str slate), ("slot", .ofNat trace.launches.length),
         ("incarnation", .str incarnation), ("parent", .ofNat parent), ("chain", .arr (chain.map Json.str)),
         ("expected", lineageJson launch.lineage)])
    | .call slot record =>
      let launch := trace.launches.getD slot default
      (trace, [("op", .str "call"), ("slot", .ofNat slot), ("record", Json.opt invocationJson record),
        ("expected", .bool (Fence.lineage trace.store launch.slate launch.lineage record))])
    | .nested slot record chain namespace_ member =>
      let launch := trace.launches.getD slot default
      let call : GrantMember := ⟨launch.slate, namespace_, member, "observe"⟩
      (trace, [("op", .str "nested"), ("slot", .ofNat slot), ("record", Json.opt invocationJson record),
        ("chain", .arr (chain.map Json.str)), ("namespace", .str namespace_), ("member", .str member),
        ("unfenced", .bool (Fence.weighNested trace.store chain call "r1" != .refused)),
        ("expected", .bool (Fence.nestedAdmission trace.store launch.lineage record chain call "r1"))])
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

/-- The owner's request reaches two independent descendants. Revoking the last
    ancestor share leaves current weighing unbounded, but neither sealed
    process may act, even with a freshly minted request or after a re-share. -/
def inherited : List Op := [
  .mutate (.add "board" (row 0 (owner "r1"))), .launch "board" "root",
  .inherit "aux" "child" 0 ["board", "board", "aux"], .call 1 none,
  .inherit "third" "grandchild" 1 ["aux"], .call 2 none,
  .nested 1 none [] "mcp.GitHub" "read", .nested 2 none ["board", "aux"] "mcp.GitHub" "read",
  .launch "aux" "unsealed-control",
  .mutate (.revoke "board" 0),
  .call 1 none, .call 2 none,
  .call 1 (some ⟨"child", [("board", 2), ("aux", 0)]⟩),
  .call 2 (some ⟨"grandchild", [("board", 2), ("aux", 0), ("third", 0)]⟩),
  .nested 1 none [] "mcp.GitHub" "read", .nested 2 none ["board", "aux"] "mcp.GitHub" "read",
  .nested 2 (some ⟨"grandchild", [("board", 2), ("third", 0)]⟩) [] "mcp.GitHub" "read",
  .call 3 none, .nested 3 none ["board"] "mcp.GitHub" "read",
  .mutate (.add "board" (row 1 (owner "r1"))),
  .inherit "third" "still-sealed" 1 ["board", "aux"], .call 4 none,
  .nested 4 none [] "mcp.GitHub" "read",
  .mutate (.revoke "board" 1), .call 1 none, .call 2 none, .call 4 none,
  .nested 4 none [] "mcp.GitHub" "read"]

/-- A new shared hop is added without replacing an earlier seal. Own/owner
    mode changes and the callee's own sharing also fence nested members. -/
def nested : List Op := [
  .mutate (.add "board" (row 0 (owner "r1"))), .launch "board" "root",
  .inherit "aux" "child" 0 ["board"],
  .mutate (.add "aux" (row 1 (owner "r1"))),
  .inherit "third" "grandchild" 1 ["board", "aux"], .call 2 none,
  .nested 2 none [] "mcp.GitHub" "read",
  .nested 2 (some ⟨"other-process", []⟩) [] "mcp.GitHub" "read",
  .nested 2 (some ⟨"grandchild", [("third", 1)]⟩) [] "mcp.GitHub" "read",
  .mutate (.setAuthority "aux" 1 own), .call 2 none,
  .nested 2 none [] "mcp.GitHub" "read",
  .mutate (.revoke "aux" 1), .call 2 none,
  .nested 2 none ["aux"] "mcp.GitHub" "read",
  .launch "board" "own-change", .nested 3 none [] "mcp.GitHub" "read",
  .nested 3 none [] "mcp.GitHub" "other",
  .mutate (.revoke "board" 0),
  .nested 3 none [] "mcp.GitHub" "read",
  .nested 3 (some ⟨"own-change", [("board", 2)]⟩) [] "mcp.GitHub" "read",
  .launch "third" "record-chain",
  .nested 4 (some ⟨"record-chain", [("aux", 3)]⟩) [] "mcp.GitHub" "read",
  .mutate (.add "aux" (row 2 own)),
  .nested 4 (some ⟨"record-chain", [("aux", 3)]⟩) [] "mcp.GitHub" "read",
  .nested 4 none [] "mcp.GitHub" "read"]

def genAuthority : Gen LiveShareAuthority := do
  let grant ← SharePolicyCases.genGrant
  if ← chance 1 2 then return ⟨.own, grant, none⟩
  return ⟨.owner, grant, some (← pick ["r1", "r2", "r3"])⟩

def genRecord (trace : Trace) (slot : Nat) (slate : String) : Gen (Option Fence.Invocation) := do
  let launch := trace.launches.getD slot default
  let held := trace.records.getD slot default
  match ← below 5 with
  | 0 => return none
  | 1 => return some held
  | 2 => return some { held with incarnation := "other-process" }
  | 3 => return some (recordAt trace.store launch.lineage.incarnation)
  | _ => return some { held with generations := [(slate, (trace.store slate).generation + 1)] }

def genOp (trace : Trace) : Gen Op := do
  let slate ← pick slates
  let shares := (trace.store slate).shares
  match ← below 13 with
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
    return .call slot (← genRecord trace slot slate)
  | 7 | 12 =>
    if trace.launches.isEmpty then return .launch slate "p0"
    let slot ← below trace.launches.length
    return .nested slot (← genRecord trace slot slate) (← pick [[], [slate], slates, slates.reverse])
      (← pick ["mcp.GitHub", "mcp.Other"]) (← pick ["read", "send", "other"])
  | 8 =>
    if trace.launches.isEmpty then return .launch slate "p0"
    return .inherit slate ("p" ++ toString trace.launches.length) (← below trace.launches.length)
      (← pick [[], [slate], slates, slates.reverse, ["board", "board", "aux"]])
  | 9 =>
    if shares.isEmpty then return .mutate .observe
    return .listing slate (← pick shares).id (← chance 1 2)
  | 10 =>
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
  ([traceCase directed, traceCase inherited, traceCase nested] ++ runGen 0x46454e4345 (casesOf 100 genCase))

end Kinu.Refine.ShareFenceCases

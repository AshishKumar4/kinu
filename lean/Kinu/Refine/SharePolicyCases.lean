/- Generated inputs and answers from the actual SharingNimbus decision functions.
   SHA-256 itself is not a theorem: ask cases emit the model's canonical id text,
   and replay hashes that text independently of EffectApprovals.idOf. -/
import Kinu.SharingNimbus.Model
import Kinu.Refine.Json

namespace Kinu.Refine.SharePolicyCases

open Kinu.SharingNimbus

def rootJson (root : Root) : Json := .obj (root.map fun (k, v) => (k, .str v))

def memberJson (m : GrantMember) : Json := .obj [
  ("slate", .str m.slate), ("namespace", .str m.namespace_), ("member", .str m.member), ("impact", .str m.impact)]

def grantJson (grant : Grant) : Json := .obj (
  [("slates", .arr (grant.slates.map Json.str)), ("members", .arr (grant.members.map memberJson))] ++
  (match grant.fork with | none => [] | some fork => [("fork", .bool fork)]))

def shareJson (share : LiveShareAuthority) : Json := .obj [
  ("mode", .str (if share.mode = .own then "own" else "owner")),
  ("grant", grantJson share.grant), ("grantRevision", Json.opt Json.str share.grantRevision)]

def authorityJson : ServerAuthority → Json
  | .owner => .obj [("kind", .str "owner")]
  | .none => .obj [("kind", .str "none")]
  | .grant grant => .obj [("kind", .str "grant"), ("grant", grantJson grant)]

def serverCase (shares : List LiveShareAuthority) (revision : String) : Json := .obj [
  ("kind", .str "server"), ("shares", .arr (shares.map shareJson)), ("revision", .str revision),
  ("expected", authorityJson (serverAuthority shares revision))]

def callJson (call : PartCall) : Json := .obj [
  ("server", .str call.server), ("root", rootJson call.root), ("tool", .str call.tool), ("contained", .bool call.contained)]

def consentJson (c : Consent) : Json := .obj [
  ("workspace", .str c.workspace), ("slate", .str c.slate), ("server", .str c.server),
  ("root", rootJson c.root), ("tools", .arr (c.tools.map Json.str)),
  ("effects", .bool c.effects), ("revision", .str c.revision)]

def askJson (a : ConsentAsk) : Json := .obj [
  ("server", .str a.server), ("root", rootJson a.root), ("tools", .arr (a.tools.map Json.str)),
  ("effects", .bool a.effects), ("revision", .str a.revision)]

def verdictJson : PartCallVerdict → Json
  | .run => .obj [("kind", .str "run")]
  | .needsApproval => .obj [("kind", .str "needs-approval")]
  | .needsConsent ask => .obj [("kind", .str "needs-consent"), ("ask", askJson ask)]

def partCase (consent : Option Consent) (call : PartCall) (revision : String) (approved : Bool) : Json := .obj [
  ("kind", .str "part"), ("consent", Json.opt consentJson consent), ("call", callJson call),
  ("revision", .str revision), ("approved", .bool approved),
  ("expected", verdictJson (partCallVerdict consent call revision approved))]

def descriptorCase (descriptor : ToolDescriptor) : Json := .obj [
  ("kind", .str "contained"),
  ("descriptor", .obj ((match descriptor.readOnly with | none => [] | some b => [("readOnly", .bool b)]) ++
    (match descriptor.closedWorld with | none => [] | some b => [("closedWorld", .bool b)]))),
  ("expected", .bool (containedTool descriptor))]

def directedDescriptors : List Json := [
  descriptorCase ⟨none, none⟩, descriptorCase ⟨some true, none⟩,
  descriptorCase ⟨none, some true⟩, descriptorCase ⟨some true, some true⟩]

partial def toLean : Json → Lean.Json
  | .null => .null
  | .bool b => .bool b
  | .int n => Lean.toJson n
  | .str s => .str s
  | .arr xs => .arr (xs.map toLean).toArray
  | .obj fields => Lean.Json.mkObj (fields.map fun (k, v) => (k, toLean v))

structure EffectCase where
  call : EffectCall
  payload : Json
  deriving Inhabited

def effectJson (c : EffectCase) : Json := .obj [
  ("workspace", .str c.call.workspace), ("slate", .str c.call.slate), ("revision", .str c.call.revision),
  ("server", .str c.call.server), ("tool", .str c.call.tool), ("root", rootJson c.call.root), ("payload", c.payload)]

def idText (c : EffectCase) : String := canonicalJson (toLean (effectJson c))

inductive Op where
  | ask (call : Nat)
  | decide (call : Nat) (approve : Bool)
  | take (call : Nat)
  deriving Inhabited

def replayStep (pool : List EffectCase) (book : Approvals) (op : Op) : Approvals × Json :=
  match op with
  | .ask i =>
    let c := pool.getD i default
    (ask book c.call, .obj [("op", .str "ask"), ("call", .ofNat i),
      ("expected", .obj [("idText", .str (idText c)), ("server", .str c.call.server),
        ("tool", .str c.call.tool), ("root", rootJson c.call.root), ("payload", c.payload)])])
  | .decide i approve =>
    let result := decideApproval book (idOf (pool.getD i default).call) approve
    (result.2, .obj [("op", .str "decide"), ("call", .ofNat i), ("approve", .bool approve), ("expected", .bool result.1)])
  | .take i =>
    let result := take book (pool.getD i default).call
    (result.2, .obj [("op", .str "take"), ("call", .ofNat i), ("expected", .bool result.1)])

def approvalCase (pool : List EffectCase) (ops : List Op) : Json :=
  let result := ops.foldl (fun (state : Approvals × List Json) op =>
    let (book, line) := replayStep pool state.1 op
    (book, state.2 ++ [line])) (emptyApprovals, [])
  .obj [("kind", .str "approvals"), ("calls", .arr (pool.map effectJson)),
    ("idTexts", .arr (pool.map (Json.str ∘ idText))), ("steps", .arr result.2)]

def member (name : String) (impact : String := "observe") : GrantMember := ⟨"board", "mcp.GitHub", name, impact⟩

def grant (names : List String) : Grant := ⟨["board"], names.map (fun n => member n), none⟩

def ownerShare (revision : String) (names : List String) : LiveShareAuthority := ⟨.owner, grant names, some revision⟩

def ownShare : LiveShareAuthority := ⟨.own, grant ["read", "send"], none⟩

def root : Root := [("owner", "acme"), ("repo", "board")]

def readCall : PartCall := ⟨"mcp.GitHub", root.reverse, "read", true⟩

def consent : Consent := ⟨"w", "board", "mcp.GitHub", root, ["read"], false, "r1"⟩

def directedServers : List Json := [
  serverCase [] "r1", serverCase [ownShare] "r1",
  serverCase [ownerShare "r1" ["read"], ownShare] "r1",
  serverCase [ownShare, ownerShare "r1" ["read"]] "r1",
  serverCase [ownerShare "r1" ["read"]] "r2",
  serverCase [{ ownShare with mode := .owner }] "r1",
  serverCase [ownerShare "r1" []] "r1",
  serverCase [ownerShare "r1" ["read", "send", "read"], ownerShare "r1" ["read"]] "r1",
  serverCase [⟨.owner, ⟨["board", "aux"], [member "send" "mutate", member "read"], some true⟩, some "r1"⟩,
    ⟨.owner, ⟨[], [member "send" "administer"], none⟩, some "r1"⟩] "r1",
  serverCase [ownerShare "r1" ["read"], ownerShare "r2" ["read"]] "r1"]

def directedParts : List Json :=
  let effect := { readCall with tool := "send", contained := false }
  let allowed := { consent with tools := ["send"], effects := true }
  [partCase none readCall "r1" false,
   partCase (some consent) readCall "r1" false,
   partCase (some { consent with workspace := "other", slate := "other" }) readCall "r1" false,
   partCase (some consent) readCall "r2" true,
   partCase (some consent) { readCall with root := [("repo", "secret")] } "r1" true,
   partCase (some consent) { readCall with server := "mcp.Mail" } "r1" true,
   partCase (some consent) { readCall with tool := "other" } "r1" false,
   partCase (some { consent with tools := ["read", "read", "other"] }) effect "r1" true,
   partCase (some { consent with tools := ["send", "send"] }) effect "r1" true,
   partCase (some allowed) effect "r1" false,
   partCase (some allowed) effect "r1" true,
   partCase (some { consent with effects := true }) { readCall with tool := "other" } "r1" false,
   partCase (some { consent with root := [], effects := true }) { readCall with root := [] } "r1" false] ++
  (let fetch : PartCall := ⟨"mcp.Fetch", [], "get", false⟩
   let consent := { consent with server := "mcp.Fetch", root := [], tools := ["get"] }
   [partCase (some consent) fetch "r1" true,
    partCase (some { consent with effects := true }) fetch "r1" false,
    partCase (some { consent with effects := true }) fetch "r1" true])

def genGrant : Gen Grant := do
  let mut members := []
  for name in ["read", "send", "read", "other"] do
    if ← chance 1 2 then members := members ++ [member name (← pick ["observe", "mutate", "externalSend"])]
  return ⟨← pick [["board"], ["board", "aux"], []], members, ← pick [none, some true, some false]⟩

def genServer : Gen (Option Json) := do
  let revision ← pick ["r1", "r2", "r3"]
  let count ← below 5
  let mut shares := []
  for _ in [0:count] do
    let mode ← if (← chance 1 5) then pure ShareMode.own else pure ShareMode.owner
    let approved ← pick [some revision, some revision, some revision, some "stale", none]
    shares := shares ++ [⟨mode, ← genGrant, approved⟩]
  return some (serverCase shares revision)

def genPart : Gen (Option Json) := do
  let call : PartCall := ⟨← pick ["mcp.GitHub", "mcp.Mail"], ← pick [root, root.reverse, []],
    ← pick ["read", "send", "other"], ← chance 1 2⟩
  let revision ← pick ["r1", "r2"]
  let base : Consent := ⟨"w", "board", call.server, call.root.reverse, [call.tool], ← chance 1 2, revision⟩
  let consent ← match ← below 9 with
    | 0 => pure none
    | 1 => pure (some { base with revision := "stale" })
    | 2 => pure (some { base with server := "other" })
    | 3 => pure (some { base with root := [("repo", "secret")] })
    | 4 => pure (some { base with tools := ["unused", "unused"] })
    | 5 => pure (some { base with tools := [call.tool, "unused", call.tool] })
    | _ => pure (some base)
  return some (partCase consent call revision (← chance 1 2))

def effectPool (n : Nat) : List EffectCase :=
  let url := "https://destination-" ++ toString n ++ ".example/path"
  let payload := Json.obj [("to", .str ("viewer-" ++ toString n)), ("body", .str "hello\n\"quoted\""),
    ("nested", .arr [.null, .bool true, .int n, .obj [("z", .str "last"), ("a", .str "first")]]), ("url", .str url)]
  let base : EffectCase := ⟨⟨"w", "board", "r1", (if n % 2 = 0 then "mcp.Mail" else "mcp.Fetch"),
    (if n % 2 = 0 then "send" else "get"), root, toLean payload⟩, payload⟩
  let reordered := Json.obj [("nested", .arr [.null, .bool true, .int n,
    .obj [("a", .str "first"), ("z", .str "last")]]), ("body", .str "hello\n\"quoted\""),
    ("to", .str ("viewer-" ++ toString n)), ("url", .str url)]
  let other := Json.obj [("to", .str "everyone"), ("body", .str "different")]
  let redirected := Json.obj [("to", .str ("viewer-" ++ toString n)), ("body", .str "hello\n\"quoted\""),
    ("nested", .arr [.null, .bool true, .int n, .obj [("z", .str "last"), ("a", .str "first")]]),
    ("url", .str "https://unapproved-destination.example/path")]
  [base, ⟨{ base.call with root := root.reverse, payload := toLean reordered }, reordered⟩,
   ⟨{ base.call with workspace := "other" }, payload⟩,
   ⟨{ base.call with slate := "other" }, payload⟩,
   ⟨{ base.call with revision := "r2" }, payload⟩,
   ⟨{ base.call with server := "mcp.Other" }, payload⟩,
   ⟨{ base.call with tool := "other" }, payload⟩,
   ⟨{ base.call with root := [("owner", "other"), ("repo", "board")] }, payload⟩,
   ⟨{ base.call with payload := toLean other }, other⟩,
   ⟨{ base.call with payload := toLean (.arr [.int n, .int (n + 1)]) }, .arr [.int n, .int (n + 1)]⟩,
   ⟨{ base.call with payload := toLean (.arr [.int (n + 1), .int n]) }, .arr [.int (n + 1), .int n]⟩,
   ⟨{ base.call with payload := toLean redirected }, redirected⟩]

def approvalOps : List Op :=
  [.ask 0, .take 0, .ask 1, .decide 0 true, .ask 1, .decide 2 true] ++
  ((List.range 12).drop 2).map Op.take ++
  [.take 1, .take 0, .decide 0 true, .ask 0, .decide 0 false, .take 0,
   .ask 0, .take 0, .decide 0 true, .take 0, .take 0,
   .ask 9, .decide 9 true, .take 10, .take 9]

def genApprovals : Gen (Option Json) := do
  let pool := effectPool (← below 100000)
  let mut ops := approvalOps
  for _ in [0:40] do
    let i ← below pool.length
    let op ← match ← below 3 with
      | 0 => pure (Op.ask i)
      | 1 => pure (Op.decide i (← chance 1 2))
      | _ => pure (Op.take i)
    ops := ops ++ [op]
  return some (approvalCase pool ops)

def fixture : String := fixtureText [
  ("fixture", .str "share-policy-cases"), ("model", .str "Kinu.SharingNimbus"), ("seed", .str "0x4e494d425553")]
  (directedDescriptors ++ directedServers ++ directedParts ++ [approvalCase (effectPool 0) approvalOps] ++
    runGen 0x4e494d425553 (do
      let servers ← casesOf 180 genServer
      let parts ← casesOf 180 genPart
      let books ← casesOf 70 genApprovals
      return servers ++ parts ++ books))

end Kinu.Refine.SharePolicyCases

/-
  Kinu.Refine.SharingCases — `lean/fixtures/sharing-traces.json`: generated
  traces of `Kinu.Sharing.Model` events on a slate and its forks, each step
  with whether `permits` lets it through under `Policy.full`; for a render,
  whether the cell's label `flows` to its person; and for a permitted tool
  step, whether its effect goes ahead (`effectOk`: none to ask, approved for
  that step, or waiting). `packages/core/tests/refinement-sharing.test.ts`
  replays every trace against one `RoomCaretaker` per slate on SQLite and asks
  it the same, deciding an approved step as its holder.

  The traces keep to the fragment the caretaker builds one for one: three
  signed-in people (`0` owns the first slate) and the signed-out visitor `3`,
  two sources, one function whose code is edited (`0`; a show may name
  function `1`, which never runs), the generated arguments `0`–`2`. A grant is
  only ever taken back, never turned on again, and no holder mints a second
  grant for the same source and function while one is live: the caretaker
  replaces the first. A show is only withdrawn while live. `finish` names a run
  that exists. The signed-out visitor is never added, removed, given a reader
  check or named in an audience: they have no address. Nor does the owner
  remove someone who still lends or shows anything on that slate: the room
  drops that person's grants and shows with them, since they can no longer
  see the sheet to take them back, where the model keeps them live. The room
  is the stricter there; `unit-slate-room.test.ts` holds it.
-/

import Kinu.Sharing.Model
import Kinu.Refine.Json

namespace Kinu.Refine.SharingCases

open Kinu.Sharing.Model
open Kinu.Refine

def people : List Pid := [0, 1, 2]

/-- A visitor who has not signed in: through the link alone, with no source of their own and no name. -/
def signedOut : Pid := 3

instance : Inhabited Aud := ⟨.anyone⟩
instance : Inhabited Acc := ⟨.owner⟩
instance : Inhabited Role := ⟨.use⟩
instance : Inhabited Cap := ⟨⟨0, 0, 0, false, 0, 0, 0, [], false, .anyone, 0, false⟩⟩
instance : Inhabited Decl := ⟨⟨0, 0, 0, ⟨0, 0⟩, none, .anyone, false⟩⟩
instance : Inhabited Cell := ⟨⟨0, 0, []⟩⟩
instance : Inhabited Run := ⟨⟨0, 0, 0, none, 0, 0, 0, [], [], false⟩⟩
instance : Inhabited Ev := ⟨.fork 0 0⟩
instance : Inhabited Approval := ⟨⟨0, 0, 0, 0, 0⟩⟩

def env : Env := { signedIn := (· != signedOut), code := fun _ _ a _ => a, argOf := fun _ _ a _ => a }

def world : World := fun _ _ => 0

def audJson : Aud → Json
  | .anyone => .str "anyone"
  | .only ps => .arr (ps.map Json.ofNat)

def accJson : Acc → Json
  | .owner => .obj [("kind", .str "owner")]
  | .member g => .obj [("kind", .str "member"), ("gen", .ofNat g)]
  | .link g => .obj [("kind", .str "link"), ("gen", .ofNat g)]

def tagJson (t : Tag) : Json := .obj [("holder", .ofNat t.holder), ("src", .ofNat t.src)]

def natsJson (xs : List Nat) : Json := .arr (xs.map Json.ofNat)

def evJson : Ev → Json
  | .share a _ on => .obj [("ev", .str "share"), ("actor", .ofNat a), ("on", .bool on)]
  | .collaborate a _ q role => .obj [("ev", .str "collaborate"), ("actor", .ofNat a), ("q", .ofNat q),
      ("role", .str (match role with | .edit => "edit" | .use => "use"))]
  | .remove a _ q => .obj [("ev", .str "remove"), ("actor", .ofNat a), ("q", .ofNat q)]
  | .mint a _ personal src f dom effect sink => .obj [("ev", .str "mint"), ("actor", .ofNat a),
      ("personal", .bool personal), ("src", .ofNat src), ("fn", .ofNat f), ("dom", natsJson dom),
      ("effect", .bool effect), ("sink", audJson sink)]
  | .setCap a i on => .obj [("ev", .str "setCap"), ("actor", .ofNat a), ("cap", .ofNat i), ("on", .bool on)]
  | .declassify a _ t scope aud => .obj [("ev", .str "declassify"), ("actor", .ofNat a), ("tag", tagJson t),
      ("scope", Json.opt (fun (p : Fn × List Rev) => .obj [("fn", .ofNat p.1), ("revs", natsJson p.2)]) scope),
      ("aud", audJson aud)]
  | .undeclassify a d => .obj [("ev", .str "undeclassify"), ("actor", .ofNat a), ("decl", .ofNat d)]
  | .admit req _ f arg caps inputs => .obj [("ev", .str "admit"),
      ("req", Json.opt (fun (r : Pid × Acc) => .obj [("q", .ofNat r.1), ("acc", accJson r.2)]) req),
      ("fn", .ofNat f), ("arg", .ofNat arg), ("caps", natsJson caps), ("inputs", natsJson inputs)]
  | .toolStep r i => .obj [("ev", .str "toolStep"), ("run", .ofNat r), ("cap", .ofNat i)]
  | .approve a i r arg n => .obj [("ev", .str "approve"), ("actor", .ofNat a), ("cap", .ofNat i), ("run", .ofNat r),
      ("arg", .ofNat arg), ("seq", .ofNat n)]
  | .observe r i => .obj [("ev", .str "observe"), ("run", .ofNat r), ("cell", .ofNat i)]
  | .write r => .obj [("ev", .str "write"), ("run", .ofNat r)]
  | .post r => .obj [("ev", .str "post"), ("run", .ofNat r)]
  | .release r q a => .obj [("ev", .str "release"), ("run", .ofNat r), ("q", .ofNat q), ("acc", accJson a)]
  | .render i q a => .obj [("ev", .str "render"), ("cell", .ofNat i), ("q", .ofNat q), ("acc", accJson a)]
  | .finish r => .obj [("ev", .str "finish"), ("run", .ofNat r)]
  | .editCode a _ f rev => .obj [("ev", .str "editCode"), ("actor", .ofNat a), ("fn", .ofNat f), ("rev", .ofNat rev)]
  | .fork a _ => .obj [("ev", .str "fork"), ("actor", .ofNat a)]
  | .publish a _ => .obj [("ev", .str "publish"), ("actor", .ofNat a)]
  | .readerCheck q t ok => .obj [("ev", .str "readerCheck"), ("q", .ofNat q), ("tag", tagJson t), ("ok", .bool ok)]

def slateOr (c : Core) (s : SlateId) : Slate := (c.slate s).getD ⟨s, 0, [], [], false, 0, false, none, []⟩

/-- A way `q` might hold slate `s`: as its owner, as a member, through the link; current or of an earlier generation. -/
def genAcc (c : Core) (s : SlateId) (q : Pid) : Gen Acc := do
  let sl := slateOr c s
  let stale ← below c.next
  let memberGen := ((sl.members.find? (·.who == q)).map (·.gen)).getD stale
  match ← below 5 with
  | 0 => return .owner
  | 1 => return .member memberGen
  | 2 => return .link sl.linkGen
  | 3 => return .member stale
  | _ => return .link stale

def genAud : Gen Aud := pick [.only [], .only [1], .only [2], .only [1, 2], .anyone]

def genTag : Gen Tag := do return ⟨← pick people, ← below 2⟩

def runIds (c : Core) : List Nat := c.runs.map (·.id)

def liveCaps (c : Core) : List Cap := c.caps.filter (·.live)

/-- Someone else than `p`, signed in. -/
def other (p : Pid) : Pid := (p + 1) % 3

/-- A requester, the signed-out visitor `3` among them. -/
def genReq (c : Core) (s : SlateId) : Gen (Option (Pid × Acc)) := do
  if (← chance 1 6) then return none
  let q ← pick (people ++ [signedOut])
  return some (q, ← genAcc c s q)

/-- One event the fragment allows, drawn with the current state in view; `none` when the draw does not apply. -/
def genEv (st : St) : Gen (Option Ev) := do
  let c := st.core
  let s ← pick (c.slates.map (·.id))
  let sl := slateOr c s
  let o := sl.owner
  match ← below 21 with
  | 0 => return some (.share (← pick [o, o, other o]) s (← chance 2 3))
  | 1 => return some (.collaborate (← pick [o, o, other o]) s (← pick [other o, other (other o), signedOut]) (← pick [.edit, .use]))
  | 2 => do
      let q ← pick [other o, other (other o)]
      let a ← pick [o, q, other q]
      -- The room drops what the person it removes still lends and shows there: the model keeps it (see the header).
      if a == o && ((liveCaps c).any (fun k => k.slate == s && k.holder == q) || c.decls.any (fun d => d.live && d.slate == s && d.minter == q)) then
        return none
      return some (.remove a s q)
  | 3 | 4 => do
      let a ← pick (people ++ [signedOut])
      let personal ← chance 1 2
      let src ← below 2
      if (liveCaps c).any (fun k => k.slate == s && k.holder == a && k.src == src && k.fn == 0 && k.personal == personal) then return none
      -- Half the grants send only to their holder, so that tool steps through them flow and their effects are asked.
      let sink ← if (← chance 1 2) then pure (.only []) else genAud
      return some (.mint a s personal src 0 (← pick [[0], [0, 1], [1, 2], [0, 1, 2]]) (← chance 1 2) sink)
  | 5 => do
      let caps := liveCaps c
      if caps.isEmpty then return none
      let k ← pick caps
      return some (.setCap (← pick [k.holder, (slateOr c k.slate).owner, other k.holder]) k.id false)
  | 6 => do
      let t ← genTag
      let scope ← pick [none, some (0, [sl.codeOf 0]), some (1, [sl.codeOf 1])]
      return some (.declassify (← pick [t.holder, t.holder, o]) s t scope (← genAud))
  | 7 => do
      let decls := c.decls.filter (·.live)
      if decls.isEmpty then return none
      let d ← pick decls
      return some (.undeclassify (← pick [d.minter, d.minter, other d.minter]) d.id)
  | 8 | 9 => do
      let req ← genReq c s
      -- Mostly a grant that would admit this request, at an argument in its domain; sometimes any grant at all.
      let mine := (liveCaps c).filter fun k => k.slate == s && req.all (fun r => !k.personal || k.holder == r.1)
      let caps ← if mine.isEmpty || (← chance 1 4) then pure [] else pure [← pick mine]
      let arg ← match caps with
        | k :: _ => if (← chance 4 5) then pick k.dom else below 3
        | [] => below 3
      let caps := caps.map (·.id)
      let caps ← if caps.isEmpty || c.caps.isEmpty || (← chance 3 4) then pure caps else pure (caps ++ [(← pick c.caps).id])
      let inputs ← if c.cells.isEmpty || (← chance 1 2) then pure [] else pure [(← pick c.cells).id]
      return some (.admit req s 0 arg caps inputs)
  | 10 | 11 => do
      let live := c.runs.filter (·.live)
      if live.isEmpty || c.caps.isEmpty then return none
      -- Often the step an approval was given for, so that approvals are seen to let an effect go ahead.
      let approved := c.approvals.filter fun ap => live.any (·.id == ap.run)
      if !approved.isEmpty && (← chance 1 2) then
        let ap ← pick approved
        return some (.toolStep ap.run ap.cap)
      let run ← pick (if (← chance 3 4) then live else c.runs)
      let held := run.caps.map (·.1)
      let i ← if held.isEmpty || (← chance 1 6) then pure (← pick c.caps).id else pick held
      return some (.toolStep run.id i)
  | 12 | 20 => do
      -- An approval of one step of a run: mostly the one it is about to take, at its argument, by the grant's holder.
      let runs := c.runs.filter (fun r => r.live && !r.caps.isEmpty)
      if runs.isEmpty then return none
      let run ← pick runs
      let i ← pick (run.caps.map (·.1))
      let holder := ((c.cap i).map (·.holder)).getD 0
      let n := (st.reads run.id).length
      return some (.approve (← pick [holder, holder, other holder]) i run.id (← pick [run.arg, run.arg, run.arg + 1]) (← pick [n, n, n + 1]))
  | 13 => do
      if c.runs.isEmpty || c.cells.isEmpty then return none
      return some (.observe (← pick (runIds c)) (← pick c.cells).id)
  | 14 => do
      if c.runs.isEmpty then return none
      return some (← pick [Ev.write (← pick (runIds c)), Ev.post (← pick (runIds c))])
  | 15 | 16 => do
      if c.runs.isEmpty then return none
      let run ← pick c.runs
      let q ← pick (people ++ [signedOut])
      return some (.release run.id q (← genAcc c run.slate q))
  | 17 => do
      if c.cells.isEmpty then return none
      let cl ← pick c.cells
      let q ← pick (people ++ [signedOut])
      return some (.render cl.id q (← genAcc c cl.slate q))
  | 18 => do
      match ← below 4 with
      | 0 => if c.runs.isEmpty then return none else return some (.finish (← pick (runIds c)))
      | 1 => return some (.editCode (← pick people) s 0 (sl.codeOf 0 + 1))
      | 2 => if c.slates.length > 2 then return none else return some (.fork (← pick (people ++ [signedOut])) s)
      | _ => return some (.publish (← pick [o, other o]) s)
  | _ => return some (.readerCheck (← pick people) (← genTag) (← chance 1 2))

/-- The slate an event names itself, when it does. -/
def slateOf : Ev → Option SlateId
  | .share _ s _ | .collaborate _ s _ _ | .remove _ s _ | .mint _ s _ _ _ _ _ _ | .declassify _ s _ _ _ | .admit _ s _ _ _ _
  | .editCode _ s _ _ | .fork _ s | .publish _ s => some s
  | _ => none

/-- Whether a permitted tool step's effect goes ahead (`Model.effectOk`): none to ask, approved, or waiting. -/
def effectOf (st : St) (r i : Nat) : List (String × Json) :=
  match st.core.run r, st.core.cap i with
  | some run, some k =>
      if !k.effect || run.requester.map (·.1) == some k.holder then [("effect", .str "none")]
      else if effectOk Policy.full st.core run i k run.arg (st.reads r).length then [("effect", .str "goes")]
      else [("effect", .str "waits")]
  | _, _ => []

/-- One step's line: the event, the counter it ran at, and what the model said. A fork's slate is the counter it ran at. -/
def stepJson (st : St) (e : Ev) : Json :=
  let c := st.core
  let ok := permits Policy.full env c e
  let more : List (String × Json) := match e with
    | .render i q _ => match c.cell i with
      | some cl => [("shown", .bool (flows Policy.full c cl.slate cl.label q))]
      | none => []
    | .toolStep r i => if ok then effectOf st r i else []
    | _ => []
  let slate := match slateOf e with
    | some s => [("slate", Json.ofNat s)]
    | none => []
  .obj ([("at", .ofNat c.next), ("event", .obj (match evJson e with | .obj kvs => kvs ++ slate | j => [("ev", j)])), ("ok", .bool ok)] ++ more)

/-- A trace of `len` events from the owner's fresh slate. -/
def genTrace (len : Nat) : Gen (Option Json) := do
  let mut s := init 0
  let mut steps := #[]
  for _ in [0:len] do
    if let some e ← retry 50 (genEv s) then
      steps := steps.push (stepJson s e)
      s := step Policy.full env world s e
  return some (.obj [("steps", .arr steps.toList)])

def fixture : String :=
  fixtureText [("fixture", .str "sharing-traces"), ("model", .str "Kinu.Sharing.Model.permits")]
    (runGen 0x53484152 (casesOf 400 (genTrace 40)))

end Kinu.Refine.SharingCases

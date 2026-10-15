/-
  Kinu.Refine.SharingCases — `lean/fixtures/sharing-traces.json`: generated
  traces of `Kinu.Sharing.Model` events on one slate, each step with whether
  `permits` lets it through under `Policy.full`, and for a render whether the
  cell's label `flows` to its person. `packages/core/tests/refinement-sharing.test.ts`
  replays every trace against `RoomCaretaker` on SQLite and asks it the same.

  The traces keep to the fragment the caretaker builds one for one: three
  signed-in people (`0` the owner), two sources, one function whose code is
  edited (`0`; a show may name function `1`, which never runs), the generated
  arguments `0`–`2`. A grant is only ever taken back, never turned on again, and
  no holder mints a second grant for the same source and function while one is
  live: the caretaker replaces the first. A show is only withdrawn while live.
  `finish` names a run that exists, and the owner never removes themselves.
  Nor does the owner remove someone who still lends or shows anything: the
  room drops that person's grants and shows with them, since they can no
  longer see the sheet to take them back, where the model keeps them live.
  The room is the stricter there; `unit-slate-room.test.ts` holds it.
-/

import Kinu.Sharing.Model
import Kinu.Refine.Json

namespace Kinu.Refine.SharingCases

open Kinu.Sharing.Model
open Kinu.Refine

def people : List Pid := [0, 1, 2]

instance : Inhabited Aud := ⟨.anyone⟩
instance : Inhabited Acc := ⟨.owner⟩
instance : Inhabited Role := ⟨.use⟩
instance : Inhabited Cap := ⟨⟨0, 0, 0, false, 0, 0, 0, [], false, .anyone, 0, false⟩⟩
instance : Inhabited Decl := ⟨⟨0, 0, 0, ⟨0, 0⟩, none, .anyone, false⟩⟩
instance : Inhabited Cell := ⟨⟨0, 0, []⟩⟩
instance : Inhabited Run := ⟨⟨0, 0, 0, none, 0, 0, 0, [], [], false⟩⟩
instance : Inhabited Ev := ⟨.fork 0 0⟩

def env : Env := { signedIn := fun _ => true, code := fun _ _ a _ => a, argOf := fun _ _ a _ => a }

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

def slate0 (c : Core) : Slate := (c.slate 0).getD ⟨0, 0, [], [], false, 0, false, none, []⟩

/-- A way `q` might hold the slate: as its owner, as a member, through the link; current or of an earlier generation. -/
def genAcc (c : Core) (q : Pid) : Gen Acc := do
  let sl := slate0 c
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

/-- One event the fragment allows, drawn with the current state in view; `none` when the draw does not apply. -/
def genEv (c : Core) : Gen (Option Ev) := do
  let sl := slate0 c
  match ← below 19 with
  | 0 => return some (.share (← pick [0, 0, 1]) 0 (← chance 2 3))
  | 1 => return some (.collaborate (← pick [0, 0, 2]) 0 (← pick [1, 2]) (← pick [.edit, .use]))
  | 2 => do
      let q ← pick [1, 2]
      let a ← pick [0, q, 3 - q]
      -- The room drops what the person it removes still lends and shows: the model keeps it (see the header).
      if a == 0 && ((liveCaps c).any (·.holder == q) || c.decls.any (fun d => d.live && d.minter == q)) then return none
      return some (.remove a 0 q)
  | 3 | 4 => do
      let a ← pick people
      let personal ← chance 1 2
      let src ← below 2
      if (liveCaps c).any (fun k => k.holder == a && k.src == src && k.fn == 0 && k.personal == personal) then return none
      return some (.mint a 0 personal src 0 (← pick [[0], [0, 1], [1, 2], [0, 1, 2]]) (← chance 1 3) (← genAud))
  | 5 => do
      let caps := liveCaps c
      if caps.isEmpty then return none
      let k ← pick caps
      return some (.setCap (← pick [k.holder, 0, (k.holder + 1) % 3]) k.id false)
  | 6 => do
      let t ← genTag
      let scope ← pick [none, some (0, [sl.codeOf 0]), some (1, [sl.codeOf 1])]
      return some (.declassify (← pick [t.holder, t.holder, 0]) 0 t scope (← genAud))
  | 7 => do
      let decls := c.decls.filter (·.live)
      if decls.isEmpty then return none
      let d ← pick decls
      return some (.undeclassify (← pick [d.minter, d.minter, (d.minter + 1) % 3]) d.id)
  | 8 | 9 => do
      let req ← if (← chance 1 5) then pure none else do
        let q ← pick people
        pure (some (q, ← genAcc c q))
      let mine := c.caps.filter fun k => req.all (fun r => !k.personal || k.holder == r.1)
      let caps ← if mine.isEmpty || (← chance 1 4) then pure [] else pure [(← pick mine).id]
      let caps ← if caps.isEmpty || c.caps.isEmpty || (← chance 3 4) then pure caps else pure (caps ++ [(← pick c.caps).id])
      let inputs ← if c.cells.isEmpty || (← chance 1 2) then pure [] else pure [(← pick c.cells).id]
      return some (.admit req 0 0 (← below 3) caps inputs)
  | 10 | 11 => do
      if c.runs.isEmpty || c.caps.isEmpty then return none
      let run ← pick c.runs
      let held := run.caps.map (·.1)
      let i ← if held.isEmpty || (← chance 1 6) then pure (← pick c.caps).id else pick held
      return some (.toolStep run.id i)
  | 12 => do
      if c.runs.isEmpty || c.cells.isEmpty then return none
      return some (.observe (← pick (runIds c)) (← pick c.cells).id)
  | 13 => do
      if c.runs.isEmpty then return none
      return some (← pick [Ev.write (← pick (runIds c)), Ev.post (← pick (runIds c))])
  | 14 | 15 => do
      if c.runs.isEmpty then return none
      let q ← pick people
      return some (.release (← pick (runIds c)) q (← genAcc c q))
  | 16 => do
      if c.cells.isEmpty then return none
      let q ← pick people
      return some (.render (← pick c.cells).id q (← genAcc c q))
  | 17 => do
      match ← below 4 with
      | 0 => if c.runs.isEmpty then return none else return some (.finish (← pick (runIds c)))
      | 1 => return some (.editCode (← pick people) 0 0 (sl.codeOf 0 + 1))
      | 2 => return some (.fork (← pick people) 0)
      | _ => return some (.publish (← pick [0, 1]) 0)
  | _ => return some (.readerCheck (← pick people) (← genTag) (← chance 1 2))

/-- One step's line: the event, the counter it ran at, and what the model said. -/
def stepJson (c : Core) (e : Ev) : Json :=
  let ok := permits Policy.full env c e
  let shown : List (String × Json) := match e with
    | .render i q _ => match c.cell i with
      | some cl => [("shown", .bool (flows Policy.full c cl.slate cl.label q))]
      | none => []
    | _ => []
  .obj ([("at", .ofNat c.next), ("event", evJson e), ("ok", .bool ok)] ++ shown)

/-- A trace of `len` events from the owner's fresh slate. -/
def genTrace (len : Nat) : Gen (Option Json) := do
  let mut s := init 0
  let mut steps := #[]
  for _ in [0:len] do
    if let some e ← retry 50 (genEv s.core) then
      steps := steps.push (stepJson s.core e)
      s := step Policy.full env world s e
  return some (.obj [("steps", .arr steps.toList)])

def fixture : String :=
  fixtureText [("fixture", .str "sharing-traces"), ("model", .str "Kinu.Sharing.Model.permits")]
    (runGen 0x53484152 (casesOf 300 (genTrace 30)))

end Kinu.Refine.SharingCases

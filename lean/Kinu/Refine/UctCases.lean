/-
  Kinu.Refine.UctCases — `lean/fixtures/uct-select.json`: tables for which
  `Uct.select`, evaluated in doubles, names the rows `selectNode` may return.
  `packages/core/tests/refinement-uct.test.ts` runs the deployed query on each.
-/

import Kinu.MCTS.Uct
import Kinu.Refine.Json

namespace Kinu.Refine.UctCases

open Kinu
open Kinu.MCTS.Uct
open Kinu.Refine

/-- The score `selectNode` orders by, spelled as its SQL: SQLite's `log` is base 10. -/
def sqlScore (W : Float) (v : Float) (k : Bonus) : Float :=
  v + W * Float.sqrt ((Float.log10 k.arg.toFloat / Float.log10 (Float.exp 1.0)) / k.den.toFloat)

def floatGe (x y : Float) : Bool := decide (y ≤ x)

/-- `explorationWeight`: the shipped `Math.SQRT2`, or a multiple of a quarter. -/
inductive Weight where
  | sqrt2
  | quarters (q : Nat)
  deriving Inhabited

def Weight.value : Weight → Float
  | .sqrt2 => Float.sqrt 2.0
  | .quarters q => q.toFloat / 4.0

def Weight.json : Weight → Json
  | .sqrt2 => .str "sqrt2"
  | .quarters q => .obj [("quarters", .ofNat q)]

def statusName : NodeStatus → String
  | .open_ => "open"
  | .terminal => "terminal"
  | .pruned => "pruned"
  | .failed => "failed"

/-- A generated row; its value is `sixtyFourths / 64`, exact in a double. -/
structure GenRow where
  id : String
  parent : Option String
  root : String
  status : NodeStatus
  depth : Nat
  visits : Nat
  sixtyFourths : Nat
  deriving Inhabited

def GenRow.row (g : GenRow) : Row Float :=
  ⟨g.id, g.parent, g.root, g.status, g.depth, g.visits, g.sixtyFourths.toFloat / 64.0⟩

def GenRow.json (g : GenRow) : Json :=
  .obj [("id", .str g.id), ("parent", .opt Json.str g.parent), ("root", .str g.root),
    ("status", .str (statusName g.status)), ("depth", .ofNat g.depth),
    ("visits", .ofNat g.visits), ("sixtyFourths", .ofNat g.sixtyFourths)]

/-- One tree: a root, then nodes whose parent is an earlier node, or, rarely, an
    id no row carries, which sends the join to its `COALESCE` fallback. -/
def genTree (root : String) : Gen (List GenRow) := do
  let n := (← below 8) + 1
  let mut rows : Array GenRow := #[]
  for i in [0:n] do
    let id := s!"{root}.{i}"
    let (parent, depth) ←
      if i = 0 then pure (none, 0)
      else if ← chance 1 10 then pure (some s!"{root}.gone{i}", (← below 3) + 1)
      else do
        let p := rows.getD (← below i) default
        pure (some p.id, p.depth + 1)
    let status ← if ← chance 3 5 then pure NodeStatus.open_ else pick [.terminal, .pruned, .failed]
    rows := rows.push ⟨id, parent, root, status, depth, ← below 10, ← below 65⟩
  return rows.toList

/-- The same ids under another actor, with other numbers: a join or a filter that
    ignored the actor would read them. -/
def genDecoys (rows : List GenRow) : Gen (List GenRow) := do
  let mut out := #[]
  for r in rows do
    if ← chance 1 2 then
      out := out.push { r with status := .open_, visits := r.visits + 7, sixtyFourths := 64 - r.sixtyFourths }
  return out.toList

/-- Two scores closer than this are a tie the fixture accepts either way; a gap
    between this and `margin` could round either way, so such a table is redrawn. -/
def tie : Float := 1e-12

def margin : Float := 1e-9

/-- The fixture case for a table, or `none` when rounding could decide it. -/
def caseOf (w : Weight) (rootId : String) (maxDepth : Nat) (table decoys : List GenRow) :
    Option Json :=
  let rows := table.map GenRow.row
  let score := sqlScore w.value
  let expected : Option (List String) :=
    match select floatGe score rows rootId maxDepth with
    | none => some []
    | some b =>
      let top := scoreIn score rows b
      let scored := (rows.filter (eligible rootId maxDepth)).map fun r => (r.id, scoreIn score rows r)
      if scored.any (fun (_, s) => s < top - tie && top - margin < s) then none
      else some ((scored.filter fun (_, s) => top - tie ≤ s).map Prod.fst)
  expected.map fun ids =>
    .obj [("weight", w.json), ("rootId", .str rootId), ("maxDepth", .ofNat maxDepth),
      ("rows", .arr (table.map GenRow.json)), ("decoys", .arr (decoys.map GenRow.json)),
      ("selectable", .arr (ids.map Json.str))]

def genCase : Gen (Option Json) := do
  let trees ← pick [["r0"], ["r0", "r1"]]
  let mut table := []
  for t in trees do table := table ++ (← genTree t)
  let rootId ← pick trees
  let maxDepth := (← below 5) + 1
  let w ← if ← chance 1 2 then pure Weight.sqrt2 else pure (Weight.quarters (← pick [0, 2, 4, 6]))
  return caseOf w rootId maxDepth table (← genDecoys table)

/-- Tables built to exercise one theorem each on the deployed query. -/
def directed : List Json :=
  let parent : GenRow := ⟨"r0.0", none, "r0", .terminal, 0, 8, 32⟩
  [ -- `the_more_visited_of_two_equal_siblings_is_never_selected`
    caseOf .sqrt2 "r0" 5
      [parent, ⟨"r0.1", some "r0.0", "r0", .open_, 1, 1, 40⟩, ⟨"r0.2", some "r0.0", "r0", .open_, 1, 3, 40⟩] [],
    -- `unvisited_and_once_visited_tie`
    caseOf .sqrt2 "r0" 5
      [parent, ⟨"r0.1", some "r0.0", "r0", .open_, 1, 0, 40⟩, ⟨"r0.2", some "r0.0", "r0", .open_, 1, 1, 40⟩] [],
    -- `bonus_rises_with_parent_visits`: the child of the busier parent wins
    caseOf .sqrt2 "r0" 5
      [parent, ⟨"r0.1", some "r0.0", "r0", .terminal, 1, 3, 32⟩,
       ⟨"r0.2", some "r0.0", "r0", .terminal, 1, 9, 32⟩,
       ⟨"r0.3", some "r0.1", "r0", .open_, 2, 1, 40⟩, ⟨"r0.4", some "r0.2", "r0", .open_, 2, 1, 40⟩] [],
    -- `select_none_iff`: every open row sits at the depth cap
    caseOf .sqrt2 "r0" 1
      [⟨"r0.0", none, "r0", .terminal, 0, 3, 32⟩, ⟨"r0.1", some "r0.0", "r0", .open_, 1, 1, 64⟩] [] ].filterMap id

def fixture : String :=
  fixtureText [("fixture", .str "uct-select"), ("model", .str "Kinu.MCTS.Uct.select")]
    (directed ++ runGen 0x55435453 (casesOf 200 genCase))

end Kinu.Refine.UctCases

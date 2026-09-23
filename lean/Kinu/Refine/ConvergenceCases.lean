/-
  Kinu.Refine.ConvergenceCases — `lean/fixtures/convergence.json`: trees for which
  `Convergence.IsWinner` and `outcomeOf` say what `converge` answers in plan mode,
  with each row's exact reward sum and count
  (`backprop_accumulates_the_evaluations_through_a_node`).
  `packages/core/tests/refinement-convergence.test.ts` builds each tree with the
  deployed `backpropagate` and runs the deployed `converge`.
-/

import Kinu.MCTS.Convergence
import Kinu.Refine.Json

namespace Kinu.Refine.ConvergenceCases

open Kinu
open Kinu.MCTS.Convergence
open Kinu.Refine

/-- Rewards are eighths: every reward is exact in a double. -/
def scale : Nat := 8

def statusName : NodeStatus → String
  | .open_ => "open"
  | .terminal => "terminal"
  | .pruned => "pruned"
  | .failed => "failed"

def outcomeName : Outcome → String
  | .converged _ => "converged"
  | .undifferentiated _ => "undifferentiated"
  | .noAcceptable _ => "no_acceptable_candidate"

/-- The `value` column `backpropagate` leaves: its running mean, in doubles, in
    evaluation order. -/
def sqlValue (es : List Cand) (n : String) : Float :=
  ((through es n).foldl (fun (acc : Float × Nat) r =>
    ((acc.1 * acc.2.toFloat + r.toNat.toFloat / scale.toFloat) / (acc.2 + 1).toFloat, acc.2 + 1))
    (0.0, 0)).1

/-- What `converge` computes over doubles: the rows first under `value DESC,
    depth DESC`, and each one's outcome with exact double equality. -/
def doubleOutcomes (es : List Cand) (pop : List Member) (minNum minDen : Nat) :
    List (String × String) :=
  let value := fun (m : Member) => sqlValue es m.id
  let top := pop.foldl (fun acc m => if acc < value m then value m else acc) 0.0
  let atTop := pop.filter fun m => value m == top
  let deepest := atTop.foldl (fun acc m => max acc m.depth) 0
  let winners := atTop.filter fun m => m.depth == deepest
  let minValue := minNum.toFloat / minDen.toFloat
  winners.map fun w =>
    let rival := pop.any fun x =>
      x.id != w.id && x.depth != 0 && value x == value w &&
        !((lineage pop w).contains x.id) && !((lineage pop x).contains w.id) &&
        x.text != "" && x.text != w.text
    (w.id, if rival then "undifferentiated" else if value w < minValue then "no_acceptable_candidate"
      else "converged")

def candJson (c : Cand) : Json :=
  .obj [("id", .str c.id), ("path", .arr (c.path.map Json.str)), ("reward", .int c.reward),
    ("status", .str (statusName c.status)), ("text", .str c.text)]

/-- The case, or `none` when rounding in the doubles could change the answer: the
    exact model and the double evaluation must agree on every possible winner and
    its outcome. -/
def caseOf (rootStatus : NodeStatus) (minNum minDen : Nat) (es : List Cand) : Option Json :=
  let pop := population es "R" rootStatus
  let winners := pop.filter fun w => decide (IsWinner pop w)
  let exact := winners.map fun w => (w.id, outcomeName (outcomeOf pop scale minNum minDen w))
  let double := doubleOutcomes es pop minNum minDen
  let kinds := (exact ++ double).map Prod.snd
  let stat := fun (n : String) => Json.obj [("id", .str n), ("sum", .int (through es n).sum),
    ("visits", .ofNat (through es n).length)]
  let emit := fun (k : String) => some (.obj [("rootStatus", .str (statusName rootStatus)),
    ("minAcceptable", .arr [.ofNat minNum, .ofNat minDen]),
    ("candidates", .arr (es.map candJson)),
    ("stats", .arr (stat "R" :: es.map (stat ·.id))),
    ("winners", .arr (exact.map (Json.str ∘ Prod.fst))), ("outcome", .str k)] : Json)
  match kinds with
  | [] => if pop.isEmpty then emit "no_viable_nodes" else none
  | k :: rest =>
    if rest.all (· == k) && (exact.map Prod.fst).all (fun i => (double.map Prod.fst).contains i) &&
        (double.map Prod.fst).all (fun i => (exact.map Prod.fst).contains i) then emit k
    else none

def genCase : Gen (Option Json) := do
  let n := (← below 7) + 1
  let mut es : Array Cand := #[]
  for i in [0:n] do
    let path ←
      if es.size = 0 || (← chance 1 2) then pure ["R"]
      else do
        let p := es.getD (← below es.size) ⟨"", [], 0, .open_, ""⟩
        pure (p.path ++ [p.id])
    let status ← if ← chance 3 4 then pure NodeStatus.open_ else pick [.terminal, .pruned, .failed]
    let reward ← pick [1, 2, 3, 4, 4, 5, 6, 6, 8]
    let text ← pick ["alpha", "beta", "gamma", "delta", "alpha", ""]
    es := es.push ⟨s!"c{i}", path, reward, status, text⟩
  let rootStatus ← if ← chance 4 5 then pure NodeStatus.open_ else pure NodeStatus.pruned
  let (minNum, minDen) ← pick [(3, 10), (1, 2)]
  return caseOf rootStatus minNum minDen es.toList

/-- One tree per theorem the deployed code is checked against. -/
def directed : List Json :=
  [ -- `the_search_expands_its_best_candidate_then_converges_past_it`, in eighths
    caseOf .open_ 3 10
      [⟨"a", ["R"], 7, .open_, "approach a"⟩, ⟨"b", ["R"], 5, .open_, "approach b"⟩,
       ⟨"a1", ["R", "a"], 1, .open_, "refinement a1"⟩, ⟨"a2", ["R", "a"], 1, .open_, "refinement a2"⟩],
    -- `a_unique_best_leaf_is_the_only_winner`
    caseOf .open_ 3 10
      [⟨"a", ["R"], 3, .open_, "approach a"⟩, ⟨"b", ["R"], 6, .open_, "approach b"⟩,
       ⟨"a1", ["R", "a"], 5, .open_, "refinement a1"⟩],
    -- two distinct approaches tied exactly: undifferentiated
    caseOf .open_ 3 10
      [⟨"a", ["R"], 6, .open_, "approach a"⟩, ⟨"b", ["R"], 6, .open_, "approach b"⟩],
    -- `a_pruned_parent_splits_a_lineage`
    caseOf .open_ 3 10
      [⟨"g", ["R"], 4, .open_, "grandparent"⟩, ⟨"p", ["R", "g"], 4, .pruned, "parent"⟩,
       ⟨"c", ["R", "g", "p"], 4, .open_, "grandchild"⟩],
    -- below the bar
    caseOf .open_ 1 2
      [⟨"a", ["R"], 3, .open_, "approach a"⟩, ⟨"b", ["R"], 2, .open_, "approach b"⟩],
    -- the root ties the winner exactly and a pruned parent hides it from the lineage walk,
    -- so only the depth-0 exclusion keeps the root from being a rival
    caseOf .open_ 3 10
      [⟨"g", ["R"], 4, .pruned, "pruned parent"⟩, ⟨"c", ["R", "g"], 4, .open_, "child"⟩],
    -- nothing open or terminal: `converge` throws
    caseOf .pruned 3 10 [⟨"a", ["R"], 3, .failed, "approach a"⟩] ].filterMap id

def fixture : String :=
  fixtureText [("fixture", .str "convergence"), ("model", .str "Kinu.MCTS.Convergence.outcomeOf"),
      ("rewardScale", .ofNat scale)]
    (directed ++ runGen 0x434F4E56 (casesOf 200 genCase))

end Kinu.Refine.ConvergenceCases

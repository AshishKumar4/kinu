/-
  Kinu.Refine.RecordsCases — `lean/fixtures/records.json`: interleavings of runs
  over one records cell, with the verdict `RecordsStore.verdict` gives each
  write and the rows `Concurrent.runC` leaves. One run is the single-run store
  of `RecordsStore.lean`; several are `Concurrent.lean`'s. The deployed
  `recordExploration` answers each step in
  `packages/core/tests/refinement-records.test.ts`.
-/

import Kinu.Exploration.Concurrent
import Kinu.Refine.Json

namespace Kinu.Refine.RecordsCases

open Kinu.Exploration
open Kinu.Exploration.Records
open Kinu.Exploration.RecordsStore
open Kinu.Exploration.Concurrent
open Kinu.Refine

def directionName : Direction → String
  | .minimise => "minimise"
  | .maximise => "maximise"

def verdictName : Outcome → String
  | .recorded => "recorded"
  | .refused .sealed => "sealed"
  | .refused .notBetter => "not-better"

/-- One step and what the model says of it. A write carries its verdict; a breach
    or a clear changes only its own run's seal. -/
def stepJson (d : Direction) (s : Shared) (i : Nat) : StoreAction → Json
  | .write r => .obj [("run", .ofNat i), ("action", .str "write"), ("artifact", .str r.digest),
      ("value", .int r.value),
      ("verdict", .str (verdictName (verdict d { rows := s.rows, pub := s.seals i } r)))]
  | .breach _ => .obj [("run", .ofNat i), ("action", .str "breach")]
  | .clear _ => .obj [("run", .ofNat i), ("action", .str "clear")]

def caseOf (d : Direction) (runs : Nat) (steps : List (Nat × StoreAction)) : Json :=
  let start : Shared := { rows := [], seals := fun _ => .open_ }
  let (_, jsons) := steps.foldl (fun (acc : Shared × Array Json) st =>
    (stepC d acc.1 st.1 st.2, acc.2.push (stepJson d acc.1 st.1 st.2))) (start, #[])
  let final := (runC d start steps).rows
  .obj [("direction", .str (directionName d)), ("runs", .ofNat runs),
    ("steps", .arr jsons.toList),
    ("rows", .arr (final.map fun r => .obj [("artifact", .str r.digest), ("value", .int r.value)]))]

def genStep (runs : Nat) : Gen (Nat × StoreAction) := do
  let i ← below runs
  let k ← below 10
  if k < 7 then
    return (i, .write { digest := ← pick ["a", "b", "c"], value := (← below 12 : Nat) })
  else if k < 9 then return (i, .breach sampleBreach)
  else return (i, .clear sampleRederivation)

def genCase : Gen (Option Json) := do
  let runs := (← below 3) + 1
  let d ← pick [Direction.minimise, .maximise]
  let n := (← below 14) + 1
  let mut steps := #[]
  for _ in [0:n] do steps := steps.push (← genStep runs)
  return some (caseOf d runs steps.toList)

/-- One interleaving per theorem the deployed store is checked against. -/
def directed : List Json :=
  [ -- `a_breach_in_one_run_does_not_seal_another`
    caseOf .minimise 2 [(0, .breach sampleBreach), (1, .write { digest := "b", value := 4 })],
    -- `a_sealed_run_is_invisible_to_every_interleaving`
    caseOf .minimise 2
      [(0, .write { digest := "a", value := 5 }), (1, .breach sampleBreach),
       (1, .write { digest := "a", value := 1 }), (0, .write { digest := "a", value := 3 })],
    -- `a_cleared_seal_records_again`
    caseOf .maximise 1
      [(0, .breach sampleBreach), (0, .write { digest := "a", value := 2 }),
       (0, .clear sampleRederivation), (0, .write { digest := "a", value := 2 })],
    -- `the_tie_rule_is_not_what_makes_it_monotone`: a tie is refused
    caseOf .minimise 1
      [(0, .write { digest := "a", value := 3 }), (0, .write { digest := "a", value := 3 })] ]

def fixture : String :=
  fixtureText [("fixture", .str "records"), ("model", .str "Kinu.Exploration.Concurrent.runC")]
    (directed ++ runGen 0x5245434F (casesOf 200 genCase))

end Kinu.Refine.RecordsCases

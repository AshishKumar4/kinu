/-
  Writes every refinement fixture into the directory named by the first
  argument: `lake env lean --run RefinementFixtures.lean fixtures`.
  `scripts/verify-lean.sh` writes them afresh and fails when `lean/fixtures/`
  differs.
-/

import Kinu.Refine

open Kinu.Refine

def fixtures : List (String × String) :=
  [("uct-select.json", UctCases.fixture),
   ("convergence.json", ConvergenceCases.fixture),
   ("records.json", RecordsCases.fixture),
   ("credential-envelope.json", CredentialCases.fixture),
   ("device-view.json", DeviceViewCases.fixture)]

def main (args : List String) : IO UInt32 := do
  let dir := args.headD "fixtures"
  IO.FS.createDirAll dir
  for (name, text) in fixtures do
    IO.FS.writeFile (dir ++ "/" ++ name) text
  return 0

/-
  Kinu.Refine — the refinement fixtures. Each case module evaluates a model's own
  definitions on generated inputs; `RefinementFixtures.lean` writes the results
  to `lean/fixtures/`, and a TypeScript test runs the deployed code on the same
  inputs.
-/

import Kinu.Refine.Json
import Kinu.Refine.UctCases
import Kinu.Refine.ConvergenceCases
import Kinu.Refine.RecordsCases
import Kinu.Refine.CredentialCases

/-
  Kinu.Refine.CredentialCases — `lean/fixtures/credential-envelope.json`: a row
  sealed by one deployment and opened by another, with what `openStored` over
  the transparent cipher answers. `packages/core/tests/refinement-credentials.test.ts`
  seals and opens the same rows with the deployed AES-GCM `createCredentialCipher`.
-/

import Kinu.Safety.Credentials
import Kinu.Refine.Json

namespace Kinu.Refine.CredentialCases

open Kinu.Safety.Credentials
open Kinu.Refine

def outcomeJson : Except OpenError String → Json
  | .ok p => .obj [("opens", .str p)]
  | .error .noKey => .obj [("refused", .str "no-key")]
  | .error .mismatch => .obj [("refused", .str "mismatch")]
  | .error .notSealed => .obj [("refused", .str "not-sealed")]

/-- The sealing deployment's current key seals `plaintext` under `sealAad`, or the
    row is stored without an envelope; the opening deployment holds `openKeys`,
    current first, and opens under `openAad`. -/
def caseOf (plain : Bool) (sealKey sealAad plaintext : String) (openKeys : List String)
    (openAad : String) : Json :=
  let stored : Stored (String × String × String) :=
    if plain then .plain plaintext else .sealed (transparent.sealAs sealKey sealAad plaintext)
  .obj [("plain", .bool plain), ("sealKey", .str sealKey), ("sealAad", .str sealAad),
    ("plaintext", .str plaintext), ("openKeys", .arr (openKeys.map Json.str)),
    ("openAad", .str openAad), ("outcome", outcomeJson (openStored transparent openKeys openAad stored))]

def keyNames : List String := ["k1", "k2", "k3"]

def genAad : Gen String := do
  let store ← pick ["d1", "d2"]
  if ← chance 1 5 then return mcpAad store (← pick ["s1", "s2"])
  return credentialAad store (← pick ["openai.bearer", "anthropic.bearer", "codex.oauth"])

def genCase : Gen (Option Json) := do
  let sealAad ← genAad
  let openAad ← if ← chance 1 2 then pure sealAad else genAad
  let current ← pick keyNames
  let mut retired := []
  for k in keyNames do
    if k != current && (← chance 1 2) then retired := retired ++ [k]
  let plaintext ← pick ["{\"kind\":\"bearer\",\"token\":\"sk-live-1\"}", "secret two", ""]
  return some (caseOf (← chance 1 6) (← pick keyNames) sealAad plaintext (current :: retired) openAad)

/-- One row per theorem the deployed envelope is checked against. -/
def directed : List Json :=
  let aad := credentialAad "d1" "openai.bearer"
  [ -- `rewrap_keeps_every_readable_secret`: a retired key still opens its rows
    caseOf false "k1" aad "rotated" ["k2", "k1"] aad,
    -- a key the deployment no longer has opens nothing
    caseOf false "k1" aad "orphaned" ["k2"] aad,
    -- `an_envelope_opens_only_where_it_was_sealed`: a row moved to another store
    caseOf false "k1" aad "moved" ["k1"] (credentialAad "d2" "openai.bearer"),
    -- `credential_contexts_never_meet_mcp_contexts`
    caseOf false "k1" (mcpAad "d1" "s1") "mcp headers" ["k1"] aad,
    -- `an_unsealed_row_opens_nowhere`
    caseOf true "k1" aad "plain" ["k2"] (credentialAad "d2" "anthropic.bearer") ]

def fixture : String :=
  fixtureText [("fixture", .str "credential-envelope"),
      ("model", .str "Kinu.Safety.Credentials.openStored")]
    (directed ++ runGen 0x43524544 (casesOf 200 genCase))

end Kinu.Refine.CredentialCases

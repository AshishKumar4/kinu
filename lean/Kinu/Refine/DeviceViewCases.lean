/-
  Kinu.Refine.DeviceViewCases — `lean/fixtures/device-view.json`: trees of
  directories, files and links, relative to one scratch root, and what
  `DeviceView.frameView` makes of each probe's reached path.
  `packages/pc-agent/tests/refinement-device-view.test.js` lays each tree out
  on disk and asks the deployed `viewFor` the same questions. The platform is
  macOS's, so no host mount and no temp remap enters; no probe lies under
  `MAC_DENY_SUBPATHS`, so the model's denied list is empty.
-/

import Kinu.Safety.DeviceView
import Kinu.Refine.Json

namespace Kinu.Refine.DeviceViewCases

open Kinu.Safety.DeviceView
open Kinu.Refine

def accessName : Access → String
  | .invisible => "invisible"
  | .readOnly => "read-only"
  | .writable => "writable"

def pathJson (p : Path) : Json := .arr (p.map Json.str)

/-- Kinu's directory's sibling whose name extends it: `kinu-old` beside `kinu`. -/
def siblingOf (dh : Path) : Path := dh.dropLast ++ [(dh.getLast?.getD "") ++ "-old"]

/-- The frame's workspace; `ws2` is another. -/
def workspace : String := "ws1"

/-- `shared-old` and the `-old` sibling of Kinu's directory share a prefix with a
    root and with Kinu's directory, so a string-prefix `within` would misjudge them. -/
def dirsOf (dh : Path) : List Path :=
  [["owner"], ["shared", "deep"], ["outside"], ["shared-old"], siblingOf dh,
   agentHomeOf dh "ws1", agentTmpOf dh "ws1", agentHomeOf dh "ws2", agentTmpOf dh "ws2"]

def filesOf (dh : Path) : List Path :=
  [deviceJson dh, configJson dh, agentHomeOf dh "ws2" ++ ["notes"],
   agentHomeOf dh "ws1" ++ ["f"], agentTmpOf dh "ws1" ++ ["f"],
   ["shared", "f"], ["shared", "deep", "f"], ["outside", "f"], ["owner", "f"],
   ["shared-old", "f"], siblingOf dh ++ ["f"]]

/-- Paths that do not exist: a syscall reaches them where they are spelled. -/
def freshOf (dh : Path) : List Path :=
  [["shared", "new"], dh ++ ["new"], ["outside", "new"], agentHomeOf dh "ws1" ++ ["new"]]

def linkSitesOf (dh : Path) : List Path :=
  [["shared", "l"], ["shared", "deep", "l"], ["outside", "l"], agentHomeOf dh "ws1" ++ ["l"]]

def linkTargetsOf (dh : Path) : List Path :=
  filesOf dh ++ [dh, agentHomeOf dh "ws2", ["shared"], ["outside"]]

def candidateRoots (dh : Path) : List Path :=
  [["shared"], ["shared", "deep"], ["owner"], dh, dh ++ ["agents"], agentHomeOf dh "ws2", ["outside"], []]

def caseOf (dh : Path) (roots : List Path) (links : List (Path × Path)) : Json :=
  let view := frameView dh workspace roots (.darwin [])
  let probe := fun (requested reached : Path) =>
    Json.obj [("requested", pathJson requested), ("reached", pathJson reached),
      ("access", .str (accessName (view.classify reached)))]
  let probes := (filesOf dh ++ freshOf dh).map (fun p => probe p p) ++ links.map (fun l => probe l.1 l.2)
  .obj [("deviceHome", pathJson dh), ("workspace", .str workspace),
    ("roots", .arr (roots.map pathJson)), ("dirs", .arr ((dirsOf dh ++ roots).map pathJson)),
    ("files", .arr ((filesOf dh).map pathJson)),
    ("links", .arr (links.map fun l => .obj [("at", pathJson l.1), ("to", pathJson l.2)])),
    ("probes", .arr probes)]

def genCase : Gen (Option Json) := do
  let dh : Path ← pick [["kinu"], ["owner", "kinu"]]
  let mut roots : List Path := []
  for r in candidateRoots dh do
    if ← chance 1 4 then roots := roots ++ [r]
  let mut links : List (Path × Path) := []
  for site in linkSitesOf dh do
    if ← chance 1 2 then links := links ++ [(site, ← pick (linkTargetsOf dh))]
  return some (caseOf dh roots links)

/-- One tree per theorem the deployed view is checked against. -/
def directed : List Json :=
  [ -- `kinu_own_directory_is_invisible`: a consented root that IS Kinu's directory
    caseOf ["kinu"] [["kinu"]] [],
    -- ...and one that holds it
    caseOf ["owner", "kinu"] [["owner"]] [],
    -- a link in a consented root reaches the secret where it lands
    caseOf ["kinu"] [["shared"]] [(["shared", "l"], deviceJson ["kinu"])],
    -- `another_workspace_is_invisible`, even consented and even through a link
    caseOf ["kinu"] [agentHomeOf ["kinu"] "ws2"]
      [(agentHomeOf ["kinu"] "ws1" ++ ["l"], agentHomeOf ["kinu"] "ws2" ++ ["notes"])],
    -- `a_sandboxed_write_lands_where_consented`: the whole tree consented
    caseOf ["kinu"] [[]] [(["outside", "l"], configJson ["kinu"])] ]

def fixture : String :=
  fixtureText [("fixture", .str "device-view"), ("model", .str "Kinu.Safety.DeviceView.Sandboxed.classify")]
    (directed ++ runGen 0x44455649 (casesOf 150 genCase))

end Kinu.Refine.DeviceViewCases

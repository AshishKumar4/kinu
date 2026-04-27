-- SelfEvolvingAgent.Primitives
-- Abstract primitive typeclasses for the self-evolving agent.

import SelfEvolvingAgent.Types
import TSLean.DurableObjects.Model
import TSLean.DurableObjects.State

namespace SelfEvolvingAgent

open TSLean TSLean.DO

/-! ## Storage typeclass -/

class Storage (α : Type) where
  readFile   : α → String → Option String
  writeFile  : α → String → String → α
  fileExists : α → String → Bool
  readFile_writeFile : ∀ (s : α) (path content : String),
    readFile (writeFile s path content) path = some content
  readFile_writeFile_other : ∀ (s : α) (path path' content : String),
    path ≠ path' →
    readFile (writeFile s path content) path' = readFile s path'

/-! ## Executor capability -/

/-- Grantable operations: only ToolCall variants via ResolvedProvider. -/
def grantableOps (providers : List ResolvedProvider) : List Op :=
  providers.flatMap (fun p => p.fns.map (fun name => Op.ToolCall p.name name))

theorem grantableOps_only_toolcalls (providers : List ResolvedProvider) :
    ∀ op ∈ grantableOps providers, ∃ ns name, op = Op.ToolCall ns name := by
  intro op hop
  simp [grantableOps, List.mem_flatMap, List.mem_map] at hop
  obtain ⟨p, _, name, _, rfl⟩ := hop
  exact ⟨p.name, name, rfl⟩

/-! ## LLM oracle -/

class LLMOracle (α : Type) where
  score : α → String → String → Float
  score_in_range : ∀ (o : α) (task trajectory : String),
    0 ≤ score o task trajectory ∧ score o task trajectory ≤ 1

/-! ## AgentRuntime -/

structure AgentRuntime where
  craftStore    : List CraftedTool
  taskHistory   : List TaskHistoryEntry
  scaffoldVer   : Nat
  scaffoldCode  : String
  scaffoldHist  : List ScaffoldVersion
  doState       : TSLean.DO.State.DurableObjectState Unit

end SelfEvolvingAgent

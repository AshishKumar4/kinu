/-
  Proteus.Safety.CapabilitySafety
  7 theorems, 0 sorry.
-/

import Proteus.Types

namespace Proteus.Safety.CapabilitySafety

open Proteus

theorem grantableOps_only_toolcalls (providers : List ResolvedProvider) :
    ∀ op ∈ grantableOps providers, ∃ ns name, op = Op.ToolCall ns name := by
  intro op hmem
  simp only [grantableOps, List.flatMap_def, List.mem_flatten] at hmem
  obtain ⟨l, hl, hopmem⟩ := hmem
  simp only [List.mem_map] at hl
  obtain ⟨p, _, rfl⟩ := hl
  simp only [List.mem_map] at hopmem
  obtain ⟨n, _, rfl⟩ := hopmem
  exact ⟨p.ns, n, rfl⟩

private theorem not_toolcall_not_grantable (providers : List ResolvedProvider) (op : Op)
    (h : ∀ ns name, op ≠ Op.ToolCall ns name) : op ∉ grantableOps providers := by
  intro hmem
  have ⟨ns, name, heq⟩ := grantableOps_only_toolcalls providers op hmem
  exact absurd heq (h ns name)

theorem sqlwrite_not_grantable (providers : List ResolvedProvider) :
    Op.SQLWrite ∉ grantableOps providers :=
  not_toolcall_not_grantable providers _ (fun _ _ h => Op.noConfusion h)

theorem sqlread_not_grantable (providers : List ResolvedProvider) :
    Op.SQLRead ∉ grantableOps providers :=
  not_toolcall_not_grantable providers _ (fun _ _ h => Op.noConfusion h)

theorem scaffoldwrite_not_grantable (providers : List ResolvedProvider) :
    Op.ScaffoldWrite ∉ grantableOps providers :=
  not_toolcall_not_grantable providers _ (fun _ _ h => Op.noConfusion h)

theorem spawnsubagent_not_grantable (providers : List ResolvedProvider) :
    Op.SpawnSubAgent ∉ grantableOps providers :=
  not_toolcall_not_grantable providers _ (fun _ _ h => Op.noConfusion h)

theorem networkfetch_not_grantable (providers : List ResolvedProvider) :
    Op.NetworkFetch ∉ grantableOps providers :=
  not_toolcall_not_grantable providers _ (fun _ _ h => Op.noConfusion h)

end Proteus.Safety.CapabilitySafety

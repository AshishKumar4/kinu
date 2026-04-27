-- SelfEvolvingAgent.CapabilitySafety
-- Object-capability security: sandbox can only invoke granted operations.
-- Architecture reference: final-architecture.md §8

import SelfEvolvingAgent.Types
import SelfEvolvingAgent.Primitives

namespace SelfEvolvingAgent.CapSafety

open SelfEvolvingAgent

/-! ## Sandbox capability set -/

def sandboxCaps (providers : List ResolvedProvider) : List Op :=
  grantableOps providers

theorem sandboxCaps_only_toolcall (providers : List ResolvedProvider) :
    ∀ op ∈ sandboxCaps providers, ∃ ns name, op = Op.ToolCall ns name :=
  grantableOps_only_toolcalls providers

/-! ## Privilege separation theorems -/

theorem sqlwrite_not_grantable (providers : List ResolvedProvider) :
    Op.SQLWrite ∉ sandboxCaps providers := by
  intro h
  obtain ⟨_, _, heq⟩ := sandboxCaps_only_toolcall providers Op.SQLWrite h
  exact absurd heq (by simp [Op.ToolCall, Op.SQLWrite])

theorem sqlread_not_grantable (providers : List ResolvedProvider) :
    Op.SQLRead ∉ sandboxCaps providers := by
  intro h
  obtain ⟨_, _, heq⟩ := sandboxCaps_only_toolcall providers Op.SQLRead h
  exact absurd heq (by simp [Op.ToolCall, Op.SQLRead])

theorem scaffoldwrite_not_grantable (providers : List ResolvedProvider) :
    Op.ScaffoldWrite ∉ sandboxCaps providers := by
  intro h
  obtain ⟨_, _, heq⟩ := sandboxCaps_only_toolcall providers Op.ScaffoldWrite h
  exact absurd heq (by simp [Op.ToolCall, Op.ScaffoldWrite])

theorem spawnsubagent_not_grantable (providers : List ResolvedProvider) (cls : String) :
    Op.SpawnSubAgent cls ∉ sandboxCaps providers := by
  intro h
  obtain ⟨_, _, heq⟩ := sandboxCaps_only_toolcall providers (Op.SpawnSubAgent cls) h
  exact absurd heq (by simp [Op.ToolCall, Op.SpawnSubAgent])

theorem networkfetch_not_grantable (providers : List ResolvedProvider) (url : String) :
    Op.NetworkFetch url ∉ sandboxCaps providers := by
  intro h
  obtain ⟨_, _, heq⟩ := sandboxCaps_only_toolcall providers (Op.NetworkFetch url) h
  exact absurd heq (by simp [Op.ToolCall, Op.NetworkFetch])

/-! ## DO storage isolation -/

structure StorageIsolation where
  orchestratorId : String
  branchIds      : List String
  ids_disjoint   : ∀ b ∈ branchIds, b ≠ orchestratorId
  branches_unique : branchIds.Nodup

theorem branch_cannot_modify_orchestrator
    (iso : StorageIsolation) (branchId : String)
    (h : branchId ∈ iso.branchIds) :
    branchId ≠ iso.orchestratorId :=
  iso.ids_disjoint branchId h

end SelfEvolvingAgent.CapSafety

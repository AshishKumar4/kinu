/-
  Kinu.Execution.Capabilities — Capability subsumption and routing correctness.
  Models: packages/core/src/execution/types.ts, router.ts
  0 sorry.
-/

namespace Kinu.Execution.Capabilities

inductive Capability where
  | javascript | typescript | python | nativeBinary
  | shell | npm | git | docker
  | fsShared | fsOwned
  | netOutbound | netInbound
  | processSpawn | processLong | processSignal
  | gpu
  deriving DecidableEq, Repr, BEq

inductive ExecutorKind where
  | workspace | nimbus | container | ssh
  deriving DecidableEq, Repr, BEq

def hasCap : ExecutorKind → Capability → Bool
  | .workspace, .javascript   => true
  | .workspace, .typescript   => true
  | .workspace, .shell        => true
  | .workspace, .fsShared     => true
  | .nimbus, .javascript      => true
  | .nimbus, .typescript      => true
  | .nimbus, .shell           => true
  | .nimbus, .npm             => true
  | .nimbus, .git             => true
  | .nimbus, .fsOwned         => true
  | .nimbus, .netOutbound     => true
  | .nimbus, .netInbound      => true
  | .nimbus, .processSpawn    => true
  | .nimbus, .processLong     => true
  | .container, .javascript   => true
  | .container, .typescript   => true
  | .container, .python       => true
  | .container, .nativeBinary => true
  | .container, .shell        => true
  | .container, .npm          => true
  | .container, .git          => true
  | .container, .fsOwned      => true
  | .container, .netOutbound  => true
  | .container, .netInbound   => true
  | .container, .processSpawn => true
  | .container, .processLong  => true
  | .container, .processSignal => true
  | .ssh, .javascript         => true
  | .ssh, .typescript         => true
  | .ssh, .python             => true
  | .ssh, .nativeBinary       => true
  | .ssh, .shell              => true
  | .ssh, .npm                => true
  | .ssh, .git                => true
  | .ssh, .docker             => true
  | .ssh, .fsOwned            => true
  | .ssh, .netOutbound        => true
  | .ssh, .netInbound         => true
  | .ssh, .processSpawn       => true
  | .ssh, .processLong        => true
  | .ssh, .processSignal      => true
  | .ssh, .gpu                => true
  | _, _                      => false

def subsumes (a b : ExecutorKind) : Prop :=
  ∀ (c : Capability), hasCap b c = true → hasCap a c = true

-- ── Subsumption chain ────────────────────────────────────────────

-- Workspace uses fsShared (DO-local), all others use fsOwned (separate FS).
-- Therefore Nimbus does NOT subsume Workspace (different fs model).
-- The valid subsumption chain is: Container ⊇ Nimbus, SSH ⊇ Container.

private theorem container_subsumes_nimbus_aux (c : Capability) :
    hasCap .nimbus c = true → hasCap .container c = true := by
  cases c <;> decide

theorem container_subsumes_nimbus : subsumes .container .nimbus :=
  container_subsumes_nimbus_aux

private theorem ssh_subsumes_container_aux (c : Capability) :
    hasCap .container c = true → hasCap .ssh c = true := by
  cases c <;> decide

theorem ssh_subsumes_container : subsumes .ssh .container :=
  ssh_subsumes_container_aux

theorem ssh_subsumes_nimbus : subsumes .ssh .nimbus := by
  intro c h; exact ssh_subsumes_container c (container_subsumes_nimbus c h)

-- Workspace is NOT subsumable by the others (fsShared vs fsOwned).
-- This is architecturally correct: workspace shares the DO's filesystem,
-- while nimbus/container/ssh each own separate filesystems.
theorem workspace_incomparable_nimbus :
    ¬ subsumes .nimbus .workspace := by
  intro h
  have := h .fsShared (by decide)
  simp [hasCap] at this

theorem chain :
    subsumes .container .nimbus ∧ subsumes .ssh .container :=
  ⟨container_subsumes_nimbus, ssh_subsumes_container⟩

-- ── Router model ─────────────────────────────────────────────────

structure ExecutorEntry where
  kind : ExecutorKind
  available : Bool
  deriving Repr, BEq

def satisfiesAll (entry : ExecutorEntry) (required : List Capability) : Bool :=
  entry.available && required.all (hasCap entry.kind)

def route (entries : List ExecutorEntry) (required : List Capability) : Option ExecutorEntry :=
  entries.find? (satisfiesAll · required)

-- ── Router correctness (structural) ──────────────────────────────

/-- Any entry returned by route satisfies all required capabilities. -/
theorem route_satisfies_all (entries : List ExecutorEntry) (required : List Capability)
    (e : ExecutorEntry) (h : route entries required = some e) :
    satisfiesAll e required = true := by
  induction entries with
  | nil => simp [route, List.find?] at h
  | cons hd tl ih =>
    simp only [route, List.find?] at h
    split at h
    · injection h with h; rw [← h]; assumption
    · exact ih h

/-- Any entry returned by route is available. -/
theorem route_available (entries : List ExecutorEntry) (required : List Capability)
    (e : ExecutorEntry) (h : route entries required = some e) :
    e.available = true := by
  have hsat := route_satisfies_all entries required e h
  simp only [satisfiesAll, Bool.and_eq_true] at hsat
  exact hsat.1

/-- Any entry returned by route has every required capability. -/
theorem route_has_all_caps (entries : List ExecutorEntry) (required : List Capability)
    (e : ExecutorEntry) (h : route entries required = some e)
    (c : Capability) (hc : c ∈ required) :
    hasCap e.kind c = true := by
  have hsat := route_satisfies_all entries required e h
  simp only [satisfiesAll, Bool.and_eq_true] at hsat
  exact List.all_eq_true.mp hsat.2 c hc

-- ── Subsumption is a preorder ────────────────────────────────────

theorem subsumes_refl (k : ExecutorKind) : subsumes k k := fun _ h => h

theorem subsumes_trans (a b c : ExecutorKind) (hab : subsumes a b) (hbc : subsumes b c) :
    subsumes a c := fun cap hc => hab cap (hbc cap hc)

end Kinu.Execution.Capabilities

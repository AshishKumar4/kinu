/-
  Kinu.Execution.Capabilities — what each shipped executor claims it can do.
  0 sorry, 0 axioms.

  One function per executor constructor, over the inputs that constructor reads:
  `packages/core/src/execution/inline.ts#createInlineExecutor` (the workspace,
  plus its host toolchain), `nimbus.ts#createNimbusWorkspaceExecutor` (the
  workspace with a Nimbus session attached, whose inputs are ports and a runtime
  catalog), `sandbox.ts#createSandboxExecutor`,
  `device-tunnel-executor.ts#createDeviceTunnelExecutor` (what the device's
  toolchain probe found) and `parent.ts#createParentExecutor`. `Capability` and
  `ExecutorKind` are state mirrors of `EXECUTOR_CAPABILITIES` and `ExecutorKind`.

  Every toolchain an executor reads comes from a PATH probe or from the
  workspace's runtime packages, both of which name only `probed` capabilities.
  From that:

  - every executor either owns its files or shares them, never both and never
    neither, and its kind says which (`the_kind_says_who_owns_the_files`);
  - no executor claims `docker` or `gpu`, although both are in the vocabulary
    (`no_executor_claims_docker_or_gpu`), so a requirement for either is never met;
  - attaching a Nimbus session keeps every workspace capability and adds every
    Nimbus capability except owned files (`a_session_extends_the_workspace`).

  The router lists available executors; it does not choose one by required
  capability, so no routing function is modelled.
-/

namespace Kinu.Execution.Capabilities

inductive Capability where
  | javascript | typescript | python | nativeBinary
  | shell | npm | git | docker
  | fsShared | fsOwned
  | netOutbound | netInbound
  | processSpawn | processLong | processSignal
  | gpu
  deriving DecidableEq, Repr

inductive ExecutorKind where
  | workspace | nimbus | sandbox | device | parent
  deriving DecidableEq, Repr

/-- What a PATH probe can settle: the capabilities of `TOOLCHAIN_PROBE`. The
    workspace's runtime packages (`workspaceToolchainCapabilities`) name a subset. -/
def probed : List Capability := [.javascript, .typescript, .python, .npm, .git]

/-- A toolchain as its producers make it: drawn from `probed`. -/
def FromProbe (cs : List Capability) : Prop := ∀ c ∈ cs, c ∈ probed

/-- A Nimbus session's inputs (`createNimbusWorkspaceExecutor`'s options): ports it
    may expose inbound, and a runtime catalog for `python` and native binaries. -/
structure NimbusConfig where
  inbound : Bool
  catalog : Bool
  deriving DecidableEq, Repr

/-- A shipped executor and the inputs its constructor reads. -/
inductive Executor where
  | inline (toolchain : List Capability)
  | nimbusWorkspace (toolchain : List Capability) (config : NimbusConfig)
  | sandbox
  | device (present : List Capability)
  | parent

def Executor.kind : Executor → ExecutorKind
  | .inline _ => .workspace
  | .nimbusWorkspace _ _ => .workspace
  | .sandbox => .sandbox
  | .device _ => .device
  | .parent => .parent

def inlineCaps (toolchain : List Capability) : List Capability :=
  [.javascript, .typescript, .shell, .fsShared] ++ toolchain

def nimbusCaps (config : NimbusConfig) : List Capability :=
  [.javascript, .typescript, .shell, .npm, .git, .fsOwned, .netOutbound] ++
    (if config.inbound then [.netInbound] else []) ++
    [.processSpawn, .processLong, .processSignal] ++
    (if config.catalog then [.python, .nativeBinary] else [])

def sandboxCaps : List Capability :=
  [.javascript, .typescript, .nativeBinary, .shell, .npm, .git, .fsOwned,
   .netOutbound, .netInbound, .processSpawn, .processLong]

/-- `STRUCTURAL`, then what the device's probe found. -/
def deviceCaps (present : List Capability) : List Capability :=
  [.nativeBinary, .shell, .fsOwned, .netOutbound, .processSpawn] ++ present

def Executor.caps : Executor → List Capability
  | .inline toolchain => inlineCaps toolchain
  | .nimbusWorkspace toolchain config =>
    inlineCaps toolchain ++ (nimbusCaps config).filter (· != .fsOwned) ++ [.fsShared]
  | .sandbox => sandboxCaps
  | .device present => deviceCaps present
  | .parent => [.shell, .fsShared]

/-- The toolchain inputs of an executor come from a probe. -/
def Executor.Probed : Executor → Prop
  | .inline toolchain => FromProbe toolchain
  | .nimbusWorkspace toolchain _ => FromProbe toolchain
  | .device present => FromProbe present
  | _ => True

/-- The kinds whose executor shares the workspace's files. -/
def ExecutorKind.sharesFiles : ExecutorKind → Bool
  | .workspace | .parent => true
  | .nimbus | .sandbox | .device => false

private theorem not_probed_of (cs : List Capability) (h : FromProbe cs) (c : Capability)
    (hc : c ∉ probed) : c ∉ cs := fun hm => hc (h c hm)

/-- **The kind says who owns the files.** A workspace or parent executor claims
    shared files and not owned ones; a sandbox or device executor claims owned
    files and not shared ones. -/
theorem the_kind_says_who_owns_the_files (e : Executor) (h : e.Probed) :
    (Capability.fsShared ∈ e.caps ↔ e.kind.sharesFiles = true) ∧
    (Capability.fsOwned ∈ e.caps ↔ e.kind.sharesFiles = false) := by
  have hs : ∀ cs, FromProbe cs → Capability.fsShared ∉ cs := fun cs hcs =>
    not_probed_of cs hcs _ (by decide)
  have ho : ∀ cs, FromProbe cs → Capability.fsOwned ∉ cs := fun cs hcs =>
    not_probed_of cs hcs _ (by decide)
  cases e with
  | inline t =>
    have := ho t h
    simp [Executor.caps, Executor.kind, ExecutorKind.sharesFiles, inlineCaps, this]
  | nimbusWorkspace t n =>
    have := ho t h
    simp [Executor.caps, Executor.kind, ExecutorKind.sharesFiles, inlineCaps, this, List.mem_filter]
  | sandbox => decide
  | device p =>
    have := hs p h
    simp [Executor.caps, Executor.kind, ExecutorKind.sharesFiles, deviceCaps, this]
  | parent => decide

/-- **No executor claims `docker` or `gpu`.** A probe cannot settle either
    (`TOOLCHAIN_UNPROBEABLE`), and no constructor claims them outright. -/
theorem no_executor_claims_docker_or_gpu (e : Executor) (h : e.Probed) :
    Capability.docker ∉ e.caps ∧ Capability.gpu ∉ e.caps := by
  have hd : ∀ cs, FromProbe cs → Capability.docker ∉ cs := fun cs hcs =>
    not_probed_of cs hcs _ (by decide)
  have hg : ∀ cs, FromProbe cs → Capability.gpu ∉ cs := fun cs hcs =>
    not_probed_of cs hcs _ (by decide)
  have hn : ∀ n : NimbusConfig, Capability.docker ∉ nimbusCaps n ∧ Capability.gpu ∉ nimbusCaps n := by
    intro n; cases n with
    | mk i c => cases i <;> cases c <;> decide
  cases e with
  | inline t => simp [Executor.caps, inlineCaps, hd t h, hg t h]
  | nimbusWorkspace t n =>
    simp [Executor.caps, inlineCaps, hd t h, hg t h, List.mem_filter, (hn n).1, (hn n).2]
  | sandbox => decide
  | device p => simp [Executor.caps, deviceCaps, hd p h, hg p h]
  | parent => decide

/-- `a` can do everything `b` can. -/
def Subsumes (a b : Executor) : Prop := ∀ c ∈ b.caps, c ∈ a.caps

theorem subsumes_refl (e : Executor) : Subsumes e e := fun _ h => h

theorem subsumes_trans (a b c : Executor) (hab : Subsumes a b) (hbc : Subsumes b c) :
    Subsumes a c := fun x hx => hab x (hbc x hx)

/-- **A session extends the workspace**: the workspace with a Nimbus session keeps
    every capability of the workspace alone, and gains every Nimbus capability but
    owned files. -/
theorem a_session_extends_the_workspace (t : List Capability) (n : NimbusConfig) :
    Subsumes (.nimbusWorkspace t n) (.inline t) ∧
    ∀ c ∈ nimbusCaps n, c ≠ .fsOwned → c ∈ (Executor.nimbusWorkspace t n).caps := by
  refine ⟨fun c hc => ?_, fun c hc hne => ?_⟩
  · simp only [Executor.caps] at hc ⊢
    exact List.mem_append_left _ (List.mem_append_left _ hc)
  · simp only [Executor.caps]
    exact List.mem_append_left _ (List.mem_append_right _
      (List.mem_filter.mpr ⟨hc, by simpa using hne⟩))

end Kinu.Execution.Capabilities

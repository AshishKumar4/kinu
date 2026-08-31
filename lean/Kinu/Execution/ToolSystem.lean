/-
  Kinu.Execution.ToolSystem — 5-tool architecture formalization.
  Models: orchestrator.ts getTools() — the 5 tools the LLM sees.
  0 sorry.
-/

namespace Kinu.Execution.ToolSystem

/-! ## The 5 tools the LLM sees -/

inductive TopLevelTool where
  | execute_tools  -- codemode sandbox with workspace.*/codemode.* APIs
  | run            -- POSIX shell command with optional executor routing
  | explore        -- MCTS tree search via durable fiber
  | save_note      -- append to MEMORY.md (FTS-indexed)
  | search_memory  -- FTS5 search over long-term memory
  deriving DecidableEq, Repr, BEq

/-! ## Agent actions (what operations the agent can perform) -/

inductive AgentAction where
  | fileRead     : String → AgentAction              -- workspace.readFile
  | fileWrite    : String → String → AgentAction     -- workspace.writeFile
  | shellExec    : String → AgentAction              -- workspace.exec or run
  | memorySearch : String → AgentAction              -- search_memory or workspace.searchMemory
  | memorySave   : String → AgentAction              -- save_note or workspace.saveNote
  | createTool   : String → String → String → AgentAction  -- workspace.createTool
  | listTools    : AgentAction                       -- workspace.listTools
  | mctsExplore  : String → AgentAction              -- explore
  deriving Repr

/-! ## Routing: which tool handles each action -/

def actionTool : AgentAction → TopLevelTool
  | .fileRead _       => .execute_tools    -- workspace.readFile inside codemode
  | .fileWrite _ _    => .execute_tools    -- workspace.writeFile inside codemode
  | .shellExec _      => .run              -- direct shell command
  | .memorySearch _   => .search_memory    -- direct memory search
  | .memorySave _     => .save_note        -- direct memory save
  | .createTool _ _ _ => .execute_tools    -- workspace.createTool inside codemode
  | .listTools        => .execute_tools    -- workspace.listTools inside codemode
  | .mctsExplore _    => .explore          -- MCTS fiber

/-! ## Completeness: every action maps to exactly one of the 5 tools -/

theorem action_routes_to_valid_tool (a : AgentAction) :
    actionTool a = .execute_tools ∨ actionTool a = .run ∨
    actionTool a = .explore ∨ actionTool a = .save_note ∨
    actionTool a = .search_memory := by
  cases a <;> simp [actionTool]

/-- MCTS is the only action that uses explore. -/
theorem only_mcts_uses_explore (a : AgentAction) (h : actionTool a = .explore) :
    ∃ task, a = .mctsExplore task := by
  cases a <;> simp [actionTool] at h
  case mctsExplore task => exact ⟨task, rfl⟩

/-- Shell commands use the run tool. -/
theorem shell_uses_run (cmd : String) :
    actionTool (.shellExec cmd) = .run := by
  simp [actionTool]

/-- Memory search uses search_memory. -/
theorem memory_search_uses_search (query : String) :
    actionTool (.memorySearch query) = .search_memory := by
  simp [actionTool]

/-- Memory save uses save_note. -/
theorem memory_save_uses_note (content : String) :
    actionTool (.memorySave content) = .save_note := by
  simp [actionTool]

/-- File operations use execute_tools (codemode sandbox). -/
theorem file_ops_use_codemode (path : String) :
    actionTool (.fileRead path) = .execute_tools := by
  simp [actionTool]

-- ── Sandbox namespace isolation ──────────────────────────────────

inductive SandboxNamespace where
  | workspace | nimbus | sandbox | laptop
  deriving DecidableEq, Repr, BEq

structure SandboxCall where
  ns     : SandboxNamespace
  method : String
  deriving Repr, BEq

def craftedToolIsolated (calls : List SandboxCall) : Prop :=
  ∀ c ∈ calls, c.ns = .workspace

theorem empty_is_isolated : craftedToolIsolated [] := by
  intro c hc; exact absurd hc (List.not_mem_nil c)

theorem append_workspace_preserves (calls : List SandboxCall) (method : String)
    (h : craftedToolIsolated calls) :
    craftedToolIsolated (calls ++ [{ ns := .workspace, method }]) := by
  intro c hc
  rw [List.mem_append] at hc
  rcases hc with hc | hc
  · exact h c hc
  · simp [List.mem_singleton] at hc; rw [hc]

end Kinu.Execution.ToolSystem

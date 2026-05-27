/**
 * Canonical tool registry — the single source of truth for Proteus's built-in
 * tool names and descriptions. Consumed by:
 *   - tools/builtins.ts      (factory for the 5-tool ToolSet)
 *   - evolution/engine.ts    (crafted-tool filter — BUILT_IN_TOOL_NAMES)
 *   - cf-backend/orchestrator.ts  (getToolList, getToolDescriptions, beforeTurn)
 *   - cli surfaces           (chat-loop, tui)
 *
 * Changing any name here is a breaking change to prompts, UI, and MCTS scoring.
 */

export const BUILTIN_TOOLS = [
  'execute_tools',
  'run',
  'explore',
  'split_heads',
  'think',
  'save_note',
  'search_memory',
  'remember_fact',
  'recall_fact',
  'forget_fact',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/**
 * Session-scoped tools contributed by Think via `configureSession()` — not
 * part of the agent's learned capability surface, but active during a turn.
 */
export const SESSION_TOOLS = ['set_context', 'load_context', 'search_context'] as const;

/** Whitelist applied in beforeTurn() on the CF backend. */
export const ACTIVE_TOOLS = [...BUILTIN_TOOLS, ...SESSION_TOOLS] as const;

/** Set form for O(1) membership checks in hot paths (e.g. craft score filter). */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

/**
 * Canonical descriptions. These are what the LLM sees as tool docstrings and
 * what the UI shows in the Tools tab.
 *
 * Namespace contract (preamble-injection pattern — see docs/CRAFT-ARCHITECTURE.md):
 *   - `workspace.*` — filesystem / shell / memory primitives.
 *   - `codemode.*` — every provider exposed via createCodeTool, including
 *     crafted tools once they have been type-declared at construction time.
 *   - `tools.<name>` — crafted tools are ALSO reachable as local object
 *     properties inside the execute_tools async arrow, injected by the
 *     preamble. Crafted-tool bodies may call `workspace.*`, `codemode.*`,
 *     and `tools.<other>` interchangeably.
 */
export const BUILTIN_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> = {
  execute_tools:
    'Write JS to accomplish tasks. workspace.* for local VFS/shell. sandbox.* for a real Linux ' +
    'container — use this for npm/pip/dev servers and ANY process that listens on a port. ' +
    'codemode.* exposes learned patterns. After starting a dev server in the sandbox, call ' +
    'sandbox.exposePort(port) so the user can SEE the running app — the returned URL renders ' +
    'as a live iframe in the chat and on the Executors tab. Agent-crafted tools are reachable ' +
    'as tools.<name>(args) and their bodies may call workspace.*, sandbox.*, codemode.*, ' +
    'tools.* freely. Runs in sandboxed Worker.',
  run: 'Run a POSIX shell command (cat, grep, find, sed, ls, etc.). Pipes and redirects work. Optional executor param routes to nimbus/sandbox/laptop.',
  explore:
    'MCTS tree search — direct engine call. Prefer think({strategy: "mcts", ...}); ' +
    'this tool is kept for back-compat and parity with the bare runMCTS engine.',
  split_heads:
    'Parallel heads — direct controller call. Prefer think({strategy: "heads", ...}); ' +
    'use this tool when you need per-head model overrides or custom merge strategies ' +
    'not exposed by think(). 2-6 heads, each with its own scratch, merged via LLM ' +
    'synthesis. Heads may recursively split under a depth budget (default 3).',
  think:
    'Unified exploration dispatcher. Pick a registered strategy by id and run it. ' +
    'Available strategies today: "single-shot" (one LLM call, baseline), "mcts" ' +
    '(tree search with parallel rollouts), "heads" (parallel reasoning streams + ' +
    'LLM merge). Pick the cheapest strategy that fits the task — single-shot for ' +
    'simple questions, mcts for multi-step planning where the right approach is ' +
    'not obvious, heads when sub-questions are known upfront.',
  save_note:
    'Save a note to long-term memory (memory/MEMORY.md). FTS-indexed so future turns can retrieve it via search_memory.',
  search_memory:
    'Full-text search over long-term memory. Returns matching passages with scores.',
  remember_fact:
    "Upsert a typed fact into the agent's world model (idempotent, keyed). Use this when a value " +
    "is going to be referenced again across turns: user preferences, project state, dates, names, " +
    "URLs, current configuration. Value may be any JSON. Beats save_note for re-readable state.",
  recall_fact:
    'Read a previously remembered fact by key. Returns null if not set. Top-recent facts are ' +
    'auto-surfaced in your system prompt — recall_fact is for explicit lookups by key.',
  forget_fact:
    'Delete a fact from the world model. Use when state becomes stale or wrong.',
};

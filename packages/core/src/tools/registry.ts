/**
 * Canonical tool registry — the single source of truth for Proteus's built-in
 * tool names and descriptions. Consumed by:
 *   - tools/builtins.ts      (factory for the built-in ToolSet)
 *   - evolution/engine.ts    (crafted-tool filter — BUILT_IN_TOOL_NAMES)
 *   - cf-backend/orchestrator.ts  (getToolList, getToolDescriptions, beforeTurn)
 *   - cli surfaces           (chat-loop, tui)
 *
 * Changing any name here is a breaking change to prompts, UI, and MCTS scoring.
 */

export const BUILTIN_TOOLS = [
  'execute_tools',
  'run',
  'skills',
  'think',
  'memory',
  'fact',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/** Whitelist applied in beforeTurn() on the CF backend. */
export const ACTIVE_TOOLS = [...BUILTIN_TOOLS] as const;

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
    'as a live iframe in the chat and on the Executors tab. agent.* steers YOURSELF: ' +
    'agent.proposeCurriculum/acceptCurriculumTask (self-improvement tasks) and ' +
    'agent.schedule({cron|atMs}) to wake yourself for a future autonomous turn. Agent-crafted ' +
    'tools are reachable as tools.<name>(args) and their bodies may call workspace.*, sandbox.*, ' +
    'codemode.*, tools.* freely. Runs in sandboxed Worker.',
  run:
    'Run a shell command. Pipes, redirects, env vars all work. The `runtime` ' +
    'parameter chooses where it runs: "workspace" (default — the agent\'s own ' +
    'VFS-backed virtual shell, no external resources), "nimbus" (lightweight DO ' +
    'sandbox, good for most one-shot tasks), "sandbox" (full Cloudflare Sandbox ' +
    'with a real Linux userland, needed for long-running servers and heavy ' +
    'installs), or "laptop" (the user\'s own machine via the PC daemon, only ' +
    'available once the user has installed it). If you need a runtime that ' +
    'isn\'t provisioned yet, just call execute with the runtime you want — the ' +
    'UI will surface the install card to the user.',
  skills:
    'Workflow skills — Claude-Code / Hermes-compatible SKILL.md files that ' +
    'restrict your tool surface and inject task-specific instructions. One ' +
    'tool, six actions: list (catalogue), read (one skill\'s body), invoke ' +
    '(activate for this turn), create / edit / delete (CRUD on VFS-stored ' +
    'skills). Skills live at /workspace/skills/<name>.md. Invoke when the ' +
    'user asks for a workflow you\'ve previously codified or one of the ' +
    'built-in skills (e.g. /audit-implementation) applies.',
  think:
    'Spawn deeper reasoning / parallel sub-agents. Pick a strategy by id: ' +
    '"single-shot" (one LLM call, baseline); "mcts" (parallel tree-search rollouts ' +
    'over candidate approaches — multi-step planning where the right path is not ' +
    'obvious); "heads" (spawn 2–6 INDEPENDENT sub-agents that run concurrently — each ' +
    'runs its own multi-step agentic loop with shell + sandbox + tool access, ' +
    'optionally a different model per head, recursing to depth 3 — findings merged ' +
    'via structured synthesis). Use heads to delegate 3+ independent subtasks at once; use mcts to ' +
    'search a hard decision. Pick the cheapest strategy that fits.',
  memory:
    'Long-term prose memory (memory/MEMORY.md, FTS-indexed). One tool, two actions: ' +
    '"save" (append a note for future turns to retrieve) and "search" (full-text ' +
    'lookup, returns matching passages with scores). For keyed/typed state that ' +
    'you\'ll reference by name, prefer `fact` instead.',
  fact:
    "The agent's typed, keyed world model — idempotent facts you reference across " +
    'turns (user preferences, project state, dates, names, URLs, configuration). ' +
    'One tool, three actions: "remember" (upsert key→value, value is any JSON, ' +
    'optional confidence), "recall" (read by key; top-recent facts are also ' +
    'auto-surfaced in your system prompt), "forget" (delete a stale/wrong fact).',
};

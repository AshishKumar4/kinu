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
  'web_search',
  'web_fetch',
  'product_change',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/** Whitelist applied in beforeTurn() on the CF backend. */
export const ACTIVE_TOOLS = [...BUILTIN_TOOLS] as const;

/** Set form for O(1) membership checks in hot paths (e.g. craft score filter). */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

export interface BuiltinToolSpec {
  name: BuiltinToolName;
  summary: string;
  whenToUse: string;
  whenNotToUse: string;
  result: string;
}

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
export const BUILTIN_TOOL_SPECS: Record<BuiltinToolName, BuiltinToolSpec> = {
  execute_tools: {
    name: 'execute_tools',
    // llm.query is deliberately NOT here — it exists only on the CF backend,
    // so the prompt advertises it via a backend-gated line instead.
    summary:
      'Run JavaScript against active executor namespaces, codemode.* providers, tools.<name> crafted tools, and agent helpers.',
    whenToUse: 'Use for multi-step logic, file operations, crafted tool calls, scheduling, and operations that need shared state.',
    whenNotToUse: 'Do not use for a single shell command when `run` is enough.',
    result: 'Returns a structured execution result or error object from the codemode runtime.',
  },
  run: {
    name: 'run',
    summary: 'Run one shell command in one explicitly selected available runtime.',
    whenToUse: 'Use for a direct command in the same runtime where its files and dependencies live.',
    whenNotToUse: 'Do not use for multi-step logic, cross-runtime file access, or a runtime that is not explicitly listed as available.',
    result: 'Returns stdout, an exit-code error, or a structured runtime_not_provisioned error.',
  },
  skills: {
    name: 'skills',
    summary: 'List, read, invoke, create, edit, or delete SKILL.md workflow instructions stored for this agent.',
    whenToUse: 'Use only when a reusable workflow is needed or the user explicitly invokes a skill.',
    whenNotToUse: 'Do not load broad skills speculatively; they consume context and can over-constrain unrelated work.',
    result: 'Returns skill metadata, skill content, or mutation status.',
  },
  // The think spec below is the SINGLE SOURCE of strategy doctrine — the think
  // tool's docstring, the UI, AND the system prompt's Research section all
  // render `whenToUse` from here (the docstring appends only the live
  // advertised-strategy ids; the prompt prefixes the fan-out workflow). Keep
  // the two strategy triggers (heads vs mcts) intact when editing.
  think: {
    name: 'think',
    summary: 'Run a deeper reasoning strategy: heads (parallel sub-agents) or mcts (approach search).',
    whenToUse:
      'heads = ≥2 independent sub-questions, each running its own multi-step tool loop concurrently (web_search/web_fetch/exec); takes minutes, may auto-background. ' +
      'mcts = compare competing approaches scored by execution when the right path is genuinely unclear — branches score TEXT/code and do NOT run your tool loop, but proposed code is executed when scored.',
    whenNotToUse: 'Neither is for linear work you can simply do directly, nor when branches would race on the same mutable resource.',
    result: 'Returns a strategy result with branch/head outputs, scores, and selected work.',
  },
  memory: {
    name: 'memory',
    // The sessions mode contract (query searches, around_message_id scrolls,
    // neither browses) lives ONLY in the input-schema property descriptions.
    summary: 'Save or search durable prose memory, or recall past session transcripts (action=sessions).',
    whenToUse: 'Use for compact, durable lessons or notes that should survive future turns, and to search what past sessions actually said before re-deriving context.',
    whenNotToUse: 'Do not store keyed state, temporary task progress, stale logs, or facts that should be updated by name.',
    result: 'Returns save status, search hits, or session transcript slices.',
  },
  fact: {
    name: 'fact',
    summary: 'Remember, recall, or forget typed keyed facts such as preferences, project state, URLs, dates, and configuration.',
    whenToUse: 'Use for named durable state that should be recalled or updated precisely.',
    whenNotToUse: 'Do not use for long prose notes; use memory for those.',
    result: 'Returns fact mutation status or recalled fact values.',
  },
  web_search: {
    name: 'web_search',
    summary: 'Search the live web and return ranked results (title, url, snippet, date).',
    whenToUse:
      'Use to research a topic, find current or post-training-cutoff information, locate documentation/sources, or discover URLs to fetch. Loop it (call again with refined queries) for thorough research.',
    whenNotToUse: 'Do not use when you already have the URL — call web_fetch directly. Do not use for facts you already know.',
    result: 'Returns up to ~5 ranked results, each with title, url, snippet, and a freshness date when available (plus a synthesized answer when a Tavily key is connected).',
  },
  web_fetch: {
    name: 'web_fetch',
    summary: 'Fetch one URL and return its content as clean, citation-ready markdown.',
    whenToUse: 'Use to read a specific page (a web_search hit, a doc, an article) after you have its URL.',
    whenNotToUse: 'Do not use to discover pages — that is web_search. Do not fetch private/internal addresses; they are blocked.',
    result: 'Returns the page title, retrieval timestamp, and markdown; oversized pages are saved to the workspace VFS and clamped to a head you can re-read.',
  },
  product_change: {
    name: 'product_change',
    summary: 'Governed lane for changing the Proteus product/UI itself.',
    whenToUse: 'Use when the user asks Proteus to modify its own app, UI, prompts, deployment, or product behavior.',
    whenNotToUse: 'Do not use for ordinary user project work outside the Proteus product.',
    result: 'Returns source binding, plan/check/preview/approval/deployment, or rollback metadata.',
  },
};

/** Render a spec into the JSON-schema tool docstring. Providers weight the
 *  schema `description` most for tool selection, so the when-to-use doctrine
 *  ships here — the system prompt carries only the one-line summary. */
export function renderToolSchemaDescription(spec: BuiltinToolSpec): string {
  return [
    spec.summary,
    `Use when: ${spec.whenToUse}`,
    `Avoid when: ${spec.whenNotToUse}`,
    `Returns: ${spec.result}`,
  ].join('\n');
}

export const BUILTIN_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> =
  Object.fromEntries(
    BUILTIN_TOOLS.map((name) => [name, renderToolSchemaDescription(BUILTIN_TOOL_SPECS[name])]),
  ) as Record<BuiltinToolName, string>;

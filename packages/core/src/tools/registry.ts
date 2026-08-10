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
  'agents',
  'memory',
  'experience',
  'web',
  'report',
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
  /** A standing fact about the tool's environment that changes how a call
   *  should be written — not when to reach for it. Optional: most tools have
   *  none, and inventing one per tool is prompt bloat. */
  doctrine?: string;
  result: string;
}

// ── Delegation doctrine (single source) ─────────────────────────────────────
// The `agents` tool is ONE ladder keyed on LIFETIME: fork = an ephemeral fork
// that merges back this turn, staff = a persistent subordinate that outlives
// it, ask/send = talking to what already exists. Both the tool docstring and
// the system prompt's Delegation section render these rungs verbatim, so
// editing them here is the only place delegation doctrine changes. mcts is a
// settle policy inside the fork rung — reachable and fully functional, never
// a third rung.

/** Every action the `agents` tool can expose. Which ones a given actor
 *  actually gets is decided by the deps its backend wires — see
 *  agentsActionsFor in tools/agents-tool.ts. */
export const AGENTS_TOOL_ACTIONS = [
  'fork', 'staff', 'ask', 'send', 'reply', 'list', 'dismiss',
] as const;

export type AgentsToolAction = (typeof AGENTS_TOOL_ACTIONS)[number];

/** The one question the ladder asks. Prefixes the doctrine in both surfaces. */
export const DELEGATION_FRAME =
  'One delegation ladder keyed on how long the helper needs to live.';

/** The two spawn rungs of the delegation ladder, rendered verbatim in both
 *  the `agents` docstring and the prompt's Delegation section. */
export const DELEGATION_RUNGS = {
  fork:
    'Fork (action=fork) on two triggers. Breadth: work splits into 2+ independent angles you would otherwise grind through one-by-one — research sweeps, pre-implementation investigation, reviewing or verifying separate components in parallel. ' +
    'Doubt: your first attempt failed, two approaches are both plausible, the step ahead is expensive to undo, or you cannot check your own output — being unsure is a reason to fork, not a reason to push on alone. ' +
    'Each fork is you on the same workspace, files and sandbox, running its own multi-step tool loop concurrently (web search/fetch, exec), then merging back and disappearing; takes minutes, may auto-background. ' +
    'Leave settle unset to merge the forks back into this turn; set settle=mcts to have them scored against each other by execution instead — how you pick between competing approaches, and the right settle for rival scripts that must produce a specific artifact, since each branch\'s proposed code IS executed to earn its score. mcts branches propose text/code rather than running your own tool loop.',
  staff:
    'Staff a subordinate (action=staff) whenever the work must outlive this turn — the user asks for several fixes or features at once, or a long-running effort — creating one subordinate per independent workstream and running them in parallel. ' +
    'A subordinate keeps its own context across turns and stays in your roster: hand it work with ask, steer it with send, read the roster with list. ' +
    'A finished subordinate reports and STAYS, resumable with its context intact — dismiss only a subordinate whose role is permanently over.',
} as const;

/** How ask/send/reply address existing agents — the converse half of the
 *  `agents` docstring. */
export const DELEGATION_CONVERSE =
  'ask/send message any agent by name — a subordinate in this workspace or one of the owner\'s other workspace agents (ask expects the answer back, send is fire-and-forget); ' +
  'reply answers an incoming agent message event by its event_id; staff scope=workspace creates a specialist workspace of its own. ' +
  // The delivery contract, stated because it changes how to delegate: there is
  // no waiting for a helper to free up, and no reason to hold work back.
  'A busy agent is never blocked on — your message is spliced into the turn it is already running, so send follow-ups as soon as you have them.';

// ── Durable-state doctrine (single source) ──────────────────────────────────
// `memory` is ONE tool because it is one concept — state this agent writes down
// now and reads back in a later turn. Prose notes and keyed facts are two
// storage shapes of that concept, not two decisions the model should have to
// make between tools, so they are actions inside it. The keyed-fact actions
// exist only where a FactsStore is wired, and the docstring is composed from
// the same gate, so it never advertises an action the runtime cannot perform.

/** Always present: the memory plane is `rt.memory` plus the canonical
 *  messages table, which every runtime has. */
export const MEMORY_NOTE_ACTIONS = ['save', 'search', 'sessions'] as const;

/** Present only where a FactsStore is wired. */
export const MEMORY_FACT_ACTIONS = ['remember', 'recall', 'forget'] as const;

export type MemoryToolAction =
  | (typeof MEMORY_NOTE_ACTIONS)[number]
  | (typeof MEMORY_FACT_ACTIONS)[number];

/**
 * The durable-state spec for a runtime that does (or does not) wire facts.
 * `BUILTIN_TOOL_SPECS.memory` is the full surface; buildBuiltinTools renders
 * the gated one when no FactsStore is supplied.
 */
export function memoryToolSpec(hasFacts: boolean): BuiltinToolSpec {
  // The sessions mode contract (query searches, around_message_id scrolls,
  // neither browses) lives ONLY in the input-schema property descriptions.
  return {
    name: 'memory',
    summary: hasFacts
      ? 'Durable state you read back in a later turn: keyed facts, prose notes, past session transcripts.'
      : 'Durable state you read back in a later turn: prose notes, past session transcripts.',
    whenToUse:
      'Use for anything that must outlive this turn. '
      + (hasFacts
        ? 'remember/recall/forget name state you look up precisely — preferences, project state, URLs, configuration, dates, decisions; update a stale key rather than adding a contradictory second fact. '
        : '')
      + 'save/search hold a lesson or note too long to be a value; sessions reads what past sessions said, before re-deriving context you already have.',
    whenNotToUse: 'Do not store temporary task progress, stale logs, or anything this turn already carries.',
    result: hasFacts
      ? 'Returns save or fact-mutation status, recalled fact values, note search hits, or session transcript slices.'
      : 'Returns save status, note search hits, or session transcript slices.',
  };
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
 *   - `agents.*` — the delegation tool projected into the sandbox, gated to the
 *     same actions (tools/agents-codemode.ts). It is what makes a crafted tool
 *     able to BE a workflow: plain control flow over delegated steps.
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
    // The recurring mental-model error: models read `workspace.*` as the
    // machine's filesystem and call workspace.readdir('/app') on a container
    // path, which cannot resolve. Stating what the namespace IS is what stops
    // the whole class, not a better error on the tenth attempt.
    doctrine:
      'workspace.* is the agent\'s OWN virtual filesystem, not the filesystem of the machine or container this agent runs on — a container path such as /app is not reachable through it. '
      + 'Read and write files that live on a real machine or container by running a shell command there with the `run` tool, in the runtime that owns them.',
    result: 'Returns a structured execution result or error object from the codemode runtime.',
  },
  run: {
    name: 'run',
    summary: 'Run one shell command in one explicitly selected available runtime.',
    whenToUse: 'Use for a direct command in the same runtime where its files and dependencies live.',
    whenNotToUse: 'Do not use for multi-step logic, cross-runtime file access, or a runtime that is not explicitly listed as available.',
    // The caffe OOM: `nproc` inside a 1-CPU/2GB cgroup reports the HOST's
    // cores, so `make -j$(nproc)` forked 32 compilers into 2GB. The live
    // execution-status block carries the measured cpus/mem when the runtime
    // declares them; this is the sentence that tells the model to use them.
    doctrine:
      'Inside a container `nproc`, `/proc/cpuinfo` and `free` report the HOST, not your cgroup — sizing `-j` or worker counts from them will OOM the job. When the execution status lists cpus/mem for a runtime, those are the real limits: size parallelism from them.',
    result: 'Returns the command output — both streams, labelled when both wrote — prefixed with the exit code when it is non-zero, or a structured runtime_not_provisioned error.',
  },
  skills: {
    name: 'skills',
    summary: 'List, read, invoke, create, edit, or delete SKILL.md workflow instructions stored for this agent.',
    whenToUse: 'Use only when a reusable workflow is needed or the user explicitly invokes a skill.',
    whenNotToUse: 'Do not load broad skills speculatively; they consume context and can over-constrain unrelated work.',
    result: 'Returns skill metadata, skill content, or mutation status.',
  },
  // The agents spec is the SINGLE SOURCE of delegation doctrine: it composes
  // the DELEGATION_RUNGS + DELEGATION_CONVERSE constants above, which the
  // system prompt's Delegation section also renders verbatim (the tool
  // docstring appends only the live action list per backend).
  agents: {
    name: 'agents',
    summary:
      "Spawn and talk to helper agents: ephemeral forks of yourself, persistent subordinates in this workspace, and the owner's other workspace agents.",
    whenToUse:
      `${DELEGATION_FRAME} ${DELEGATION_RUNGS.fork} ${DELEGATION_RUNGS.staff} ${DELEGATION_CONVERSE}`,
    whenNotToUse:
      'Do not delegate a single short coherent change you can simply do directly, or forks that would race on the same mutable resource. Caution: every subordinate or peer message wakes that agent for a full turn, so send purposeful work.',
    result:
      'fork returns the merged (or mcts-scored) answer with per-fork outputs; staff/dismiss return roster state. '
      + 'ask/send return event_id plus delivery (steering_live_turn = spliced into the turn it is running, starts_now = it was idle, queued = already waiting) '
      + 'and subordinate_phase (what it was doing) — subordinate reports and peer replies then arrive as events that wake you, citing that event_id.',
  },
  memory: memoryToolSpec(true),
  experience: {
    name: 'experience',
    summary:
      "Share and reuse proven experience — crafted tools, corroborated lessons, and confident facts — across the owner's workspaces.",
    whenToUse:
      'Search it before grinding out something another of the owner\'s workspaces has already solved, and import what fits — an import comes back inline, ready to use in this same turn. '
      + 'Publish back what THIS workspace has proven, so the owner\'s other agents inherit it.',
    whenNotToUse:
      'Do not publish unproven work — a craft with no real uses, a provisional lesson, or a low-confidence fact is refused. Do not import speculatively: an import that does not survive this turn\'s outcome is discarded.',
    result:
      'search returns hits with their source workspace and the evidence that earned them; import returns the payload inline, staged provisional until this turn is accepted; publish returns what was shared, or what qualifies.',
  },
  web: {
    name: 'web',
    summary: 'Live web access: action=search returns ranked results (title, url, snippet, date); action=fetch returns one URL as clean, citation-ready markdown.',
    whenToUse:
      'Use for current or post-training-cutoff information, documentation and sources. Search to discover URLs, then fetch the promising ones to actually read them, looping with refined queries until the question is answered; go straight to fetch when you already have the URL.',
    whenNotToUse: 'Do not use for things you already know. Do not fetch private or internal addresses; they are blocked.',
    result:
      'search returns up to ~5 ranked results, each with title, url, snippet, and a freshness date when available (plus a synthesized answer when a Tavily key is connected). '
      + 'fetch returns the page title, retrieval timestamp, and markdown; oversized pages are saved to the workspace VFS and clamped to a head — re-read the file, or slice it and llm.query each slice inside execute_tools.',
  },
  report: {
    name: 'report',
    summary: 'Report progress, completion, or a blocker on your current assignment to the workspace orchestrator.',
    whenToUse:
      'Use at meaningful milestones: your assignment is done (status=completed), you are blocked and need input (status=blocked), or a significant mid-task update is worth surfacing (status=progress).',
    whenNotToUse: 'Do not report per-step noise — the answer of an assigned turn is relayed to the orchestrator automatically at turn end.',
    result: 'Returns delivery confirmation; the report reaches the orchestrator as a background event that wakes it.',
  },
  product_change: {
    name: 'product_change',
    summary: 'Governed lane for changing the Proteus product/UI itself — plan, then apply/check/preview/deploy/rollback the change for real in the sandbox.',
    whenToUse: 'Use when the user asks Proteus to modify its own app, UI, prompts, deployment, or product behavior. Flow: bind_source → create → update (store the unified diff) → apply → run_checks → preview → request_approval → deploy; rollback reverts a bad deploy.',
    whenNotToUse: 'Do not use for ordinary user project work outside the Proteus product.',
    result: 'Returns the board/ledger records, or grounded execution results: the apply commit sha, per-check exit codes, the live preview URL, the real deploy version id, or the verified rollback.',
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
    ...(spec.doctrine ? [spec.doctrine] : []),
    `Returns: ${spec.result}`,
  ].join('\n');
}

export const BUILTIN_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> =
  Object.fromEntries(
    BUILTIN_TOOLS.map((name) => [name, renderToolSchemaDescription(BUILTIN_TOOL_SPECS[name])]),
  ) as Record<BuiltinToolName, string>;

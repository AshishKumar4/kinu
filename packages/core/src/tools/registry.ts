/**
 * Canonical tool registry — the single source of truth for Proteus's built-in
 * tool names and descriptions. Consumed by:
 *   - tools/builtins.ts      (factory for the built-in ToolSet)
 *   - prompting/surface.ts   (crafted-tool projection of the live ToolSet)
 *   - cf-backend/orchestrator.ts  (getToolList, getToolDescriptions, beforeTurn)
 *   - cli surfaces           (chat-loop, tui)
 *
 * Changing any name here is a breaking change to prompts, UI, and MCTS scoring.
 */

export const BUILTIN_TOOLS = [
  'execute_tools',
  'run',
  'file',
  'skills',
  'agents',
  'memory',
  'tasks',
  'web',
  'report',
  'release',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/** Whitelist applied in beforeTurn() on the CF backend. */
export const ACTIVE_TOOLS = [...BUILTIN_TOOLS] as const;

/** Set form for O(1) membership checks in hot paths (e.g. craft score filter). */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

export interface BuiltinToolSpec {
  name: BuiltinToolName;
  /** What the tool IS, in one sentence. The only field the system prompt's
   *  tool index renders as prose. */
  summary: string;
  /** When to reach for it, and how to shape the call. Schema-only. */
  whenToUse: string;
  /** Where it is the wrong instrument. Schema-only — providers weight the
   *  schema description for tool SELECTION, which is exactly the decision this
   *  field informs. The system prompt teaches by example instead. */
  whenNotToUse: string;
  /** A standing fact about the tool's environment that changes how a call
   *  should be written — not when to reach for it. Optional: most tools have
   *  none, and inventing one per tool is prompt bloat. */
  doctrine?: string;
  /** What comes back. Never a restatement of the summary. */
  result: string;
  /** One real call, rendered in the system prompt beside the summary. The
   *  argument shapes are the point — they must match the input schema. */
  example: string;
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
    'Doubt: your first attempt failed, two approaches are both plausible, the step ahead is expensive to undo, or you cannot check your own output — being unsure is itself a reason to fork. ' +
    'Each fork is you on the same workspace, files and sandbox, running its own multi-step tool loop concurrently (web search/fetch, exec), then merging back and disappearing; takes minutes, may auto-background. ' +
    // The payoff-before-limitation ORDER is deliberate and preserved: opening
    // on deterrents ("only… do NOT…") drew 0/10 uses in a shell corpus. What
    // changed is precision — "scored against each other by execution" flat
    // overstates mcts/evaluation.ts, where execution picks the score BAND and
    // a judge ensemble places the branch inside it. The prompt now carries the
    // full mechanism; this field keeps the trigger and the one ranking fact
    // that follows from the band.
    'Leave settle unset to merge the forks back into this turn; set settle=mcts to have them compete instead — how you pick between competing approaches, and the right settle for rival scripts that must produce a specific artifact, since a branch whose proposed code runs and passes outranks every branch whose code failed. mcts branches propose text/code rather than running your own tool loop.',
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

// ── Task-list doctrine (single source) ──────────────────────────────────────
// `tasks` is its own tool rather than three more actions on `memory` because
// the two answer different questions. `memory` is what the agent will want to
// look up in some later turn — its own docstring rules out "temporary task
// progress" in as many words. A task list is the opposite: live plan state
// for the work in front of it, read back every step from the dynamic-context
// block, closed out as the work lands, and shown to the owner on its own
// surface. Folding it in would make `memory`'s one-sentence summary untrue and
// put four more properties on the schema the model reads for every durable-
// state decision.

export const TASKS_TOOL_ACTIONS = ['add', 'update', 'list'] as const;
export type TasksToolAction = (typeof TASKS_TOOL_ACTIONS)[number];

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
    // Not a usage rule but a fact about what is already in the store: the
    // harness writes failed work here as lessons, so the search is worth
    // making before the retry rather than after it.
    doctrine: 'Your own failures are recorded as lessons in here — search before retrying similar work.',
    result: hasFacts
      ? 'Returns save or fact-mutation status, recalled fact values, note search hits, or session transcript slices.'
      : 'Returns save status, note search hits, or session transcript slices.',
    example: hasFacts
      ? "memory({action:'remember', key:'deploy.target', value:'staging'})"
      : "memory({action:'save', content:'Staging deploys need the tunnel up first.'})",
  };
}

// ── Release doctrine (single source) ────────────────────────────────────────
// The release lane has two halves and no actor has both. Where an execution
// engine drives the working copy, apply/run_checks/preview/deploy/rollback earn
// their results from real command output, and the ledger's record_* twins are
// refused as assertions of what was never run. Where no engine is wired, the
// agent runs the commands itself and the record_* actions are the only way the
// ledger learns what happened. Advertising the union made every actor read the
// other half's schema and be refused by it, so the surface gates on the same
// dep the runtime does — the `memoryToolSpec(hasFacts)` pattern.

/** The governance ledger — wherever the release lane exists at all. */
export const RELEASE_LEDGER_ACTIONS = [
  'board', 'bind_source', 'create', 'update', 'transition', 'request_approval',
] as const;

/** Results asserted rather than earned. Only without an execution engine. */
export const RELEASE_RECORD_ACTIONS = ['record_check', 'record_deployment'] as const;

/** Results driven for real in the working copy. Only with an engine. */
export const RELEASE_ENGINE_ACTIONS = ['apply', 'run_checks', 'preview', 'deploy', 'rollback'] as const;

export type ReleaseToolAction =
  | (typeof RELEASE_LEDGER_ACTIONS)[number]
  | (typeof RELEASE_RECORD_ACTIONS)[number]
  | (typeof RELEASE_ENGINE_ACTIONS)[number];

/** The actions a runtime with (or without) an execution engine exposes. */
export function releaseToolActions(hasEngine: boolean): readonly ReleaseToolAction[] {
  return hasEngine
    ? [...RELEASE_LEDGER_ACTIONS, ...RELEASE_ENGINE_ACTIONS]
    : [...RELEASE_LEDGER_ACTIONS, ...RELEASE_RECORD_ACTIONS];
}

/**
 * The release spec for a runtime that does (or does not) drive the working
 * copy itself. `BUILTIN_TOOL_SPECS.release` is the engine surface — the
 * representative full lane — and buildBuiltinTools renders the ledger-only one
 * where no engine is wired.
 */
export function releaseToolSpec(hasEngine: boolean): BuiltinToolSpec {
  return {
    name: 'release',
    summary: hasEngine
      ? 'Governed release pipeline over a bound source repo — patch it, run its checks, preview, take owner approval, deploy, roll back.'
      : 'Governed release ledger over a bound source repo — plan a change, store its patch, take owner approval, and record the checks and deployments you ran yourself.',
    whenToUse:
      'Use when the user asks Proteus to change its own app, UI, prompts, or deployment. '
      + (hasEngine
        ? 'Flow: bind_source → create → update (store the unified diff) → apply → run_checks → preview → request_approval → deploy; rollback reverts a bad deploy.'
        : 'Flow: bind_source → create → update (store the unified diff) → transition → record_check → request_approval → record_deployment; this backend has no execution engine, so run the commands yourself with `run` in the working copy and record what they returned.'),
    whenNotToUse: 'Not for ordinary project work, and not for adding a workspace dashboard — that is workspace.createView, which needs no deploy.',
    result: hasEngine
      ? 'Returns the board/ledger records, or grounded execution results: the apply commit sha, per-check exit codes, the live preview URL, the real deploy version id, or the verified rollback.'
      : 'Returns the board/ledger records: the change, its stored patch, and the checks, approvals and deployments recorded against it.',
    example: hasEngine
      ? "release({action:'run_checks', changeId:'chg_4f2'})"
      : "release({action:'record_check', changeId:'chg_4f2', check:{name:'tests', status:'passed'}})",
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
    whenToUse: 'Use when a step needs real logic: loops, branching, several calls whose results feed each other, crafted tool calls, and anything that has to hold state between calls.',
    whenNotToUse: 'Do not use for a single shell command when `run` is enough, or to read and edit a file when `file` is enough.',
    // The recurring mental-model error: models read `workspace.*` as the
    // machine's filesystem and call workspace.readdir('/app') on a container
    // path, which cannot resolve. Stating what the namespace IS is what stops
    // the whole class, not a better error on the tenth attempt.
    doctrine:
      'workspace.* is the agent\'s OWN virtual filesystem, not the filesystem of the machine or container this agent runs on — a container path such as /app is not reachable through it. '
      + 'Read and write files that live on a real machine or container by running a shell command there with the `run` tool, in the runtime that owns them.',
    result: 'Returns whatever the code returns, as a structured result, or a structured error.',
    example: "execute_tools({code:\"const files = await workspace.readdir('/local/reports'); return files.slice(0, 5)\"})",
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
    example: "run({runtime:'sandbox', command:'npm test'})",
  },
  // ── The file plane (single source) ────────────────────────────────────────
  // ONE tool, three actions, for the same reason `memory` is one tool: reading
  // a file, changing part of it and creating it are one concept, and which
  // action a call needs follows from what the model is doing rather than from a
  // comparison it has to make. The actions are named after the codemode calls
  // they mirror (workspace.readFile / writeFile), so there is one vocabulary.
  file: {
    name: 'file',
    summary: 'Read files, replace exact text inside them, and create them, on any filesystem this agent can reach.',
    whenToUse:
      'Every file you read and every file you change. '
      + 'read pages through a large file with offset/limit. '
      + 'edit replaces old_text with new_text: copy old_text exactly as the read showed it, with enough surrounding lines that it occurs once, and put several changes to one file in one call. '
      + 'write creates a file, or replaces one whole.',
    whenNotToUse:
      'Do not rewrite a whole file with write to change part of it — edit it. '
      + 'Do not change files by pointing `run` at sed -i, a heredoc, or an inline python/perl script: those write whether or not the text they aimed at was there.',
    // The two rules that make an edit safe, stated where the model decides how
    // to write the call — not after it has already failed one.
    doctrine:
      'Read a file here before editing or overwriting it: the change is refused otherwise, and refused again if the file moved on after that read. '
      + 'An edit whose old_text is missing, or present more than once, fails and touches nothing — widen old_text until it is unique rather than retrying the same anchor.',
    result:
      'read returns the content, naming the offset that continues it when a cap or a limit stopped it early. '
      + 'edit returns the line each replacement landed on, or one failure naming what was wrong. '
      + 'write returns the size written and whether the file was created or replaced.',
    example: "file({action:'edit', path:'/local/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  skills: {
    name: 'skills',
    summary: 'SKILL.md workflow instructions stored for this agent — list, read, invoke, create, edit, delete.',
    whenToUse: 'Use when the task matches a workflow worth following step by step, or when the user invokes a skill by name. Write one with create once a workflow has proven itself.',
    whenNotToUse: 'Do not load broad skills speculatively; they consume context and can over-constrain unrelated work.',
    result: 'Returns the skill catalogue, one skill\'s content, or mutation status.',
    example: "skills({action:'invoke', name:'release-checklist'})",
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
    // The fork call, because it is the one shape here a model gets wrong: the
    // trajectory data has `agents` called with an invented `fork_specs` for
    // `forks`, and the nested {task, rationale} objects are the only argument
    // shape in the whole surface that a name alone does not give away. staff's
    // arguments are flat and its `role` property carries its own example.
    example: "agents({action:'fork', task:'Why staging 502s under load', forks:[{task:'Read the gateway logs', rationale:'where the failure shows'}, {task:'Diff the last deploy', rationale:'timing points at the release'}]})",
  },
  memory: memoryToolSpec(true),
  tasks: {
    name: 'tasks',
    summary: 'Your own task list for the work in front of you — write down the steps, mark one active, close it when it lands.',
    whenToUse:
      'Use whenever the work ahead is more than a step or two, and at the moment you learn a step has parts: '
      + 'add writes several titles in one call, so one call records the whole plan; pass parent to file them under a task you already wrote. '
      + 'update moves one item to active as you start it and done as you finish it, or to dropped when it turns out not to be needed. '
      + 'list reads the whole list back, closed items included.',
    // A standing fact about where the list is READ, which is what makes
    // keeping it current worth the call.
    doctrine:
      'Your open items are re-rendered into your live context at every step, so this list is what you read back after a long tool call, a background job settles, or the user interrupts with something else.',
    whenNotToUse:
      'Do not use it for a single-step request, and keep findings, lessons and decisions in `memory` — this list holds what is still to be done, not what you learned doing it.',
    result:
      'add returns the new ids in order, with any title it refused and why. '
      + 'update returns the item at its new status, and says how many of its subtasks are still open when you close a parent. '
      + 'list returns every item, each task carrying its subtasks.',
    example: "tasks({action:'add', titles:['Reproduce the 502', 'Patch the gateway timeout', 'Add a regression test']})",
  },
  web: {
    name: 'web',
    summary: 'Live web access — search for ranked results, fetch one URL as clean markdown.',
    whenToUse:
      'Use for current or post-training-cutoff information, documentation and sources. Search to discover URLs, then fetch the promising ones to actually read them, looping with refined queries until the question is answered; go straight to fetch when you already have the URL.',
    whenNotToUse: 'Do not use for things you already know. Do not fetch private or internal addresses; they are blocked.',
    result:
      'search returns up to ~5 ranked results, each with title, url, snippet, and a freshness date when available (plus a synthesized answer when a Tavily key is connected). '
      + 'fetch returns the page title, retrieval timestamp, and markdown; oversized pages are saved to the workspace VFS and clamped to a head — re-read the file, or slice it and llm.query each slice inside execute_tools.',
    example: "web({action:'search', query:'durable objects sqlite storage limits'})",
  },
  report: {
    name: 'report',
    summary: 'Report progress, completion, or a blocker on your current assignment to the workspace orchestrator.',
    whenToUse:
      'Use at meaningful milestones: your assignment is done (status=completed), you are blocked and need input (status=blocked), or a significant mid-task update is worth surfacing (status=progress).',
    whenNotToUse: 'Do not report per-step noise — the answer of a turn the orchestrator assigned is relayed to it automatically at turn end.',
    result: 'Returns delivery confirmation; the report reaches the orchestrator as a background event that wakes it.',
    example: "report({status:'completed', content:'Auth migration merged; 3 regression tests added.'})",
  },
  release: releaseToolSpec(true),
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

/**
 * Canonical tool registry — the single source of truth for Proteus's built-in
 * tool names, how the model REACHES each of them, and their descriptions.
 * Consumed by:
 *   - tools/builtins.ts      (factory for the built-in ToolSet)
 *   - tools/*-codemode.ts    (each namespace takes its NAME from TOOL_REACH)
 *   - execution/sandbox-errors.ts (where a capability actually is, when a
 *                            model reaches for a native tool inside the sandbox)
 *   - prompting/surface.ts   (crafted-tool projection of the live ToolSet)
 *   - conformance/manifest.ts (per-root wiring, keyed by these names)
 *   - cf-backend/orchestrator.ts  (getToolList, getToolDescriptions, beforeTurn)
 *   - cli surfaces           (chat-loop, tui)
 *
 * Changing any name here is a breaking change to prompts, UI, and MCTS scoring.
 */

// ── The reach axis (single source) ──────────────────────────────────────────
// Until this declaration existed, how the model reaches a capability was
// emergent rather than stated: native meant "whichever names buildBuiltinTools
// happened to put in the ToolSet", codemode meant "whichever
// createXCodemodeProvider some backend actor class happened to call", and the
// Tools panel guessed `nativeNames.has(name) ? 'native' : 'codemode'` — a
// binary that cannot say "neither", so the one deps-gated builtin (`report`)
// rendered as codemode-only on the orchestrator, an actor that has it on no
// surface at all.
//
// `codemode` is a NAMESPACE and not a boolean because it is not always the
// capability's own name: `run` and `file` are reached inside the sandbox
// through the shared `workspace` primitives they already dispatch into, so
// they own no namespace of their own. A capability OWNS its namespace exactly
// when `codemode` equals its own key, which is what every *-codemode.ts factory
// relies on: each takes its provider `name` straight from this table.
//
// Reach is not permission. What a given actor gets is reach ∩ the deps its
// backend wires; the per-root record of which roots wire what, with a stated
// reason for every deliberate absence, is conformance/manifest.ts.

export type ToolReach =
  | { readonly native: true; readonly codemode: string | null }
  | { readonly native: false; readonly codemode: string };

/**
 * Every capability the model can call by name, and where it can call it.
 *
 * The native rows come first, in registration order. Adding one GROWS the
 * standing tool surface, which is 8 by deliberate design (10 → 8, 2026-08-13:
 * every native tool is a standing choice the model weighs on every turn it is
 * not the answer to, and selection accuracy degrades with choice count).
 * unit-tools.test.ts pins both the count and the names against this table, so
 * growth is a decision and never a side effect of editing it.
 */
export const TOOL_REACH = {
  execute_tools: { native: true, codemode: null },
  run: { native: true, codemode: 'workspace' },
  file: { native: true, codemode: 'workspace' },
  agents: { native: true, codemode: 'agents' },
  memory: { native: true, codemode: 'memory' },
  tasks: { native: true, codemode: 'tasks' },
  web: { native: true, codemode: 'web' },
  report: { native: true, codemode: 'report' },
  // Codemode-only by decision, not by omission: a governed high-blast-radius
  // lane, the agent's own self-steering, and the sandbox's recursive-LM
  // primitive. None of the three is the answer to enough turns to earn a
  // standing top-level choice, and `llm.query` is only meaningful as code
  // feeding code in the first place.
  release: { native: false, codemode: 'release' },
  agent: { native: false, codemode: 'agent' },
  llm: { native: false, codemode: 'llm' },
} as const satisfies Record<string, ToolReach>;

type CapabilityName = keyof typeof TOOL_REACH;

/** The capabilities handed to the model as tool definitions, derived from the
 *  reach declaration — so BUILTIN_TOOL_SPECS and BUILTIN_TOOL_DESCRIPTIONS
 *  cannot compile without an entry for a newly-native capability, and
 *  BUILTIN_TOOLS cannot list one the declaration does not call native. */
export type BuiltinToolName = {
  [K in CapabilityName]: (typeof TOOL_REACH)[K]['native'] extends true ? K : never
}[CapabilityName];

export const BUILTIN_TOOLS = [
  'execute_tools',
  'run',
  'file',
  'agents',
  'memory',
  'tasks',
  'web',
  'report',
] as const satisfies readonly BuiltinToolName[];

/** Whitelist applied in beforeTurn() on the CF backend. */
export const ACTIVE_TOOLS = [...BUILTIN_TOOLS] as const;

/** Set form for O(1) membership checks in hot paths (e.g. craft score filter). */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

/** Narrows a name that arrived off the wire — a sandbox ReferenceError, an
 *  MCTS score row — to the native surface, so TOOL_REACH can be indexed with
 *  it without a cast. */
export function isBuiltinToolName(value: string): value is BuiltinToolName {
  return BUILTIN_TOOL_NAMES.has(value);
}

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

/** The two spawn rungs of the delegation ladder. Rendered verbatim into the
 *  `agents` schema description, which every family reads for SELECTION; the
 *  prompt's Delegation section indexes the same rungs in its own words and
 *  carries only the operational doctrine no schema does (prompt.ts). */
export const DELEGATION_RUNGS = {
  fork:
    // Opens on the payoff in the CALLER'S currency, which nothing in the
    // delegation surface said before: the section's only use of "cheapest"
    // argued for NOT reaching for the ladder. Literally true of a head — it
    // runs on its own inherited window and only its settled result comes back
    // into this one (heads/controller.ts) — so it is a fact about the mechanism
    // and not a sales line, which is the one idea worth taking from the
    // deepseek harness's `so it does not consume this conversation's context`.
    'Fork (action=fork) to spend someone else\'s context instead of your own — each fork reads, searches and runs in its own window and hands you back only the answer. Two triggers. Breadth: work splits into 2+ independent angles you would otherwise grind through one-by-one — research sweeps, pre-implementation investigation, reviewing or verifying separate components in parallel. ' +
    'Doubt: your first attempt failed, two approaches are both plausible, the step ahead is expensive to undo, or you cannot check your own output — being unsure is itself a reason to fork. ' +
    'Each fork is you on the same workspace, files and sandbox, running its own multi-step tool loop concurrently (web search/fetch, exec), then merging back and disappearing; takes minutes, and on a live session it backgrounds the moment it spawns — the settled result wakes you. ' +
    // The payoff-before-limitation ORDER is deliberate and preserved: opening
    // on deterrents ("only… do NOT…") drew 0/10 uses in a shell corpus. What
    // changed is precision — "scored against each other by execution" flat
    // overstates mcts/evaluation.ts, where execution picks the score BAND and
    // a judge ensemble places the branch inside it. The prompt now carries the
    // full mechanism; this field keeps the trigger and the one ranking fact
    // that follows from the band.
    // "set settle=mcts to have THEM compete" read as the briefs competing, and
    // they never do: the two settles take different arguments, and the fork
    // seam now refuses the mismatch instead of discarding it (agents-tool.ts
    // forkSettleRefusal), so the difference is a fact about the call and not a
    // nicety.
    'Leave settle unset to run the briefs in `forks` and merge them back into this turn; set settle=mcts to have the search write its own rivals and compete them instead — how you pick between competing approaches, and the right settle for rival scripts that must produce a specific artifact, since a branch whose proposed code runs and passes outranks every branch whose code failed. mcts branches propose text/code rather than running your own tool loop, and it takes no `forks`: briefs handed to it are refused, because merge is the settle that runs them.',
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
  'A busy agent is never blocked on — your message is queued immediately for its own mode-homogeneous turn, so send follow-ups as soon as you have them.';

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

/** The memory actions a runtime can actually perform — the ONE expression of
 *  the facts gate, so the enum the model is shown, the vocabulary a refusal
 *  names, and the set the dispatcher accepts cannot disagree. (Sibling of
 *  `agentsActionsFor`, which does the same job for `agents`.) */
export function memoryActionsFor(hasFacts: boolean): readonly MemoryToolAction[] {
  return hasFacts ? [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS] : MEMORY_NOTE_ACTIONS;
}

/** The `web` plane's two actions. Beside the other tool vocabularies rather
 *  than inline in builtins.ts, so the schema enum, the dispatcher's accepted
 *  set and a refusal's wording are one symbol. */
export const WEB_TOOL_ACTIONS = ['search', 'fetch'] as const;
export type WebToolAction = (typeof WEB_TOOL_ACTIONS)[number];

/** The `file` plane's three actions — the one file/execution surface's whole
 *  vocabulary, declared beside its siblings for the same reason. */
export const FILE_TOOL_ACTIONS = ['read', 'write', 'edit'] as const;
export type FileToolAction = (typeof FILE_TOOL_ACTIONS)[number];

/**
 * The one wording for "the model sent a discriminant that is not in the
 * vocabulary" — shared by every native dispatcher, because they used to
 * disagree about it and the disagreement was the defect: `tasks` answered
 * `unknown tasks action 'list">'`, naming what the model typed and none of the
 * words that would have worked, so the retry repeated the mistake.
 *
 * Both halves earn their place. The vocabulary is what makes the next call
 * succeed. The echo is what tells the model WHICH of its arguments was wrong
 * when a call carried several — and it is `JSON.stringify`d so a malformed
 * fragment reads as a string literal rather than blending into the message.
 *
 * `received` is typed as the caller's DECLARED type, which is a string on
 * every dispatcher: this runs after the parse has already refused it, so its
 * only job is to render what arrived.
 */
export function unknownActionError(
  tool: string,
  field: string,
  received: string,
  allowed: readonly string[],
): string {
  return `${tool} requires \`${field}\` — one of ${allowed.join(', ')}; got ${JSON.stringify(received)}`;
}

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

export const TASKS_TOOL_ACTIONS = ['add', 'update', 'list', 'mode'] as const;
export type TasksToolAction = (typeof TASKS_TOOL_ACTIONS)[number];

// ── Stance doctrine (single source) ─────────────────────────────────────────
// A stance is HOW the agent is working right now. It is not a permission: what
// a turn may do is decided by the Plan/Auto axis (prompting/surface.ts's
// WorkMode), and Plan is enforced structurally — submit_plan exists only on a
// Plan turn and `release.*` is mechanically removed from the namespace. A
// stance only adds lines to the operating guidance, so no stance can widen or
// narrow that. It rides `tasks` because it is the same kind of state the task
// list is: the agent's own record of the work in front of it.
//
// `general` is the default and renders NOTHING. That is deliberate — the
// absence of constraint is how the agent already works, and giving the default
// a paragraph would spend the model's attention saying so.

export const AGENT_STANCES = ['general', 'research', 'build', 'audit'] as const;
export type AgentStance = (typeof AGENT_STANCES)[number];
export const DEFAULT_AGENT_STANCE: AgentStance = 'general';

/** Narrows a stored config value or a model-supplied argument to a stance. */
export function isAgentStance(value: string | null | undefined): value is AgentStance {
  return AGENT_STANCES.some((stance) => stance === value);
}

export interface AgentStanceSpec {
  /** What picking this stance is for. Schema-only — the enum description the
   *  model reads when it decides, mirroring BuiltinToolSpec.whenToUse. */
  pick: string;
  /** The lines added to the prompt's operating guidance while this stance is
   *  set. Rendered verbatim by prompt.ts and written nowhere else. */
  guidance: readonly string[];
}

export const AGENT_STANCE_SPECS = {
  general: {
    pick: 'the default — work the way the task in front of you needs',
    guidance: [],
  },
  research: {
    pick: 'understanding something before deciding what to do about it',
    guidance: [
      'Research stance: read the code, logs and data yourself, and name the file and line each claim rests on.',
      'Say which parts you confirmed, which are still open, and what evidence would close them.',
    ],
  },
  build: {
    pick: 'carrying a change through to something that runs',
    guidance: [
      'Build stance: carry the change through to something that runs, and show the command output that proves it.',
      'Keep each changed line traceable to the request or to the root cause behind it.',
    ],
  },
  audit: {
    pick: 'going over a surface end to end and reporting what is there',
    guidance: [
      'Audit stance: cover the whole surface in front of you, and give every finding a file and line.',
      'Lead with what matters most, and say what you checked to reach each finding.',
    ],
  },
} satisfies Record<AgentStance, AgentStanceSpec>;

/** The stance choices, composed from the same specs the prompt renders so
 *  there is one place to edit. Read by the `tasks` docstring below and by the
 *  `stance` property description in tools/builtins.ts — the two places a model
 *  can learn a stance exists. */
export const STANCE_CHOICES: string =
  AGENT_STANCES.map((stance) => `${stance} = ${AGENT_STANCE_SPECS[stance].pick}`).join('. ');

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
// ledger learns what happened. This gate lives on in tools/release-codemode.ts,
// which projects the SAME action set into the sandbox — release left the
// model's top-level surface (a governed, high-blast-radius, occasional lane
// costs a standing choice every turn it is not the answer to), but the
// gate-on-engine-presence policy did not move.

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
 * Canonical descriptions. These are what the LLM sees as tool docstrings and
 * what the UI shows in the Tools tab.
 *
 * Namespace contract (preamble-injection pattern — see docs/CRAFT-ARCHITECTURE.md):
 *   - `workspace.*` — filesystem / shell / memory primitives, including
 *     `editFile` — the exact-match edit reachable natively as `file`'s `edit`
 *     action (tools/file-tool.ts's createFileDispatcher, shared by both).
 *   - `codemode.*` — every provider exposed via createCodeTool, including
 *     crafted tools once they have been type-declared at construction time.
 *   - `tools.<name>` — crafted tools are ALSO reachable as local object
 *     properties inside the execute_tools async arrow, injected by the
 *     preamble. Crafted-tool bodies may call `workspace.*`, `codemode.*`,
 *     and `tools.<other>` interchangeably.
 *   - `agents.*` / `memory.*` / `tasks.*` / `report.*` — the same-named
 *     native tool, projected into the sandbox over its own dispatcher
 *     (tools/agents-codemode.ts, memory-codemode.ts, tasks-codemode.ts,
 *     report-codemode.ts), gated to the same deps/actions the native tool
 *     is. `agents.*` is what makes a crafted tool able to BE a workflow:
 *     plain control flow over delegated steps.
 *   - `release.*` — the governed release lane's ONLY reach (tools/release-
 *     codemode.ts): no native `release` tool exists. Same reasoning as
 *     `skills`, below, applied to a lane occasional and high-blast-radius
 *     enough that it should not cost a standing top-level choice either.
 *
 * `skills` has no tool AND no codemode namespace: SKILL.md files are
 * ordinary paths under /workspace/skills/ on the SAME VFS `workspace.*`
 * already addresses (readFile/writeFile/readdir/exec('rm …')) — a dedicated
 * surface would have been a third path to the same bytes. Discovery is
 * ambient (renderSkillsIndexSection in the system prompt); activation is
 * resolved once at turn start (orchestrator/turn-surface.ts), never by a
 * tool call.
 */
export const BUILTIN_TOOL_SPECS = {
  execute_tools: {
    name: 'execute_tools',
    // llm.query is deliberately NOT here — it exists only on the CF backend,
    // so the prompt advertises it via a backend-gated line instead.
    summary:
      'Run JavaScript against active executor namespaces, codemode.* providers, tools.<name> crafted tools, and agent helpers.',
    whenToUse: 'Use when a step needs real logic: loops, branching, several calls whose results feed each other, crafted tool calls, and anything that has to hold state between calls.',
    whenNotToUse: 'Do not use for a single shell command when `run` is enough, or to read and edit a file when `file` is enough.',
    // Other runtimes still own their own paths. The workspace namespace is the
    // stable anchor: the same canonical bytes as `file` and `run` workspace.
    doctrine:
      'workspace.* is the agent\'s canonical durable workspace: the same files addressed by the `file` tool and `run` with runtime "workspace". '
      + 'A separate container or machine remains a separate filesystem in its own paths; address it through its listed runtime.',
    result: 'Returns whatever the code returns, as a structured result, or a structured error.',
    example: "execute_tools({code:\"const files = await workspace.readdir('reports'); return files.slice(0, 5)\"})",
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
    //
    doctrine:
      'Inside a container `nproc`, `/proc/cpuinfo` and `free` report the HOST, not your cgroup — sizing `-j` or worker counts from them will OOM the job. When the execution status lists cpus/mem for a runtime, those are the real limits: size parallelism from them. '
      + '`runtime: "workspace"` is the shell over the canonical durable workspace; its live execution status is authoritative for which programs and runtimes it supports. Separate containers and machines keep their own files and paths, so select those runtimes explicitly when the work lives there.',
    result: 'Returns the command output — both streams, labelled when both wrote — prefixed with the exit code when it is non-zero, or a structured runtime_not_provisioned error.',
    example: "run({runtime:'workspace', command:'npm test'})",
  },
  // ── The file plane (single source) ────────────────────────────────────────
  // ONE tool, three actions, for the same reason `memory` is one tool: reading
  // a file, changing part of it and creating it are one concept, and which
  // action a call needs follows from what the model is doing rather than from a
  // comparison it has to make. The actions are named after the codemode calls
  // they mirror (workspace.readFile / writeFile), so there is one vocabulary.
  file: {
    name: 'file',
    summary: 'Read files, replace exact text inside them, and create them in the agent\'s canonical workspace filesystem.',
    whenToUse:
      'Every canonical workspace file you read or change; use a separate environment\'s namespace for files on that environment. '
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
    example: "file({action:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
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
    // The same three facts as positives. This field's LABEL still frames them
    // ("Avoid when: …", renderToolSchemaDescription below), which is the honest
    // place for the framing; the sentences inside it do not have to be
    // prohibitions, and this was the one delegation surface that read as one.
    // The race half gained the remedy it was missing — the fix for two forks
    // over one resource is one fork that owns it, which is what the head's own
    // prompt already tells the child to do (heads/head-inference.ts).
    whenNotToUse:
      'A single short coherent change is yours to make directly. Forks that would write the same mutable resource belong in one fork that owns it. Every subordinate or peer message wakes that agent for a full turn, so each one carries real work.',
    result:
      'fork produces the merged answer with per-fork outputs, or under settle=mcts the winning proposal and its score — on a live session the call hands back a background job at spawn and that answer arrives as the wake when it settles; staff/dismiss return roster state. '
      + 'ask/send return event_id plus delivery (starts_now = it was idle, queued = it will run in its own mode-homogeneous turn) '
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
    summary: 'Your own task list and working stance — write down the steps, mark one active, close it when it lands, and set how you are working.',
    whenToUse:
      'Use whenever the work ahead is more than a step or two, and at the moment you learn a step has parts: '
      + 'add writes several titles in one call, so one call records the whole plan; pass parent to file them under a task you already wrote. '
      + 'update moves one item to active as you start it and done as you finish it, or to dropped when it turns out not to be needed. '
      + 'list reads the whole list back, closed items included. '
      + `mode sets the stance you work in — ${STANCE_CHOICES} — and reads the current one back when called with no stance.`,
    // A standing fact about where the list is READ, which is what makes
    // keeping it current worth the call.
    doctrine:
      'Your open items are re-rendered into your live context at every step, so this list is what you read back after a long tool call, a background job settles, or the user interrupts with something else.',
    whenNotToUse:
      'Do not use it for a single-step request, and keep findings, lessons and decisions in `memory` — this list holds what is still to be done, not what you learned doing it.',
    result:
      'add returns the new ids in order, with any title it refused and why. '
      + 'update returns the item at its new status, and says how many of its subtasks are still open when you close a parent. '
      + 'list returns every item, each task carrying its subtasks. '
      + 'mode returns the stance now in force; its guidance joins your operating guidance from your next turn, and it never changes what a turn is allowed to do.',
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
} satisfies Record<BuiltinToolName, BuiltinToolSpec>;

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

export const BUILTIN_TOOL_DESCRIPTIONS = {
  execute_tools: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.execute_tools),
  run: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.run),
  file: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.file),
  tasks: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.tasks),
  agents: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.agents),
  memory: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.memory),
  web: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.web),
  report: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.report),
} satisfies Record<BuiltinToolName, string>;

/**
 * The `execute_tools` docstring the model actually receives: this registry's
 * doctrine for the tool, the two standing facts about the sandbox itself, then
 * the TypeScript declaration of every namespace that sandbox binds.
 *
 * BOTH backends compose it here, because until they did they described one tool
 * two incompatible ways and neither was complete. The CF backend passed no
 * description to @cloudflare/codemode's createCodeTool, so production shipped
 * the vendor's generic DEFAULT_DESCRIPTION — "Execute code to achieve a goal."
 * — with none of BUILTIN_TOOL_SPECS.execute_tools reaching the model at all,
 * and with a worked example calling `codemode.searchWeb(...)`, a shape
 * cf-backend/execute-tools.ts is coded to throw on. The CLI passed the
 * doctrine and discarded every provider's `types`, so its model was never told
 * that `agents.fork`, `memory.save`, `tasks.add` or `llm.query` are callable.
 *
 * `typeBlock` is the namespace declarations, assembled per backend: CF hands
 * codemode its own `{{types}}` placeholder and lets it substitute (it can
 * generate a declaration from a tool's input schema, which the CLI cannot);
 * the CLI joins its providers' declared `types`.
 */
export function renderExecuteToolsDescription(typeBlock: string): string {
  return [
    BUILTIN_TOOL_DESCRIPTIONS.execute_tools,
    // Two facts about the sandbox, not advice: it is a JavaScript isolate, and
    // it returns the value your code produces. The code SHAPE is deliberately
    // not constrained — the crafted-tool preamble reaches every shape now
    // (cf-backend/crafted-tool-registry.ts injectPreamble), so a statement
    // body, a trailing expression and an async arrow are all equally correct.
    'The sandbox is a JavaScript isolate: write statements, a single trailing expression, or one `async (...) => { … }` arrow — whichever fits — and the value your code produces comes back as the result. Type annotations, interfaces and generics do not parse there.',
    `Namespaces bound in this sandbox:\n${typeBlock}`,
  ].join('\n\n');
}

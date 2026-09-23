/** Canonical built-in tool names, reach, and descriptions. Renaming one breaks prompts, UI, and MCTS scoring. */

// Reach is not permission: an actor gets reach ∩ the deps its backend wires (conformance/manifest.ts).
// A capability owns its codemode namespace when `codemode` equals its own key; *-codemode.ts factories rely on that.

/**
 * Behavior when the same call is reached twice, e.g. a replay after eviction.
 * `safe` reruns freely; `claimed` goes through the effect claim (tools/effect-claim.ts).
 */
export type ReplayPolicy = 'safe' | 'claimed';

export type ToolReach =
  | { readonly native: true; readonly codemode: string | null; readonly replay: ReplayPolicy }
  | { readonly native: false; readonly codemode: string; readonly replay: ReplayPolicy };

/**
 * Every model-callable capability, where it is reachable, and its replay policy.
 * Native rows come first in registration order; unit-tools.test.ts pins their count and names.
 * The claim is enforced at the provider tool-call boundary, so codemode-only rows are covered by `eval`'s.
 */
export const TOOL_REACH = {
  eval: { native: true, codemode: null, replay: 'claimed' },
  shell: { native: true, codemode: 'workspace', replay: 'claimed' },
  // Reads and writes share one policy, so it is the write-safe one.
  file: { native: true, codemode: 'workspace', replay: 'claimed' },
  agents: { native: true, codemode: 'agents', replay: 'claimed' },
  // Two saves leave two notes.
  memory: { native: true, codemode: 'memory', replay: 'claimed' },
  tasks: { native: true, codemode: 'tasks', replay: 'claimed' },
  web: { native: true, codemode: 'web', replay: 'safe' },
  report: { native: true, codemode: 'report', replay: 'claimed' },
  // Codemode-only by decision: occasional lanes that do not earn a standing choice.
  release: { native: false, codemode: 'release', replay: 'claimed' },
  agent: { native: false, codemode: 'agent', replay: 'claimed' },
  // A replayed insert is a second row.
  db: { native: false, codemode: 'db', replay: 'claimed' },
  slate: { native: false, codemode: 'workspace', replay: 'claimed' },
} as const satisfies Record<string, ToolReach>;

/** Replay policy by provider tool name; undeclared names (MCP, adapters) resolve to `claimed`. */
export function replayPolicyFor(toolName: string): ReplayPolicy {
  return isToolReachName(toolName) ? TOOL_REACH[toolName].replay : 'claimed';
}

function isToolReachName(value: string): value is keyof typeof TOOL_REACH {
  return Object.hasOwn(TOOL_REACH, value);
}

type CapabilityName = keyof typeof TOOL_REACH;

/** Capabilities TOOL_REACH declares native. */
export type BuiltinToolName = {
  [K in CapabilityName]: (typeof TOOL_REACH)[K]['native'] extends true ? K : never
}[CapabilityName];

function isCapabilityName(name: string): name is CapabilityName {
  return Object.hasOwn(TOOL_REACH, name);
}

/** Typed keys of TOOL_REACH; `Object.keys` loses the key union. */
const CAPABILITY_NAMES: readonly CapabilityName[] = Object.keys(TOOL_REACH).filter(isCapabilityName);

/** Native tools, derived from TOOL_REACH in declaration order. */
export const BUILTIN_TOOLS: readonly BuiltinToolName[] =
  CAPABILITY_NAMES.filter((name): name is BuiltinToolName => TOOL_REACH[name].native);

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

/** Narrows an untrusted name (sandbox error, score row) to the native surface. */
export function isBuiltinToolName(value: string): value is BuiltinToolName {
  return BUILTIN_TOOL_NAMES.has(value);
}

/** The subordinate → parent progress tool id. */
export const REPORT_TOOL: BuiltinToolName = 'report';

/** Plan mode's completion tool. Not in TOOL_REACH: `buildBuiltinTools` adds it only on Plan turns. */
export const SUBMIT_PLAN_TOOL = 'submit_plan';

/** Builtins dropped when an actor's profile wires no deps for them. `agents` is never dropped. */
export const DEPS_GATED_TOOLS: readonly BuiltinToolName[] = [REPORT_TOOL];

interface CapabilityReach {
  readonly name: CapabilityName;
  readonly namespace: string;
}

const CODEMODE_ONLY_REACH: readonly CapabilityReach[] = Object.freeze(
  CAPABILITY_NAMES.flatMap((name) => {
    const reach = TOOL_REACH[name];

    return reach.native ? [] : [{ name, namespace: reach.codemode }];
  }),
);

/** Capabilities per codemode namespace; `workspace` survives while either `shell` or `file` does. */
const CAPABILITIES_BY_NAMESPACE: Readonly<Record<string, readonly CapabilityName[]>> = (() => {
  const index: Record<string, CapabilityName[]> = {};

  for (const name of CAPABILITY_NAMES) {
    const namespace = TOOL_REACH[name].codemode;

    if (namespace === null) continue;
    (index[namespace] ??= []).push(name);
  }

  return Object.freeze(index);
})();

/**
 * Codemode-only capabilities whose namespace is present in a wired provider list.
 * Pass the list after every conditional and after the Plan-mode filter.
 */
export function codemodeCapabilitiesFor(
  providers: readonly { readonly name: string }[],
): string[] {
  const wired = new Set(providers.map((provider) => provider.name));

  return CODEMODE_ONLY_REACH
    .filter((reach) => wired.has(reach.namespace))
    .map((reach) => reach.name);
}

/**
 * One role's tool surface over native tools and codemode namespaces. Both read one set:
 * narrowing only the ToolSet would leave `agents.*` reachable through `eval`.
 */
export interface ToolSurfaceNarrowing {
  /** Whether a native tool id survives. */
  allowsTool(name: string): boolean;
  /** Whether a codemode namespace may be bound inside `eval`. */
  allowsNamespace(namespace: string): boolean;
  /** The provider list narrowed to the namespaces this role may reach. */
  narrowProviders<P extends { readonly name: string }>(providers: readonly P[]): P[];
}

/**
 * `allowedTools` is the resolver's merged list; `undefined` allows everything.
 * A declared namespace is exposed when any capability reaching it is allowed; an
 * undeclared one (e.g. `pc`, `sandbox`) is exposed when `eval` is.
 */
export function narrowToolSurface(
  allowedTools: readonly string[] | undefined,
): ToolSurfaceNarrowing {
  if (allowedTools === undefined) {
    return {
      allowsTool: () => true,
      allowsNamespace: () => true,
      narrowProviders: (providers) => [...providers],
    };
  }

  const allowed = new Set(allowedTools);
  const sandbox = allowed.has('eval');

  const allowsNamespace = (namespace: string): boolean => {
    const reaching = CAPABILITIES_BY_NAMESPACE[namespace];

    if (!reaching) return sandbox;

    return reaching.some((name) => allowed.has(name));
  };

  return {
    allowsTool: (name) => allowed.has(name),
    allowsNamespace,
    narrowProviders: (providers) => providers.filter((p) => allowsNamespace(p.name)),
  };
}

export interface BuiltinToolSpec {
  name: BuiltinToolName;
  /** One sentence; the only field the system prompt's tool index renders. */
  summary: string;
  /** When to reach for it, and how to shape the call. Schema-only. */
  whenToUse: string;
  /** Schema-only; providers weight the schema description for tool selection. */
  whenNotToUse: string;
  /** Optional standing fact about the environment that changes how a call is written. */
  doctrine?: string;
  /** What comes back. Never a restatement of the summary. */
  result: string;
  /** One real call, rendered in the system prompt; must match the input schema. */
  example: string;
}

// Delegation doctrine: the `agents` docstring renders these rungs verbatim, so delegation doctrine changes only here.

/** Every `agents` action; per-actor availability is agentsActionsFor in delegation/agents-tool.ts. */
export const AGENTS_TOOL_ACTIONS = [
  'swarm', 'hire', 'msg', 'list', 'dismiss',
] as const;

export type AgentsToolAction = (typeof AGENTS_TOOL_ACTIONS)[number];

/** The one question the ladder asks. Prefixes the doctrine in both surfaces. */
export const DELEGATION_FRAME =
  'One delegation ladder, two rungs: a search is ephemeral and settles into this turn, and a hire is one agent working a workstream of its own beside you.';

/**
 * Per-rung context doctrine. `rung` feeds the rung's doctrine; `brief` feeds the field
 * carrying the helper's instructions (swarm `task`, hire `mission`).
 */
export const DELEGATION_CONTEXT_DESCRIPTION =
  'Under `inherit` your recent turns arrive as its conversation, so it already knows what you know; under `fresh` it starts from the brief. Fork when the work needs the conversation you share; use fresh when your own framing is the thing in question.';

export const DELEGATION_INHERITANCE = {
  swarm: {
    rung:
      'What a node starts from is the search\'s own `context`: under `inherit` your recent turns arrive as its conversation, so it already knows what you know and the task only has to say what is being measured; under `fresh` it starts from the task and the objective alone, which is what you want when your own framing is the thing in question. Each preset takes the value its search needs.',
    brief:
      'State the goal, the constraints that hold for every candidate, and any interface they must agree on — once, here, rather than per candidate; and remember that whether a node also arrives holding your recent turns is the search\'s `context`, so do not lean on shared ground the preset may not grant.',
  },
  hire: {
    rung:
      'A hire with `context:"fresh"` (or no context set) gets its role, its mission and a short digest of your recent messages. '
      + DELEGATION_CONTEXT_DESCRIPTION
      + ' Set `context:"inherit"` to fork at birth; later turns do not take another copy of your conversation.',
    brief:
      'State the goal, the constraints and what finished looks like here. With the default `context:"fresh"` it gets only a short digest of your recent messages; `context:"inherit"` also hands it your recent turns as its conversation.',
  },
} as const;

/** Delegation rungs, rendered verbatim into the `agents` schema description. */
export const DELEGATION_RUNGS = {
  swarm:
    'Run a search (action=swarm): N nodes each running its own tool loop over this workspace in parallel, handing you back only what they found. '
    // unit-prompt.test.ts derives the preset band from SWARM_PRESET_POINTS and fails this string when it moves.
    // Depth is omitted: a bare `{preset, task}` call pins depth to 1.
    + 'Scale the candidate count to the size of the task and state it on the call: `branches` is that count, the named presets set it from 3 to 5 per level, and each candidate is one more tool loop with its own token bill — so name a number above that band only when the task has that many independent angles. '
    + 'Candidates are scored by your verifier running in this workspace when you declare an `objective`, and ranked by a judge ensemble when you do not. '
    + `${DELEGATION_INHERITANCE.swarm.rung} `
    + 'You name the shape with `preset`, and a verifier is CODE that runs here rather than a model\'s opinion of the answer. '
    // Preset enumeration rides the `preset` field (SWARM_PRESET_DOCTRINE in strategy/swarm.ts).
    + '`preset` and `task` are the whole call: every preset runs from those two alone. `objective` is the OPTIONAL upgrade that turns a judged sweep into a measured search — it states what is measured, in what unit, which direction is better, the target that counts as done, and `verify` as {kind, spec} naming a registered instrument. A verifier is CODE that runs, so a metric nothing can execute is not an objective: leave it out and take the judged sweep. '
    + 'A floor is optional and is a PROOF: declare one and a candidate that measures past it is reported as a breach with the measurement kept, never as a score, because the bound may be what is wrong. '
    + 'Spend: `budget_tokens`/`budget_usd` cap everything the search transitively spawns and nest under your own mission scope; omitted means uncapped within that scope, so omit unless the caller gave you a number to enforce. '
    + 'It takes minutes, and on a live session it backgrounds the moment it spawns — the settled result wakes you; never poll a backgrounded job or spawn it twice. '
    + 'It refuses rather than approximates: an illegal composition comes back naming the axis and what to change, and a shape no engine here can run faithfully says so instead of returning a number from a different mechanism.',
  hire:
    'Hire a helper (action=hire): one agent per independent workstream, each running its own tool loop over this same workspace. '
    // No number or field here: a team-only actor renders this rung without the swarm rung.
    + 'Say how many independent workstreams the task holds before the first hire, as a range: a part that runs without waiting on another part is one workstream, each hire adds one more tool loop and one more token bill, and a chain of dependent steps is one workstream however long it is. '
    + 'A hire outlives this turn and stays in your roster: hand it more work with msg, read the roster with list. A finished hire reports and STAYS, resumable with its context intact — dismiss only one whose role is permanently over. '
    + `${DELEGATION_INHERITANCE.hire.rung} `
    + 'Naming an `agent` that already exists instead of a `role` hands that agent the workstream rather than creating one, with `deliverable` saying what finished looks like.',
} as const;

/** The `task` lifetime, rendered only where a substrate can run one. Opens by scoping the
 *  roster rung above it, so that rung stays unhedged. */
export const DELEGATION_TASK_LIFETIME =
  'That roster account is the DEFAULT lifetime, and `lifetime:"task"` overrides it: a task hire is for when you want an answer, not a colleague — the agent is created for that one question, this call waits for it to finish and returns its answer here, and it is archived the moment it answers with its transcript kept. It is the lifetime for work that is bounded and self-contained: reading a large file to answer something specific, an independent review of something you produced, a focused investigation whose result you need before your next step. There is no follow-up, so state the whole question once; a second exchange wanted the default "durable".';

/** `agents` result contract pieces; `taskHire` is gated like {@link DELEGATION_TASK_LIFETIME}.
 *  The full description concatenates all three. */
export const AGENTS_RESULT_PARTS = {
  roster: 'A hire and dismiss return roster state. ',
  taskHire: 'A lifetime:"task" hire returns the agent\'s finished answer, its elapsed time and no roster row. ',
  rest:
    'A hire handed to an agent that already exists, and msg, return event_id plus delivery (starts_now = it was idle, queued = it will run in its own mode-homogeneous turn) '
    + 'and subordinate_phase (what it was doing) — subordinate reports and peer replies then arrive as events that wake you, citing that event_id. '
    + 'swarm returns the axes actually in force, the caps and where each came from, `best` with its RAW measured value in your unit beside the normalised score, every candidate including the ones that produced no usable answer and why, and a settle report carrying the measured baseline and the floor margin — and on a live session the call hands back a background job at spawn, with that report arriving as the wake when it settles. '
    + 'A run that measured past its floor comes back with a publication caveat and no score on that candidate: the answer is still yours to read and is NOT publishable until the bound is re-derived.',
} as const;

/** How `msg` addresses an agent or an inbound question. */
export const DELEGATION_CONVERSE =
  'msg says something to an agent without handing it a workstream: `agent` names one — a subordinate in this workspace or one of the owner\'s other workspace agents — and `event_id` answers an incoming agent message event instead. One or the other, never both. ' +
  'hire scope=workspace creates a specialist workspace of its own. ' +
  'A busy agent is never blocked on — your message is queued immediately for its own mode-homogeneous turn, so send follow-ups as soon as you have them.';

// Preset doctrine lives in strategy/swarm.ts (SWARM_PRESET_DOCTRINE), rendered from the preset table.

// Keyed-fact memory actions exist only where a FactsStore is wired; the docstring uses the same gate.

/** Always present: every runtime has `rt.memory` and the transcript. */
export const MEMORY_NOTE_ACTIONS = ['save', 'search', 'conversations'] as const;

/** Present only where a FactsStore is wired. */
export const MEMORY_FACT_ACTIONS = ['remember', 'recall', 'forget'] as const;

/** Memory actions a runtime can perform: the single facts gate for the enum, refusals and dispatch. */
export function memoryActionsFor(hasFacts: boolean): readonly MemoryToolAction[] {
  return hasFacts ? [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS] : MEMORY_NOTE_ACTIONS;
}

export const WEB_TOOL_ACTIONS = ['search', 'fetch'] as const;

export type WebToolAction = (typeof WEB_TOOL_ACTIONS)[number];

export const FILE_TOOL_ACTIONS = ['read', 'write', 'edit', 'list', 'stat', 'search'] as const;

export type FileToolAction = (typeof FILE_TOOL_ACTIONS)[number];

/** Shared unknown-discriminant error: lists the vocabulary and JSON-quotes what arrived. */
export function unknownActionError(
  tool: string,
  field: string,
  received: string,
  allowed: readonly string[],
): string {
  return `${tool} requires \`${field}\` — one of ${allowed.join(', ')}; got ${JSON.stringify(received)}`;
}

// `tasks` is separate from `memory`: live plan state for current work, not durable recall.

export const TASKS_TOOL_ACTIONS = ['add', 'update', 'list', 'mode'] as const;

export type TasksToolAction = (typeof TASKS_TOOL_ACTIONS)[number];


export type MemoryToolAction =
  | (typeof MEMORY_NOTE_ACTIONS)[number]
  | (typeof MEMORY_FACT_ACTIONS)[number];

/** Memory spec gated on facts; `BUILTIN_TOOL_SPECS.memory` is the full surface. */
export function memoryToolSpec(hasFacts: boolean): BuiltinToolSpec {
  // The conversations mode contract lives in the input-schema property descriptions.
  return {
    name: 'memory',
    summary: hasFacts
      ? 'Durable state you read back in a later turn: keyed facts, prose notes, past conversations.'
      : 'Durable state you read back in a later turn: prose notes and past conversations.',
    whenToUse:
      'Use for anything that must outlive this turn. '
      + (hasFacts
        ? 'remember/recall hold a small named value; update a stale key rather than adding a contradictory second fact; '
        : '')
      + (hasFacts
        ? 'save/search hold a lesson or note too long to be a value — search spans notes and remembered facts by key or value; '
        : 'save/search hold a lesson or note too long to be a value; ')
      + 'conversations reads what this agent said before.',
    whenNotToUse: 'Do not store temporary task progress, stale logs, or anything this turn already carries.',
    doctrine: 'Your own failures are recorded as lessons in here — search before retrying similar work.',
    result: hasFacts
      ? 'Returns save or fact-mutation status, recalled fact values, note and fact search hits, or conversation transcript slices.'
      : 'Returns save status, note search hits, or conversation transcript slices.',
    example: hasFacts
      ? "memory({action:'remember', key:'deploy.target', value:'staging'})"
      : "memory({action:'save', content:'Staging deploys need the tunnel up first.'})",
  };
}

// Release: record_* actions only without an execution engine, engine actions only with one.
// Codemode-only (tools/release-codemode.ts).

const RELEASE_LEDGER_ACTIONS = [
  'board', 'bind_source', 'create', 'update', 'transition', 'request_approval',
] as const;

/** Results asserted rather than earned. Only without an execution engine. */
const RELEASE_RECORD_ACTIONS = ['record_check', 'record_deployment'] as const;

/** Results driven for real in the working copy. Only with an engine. */
const RELEASE_ENGINE_ACTIONS = ['apply', 'run_checks', 'preview', 'deploy', 'rollback'] as const;

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
 * Canonical descriptions: the LLM tool docstrings and the UI Tools tab.
 * Namespace contract: docs/CRAFT-ARCHITECTURE.md.
 */
export const BUILTIN_TOOL_SPECS = {
  eval: {
    name: 'eval',
    summary:
      'Run a JavaScript program in a Node-like sandbox where every tool you have is callable as `tools.<name>(input)`, files and shells are namespaces, and `state.*` keeps values between programs.',
    whenToUse: 'Use when a step needs real logic: loops, branching, several calls whose results feed each other, calling a tool you crafted, fetching over HTTP, or holding state between calls.',
    whenNotToUse: 'Do not use for a single shell command when `shell` is enough, or to read and edit one file when `file` is enough.',
    doctrine:
      'workspace.* is the agent\'s canonical durable workspace: the same files addressed by the `file` tool and `shell` with runtime "workspace". '
      + 'A separate container or machine keeps its commands behind its own runtime; when live, its files also sit in the workspace plane at /pc or /sandbox.',
    result: 'Returns whatever the program returns, plus everything it logged with console.*, or the error it threw. Binding failures resolve to { success: false, reason, error, execution? }, with the same reason as the native tool. Inspect success === false to recover; returning that refusal propagates it on the tool error channel. Inner failures remain in the call census even when the program recovers.',
    example: "eval({code:\"// List the newest reports\\nconst fs = require('fs/promises');\\nconst files = await fs.readdir('reports');\\nreturn files.slice(0, 5)\"})",
  },
  shell: {
    name: 'shell',
    summary: 'Run one shell command in one explicitly selected available runtime.',
    whenToUse: 'Use for a direct command in the same runtime where its files and dependencies live.',
    whenNotToUse: 'Do not use for multi-step logic, cross-runtime file access, or a runtime that is not explicitly listed as available.',
    doctrine:
      'Inside a container `nproc`, `/proc/cpuinfo` and `free` report the HOST, not your cgroup — sizing `-j` or worker counts from them will OOM the job. When the execution status lists cpus/mem for a runtime, those are the real limits: size parallelism from them. '
      + '`runtime: "workspace"` is the shell over the canonical durable workspace; its live execution status is authoritative for which programs and runtimes it supports. Separate containers and machines keep their own files and paths, so select those runtimes explicitly when the work lives there.',
    result: 'Returns the command output — both streams, labelled when both wrote — prefixed with the exit code when it is non-zero, or a structured runtime_not_provisioned error.',
    example: "shell({runtime:'workspace', command:'npm test'})",
  },
  file: {
    name: 'file',
    summary: 'Inspect file contents, directory entries, metadata and literal text matches; replace exact text or create files in the canonical workspace. Plan permits inspection, not writes.',
    whenToUse:
      'Every canonical workspace file you read or change; mounted machine files under /pc or /sandbox when live (a namespace call is the alternative for commands there). '
      + 'read pages through a large file with offset/limit. '
      + 'edit replaces old_text with new_text: copy old_text exactly as the read showed it, with enough surrounding lines that it occurs once, and put several changes to one file in one call. '
      + 'write creates a file, or replaces one whole.',
    whenNotToUse:
      'Do not rewrite a whole file with write to change part of it — edit it. '
      + 'Do not change files by pointing `shell` at sed -i, a heredoc, or an inline python/perl script: those write whether or not the text they aimed at was there.',
    doctrine:
      'Read a file here before editing or overwriting it: the change is refused otherwise, and refused again if the file moved on after that read. '
      + 'An edit whose old_text is missing, or present more than once, fails and touches nothing — widen old_text until it is unique rather than retrying the same anchor.',
    result:
      'read returns the content, naming the offset that continues it when a cap or a limit stopped it early. '
      + 'edit returns the line each replacement landed on, or one failure naming what was wrong. '
      + 'write returns the size written and whether the file was created or replaced.',
    example: "file({action:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  // Selection doctrine; `renderAgentsToolDescription` drops unwired rungs. The prompt's
  // Delegation section renders none of it (pinned by unit-prompt.test.ts).
  agents: {
    name: 'agents',
    summary:
      "Spawn and talk to helper agents — a measured search over ephemeral nodes of your own, persistent subordinates in this workspace, and the owner's other workspace agents.",
    whenToUse:
      `${DELEGATION_FRAME} ${DELEGATION_RUNGS.swarm} ${DELEGATION_RUNGS.hire} ${DELEGATION_TASK_LIFETIME} ${DELEGATION_CONVERSE}`,
    whenNotToUse:
      'A single short coherent change is yours to make directly. Work that is ONE DEPENDENT CHAIN — each step needing the step before it — belongs to one agent, however large it is: splitting a chain across agents pays for planning and for merging what they each assumed, and buys none of the parallelism the ladder exists for. Fan out over slices that are genuinely independent, and say what each owns. Nodes that would write the same mutable resource belong in one node that owns it. Every subordinate or peer message wakes that agent for a full turn, so each one carries real work.',
    result: `${AGENTS_RESULT_PARTS.roster}${AGENTS_RESULT_PARTS.taskHire}${AGENTS_RESULT_PARTS.rest}`,
    // Cheapest complete call: `ideate` is the one preset that takes no `objective`.
    example: "agents({action:'swarm', preset:'ideate', task:'Three ways to stop staging 502ing under load'})",
  },
  memory: memoryToolSpec(true),
  tasks: {
    name: 'tasks',
    summary: 'Your own task list and durable role — write down the steps, mark one active, close it when it lands, and select how you work.',
    whenToUse:
      'Use whenever the work ahead is more than a step or two, and at the moment you learn a step has parts: '
      + 'add writes several titles in one call, so one call records the whole plan; pass parent to file them under a task you already wrote. '
      + 'update moves one item to active as you start it and done as you finish it, or to dropped when it turns out not to be needed; it also accepts `note`, a one-line annotation beside the item (null clears it). '
      + 'list reads the whole list back, closed items included. '
      + `mode switches your durable role — pass \`role\` to switch (it applies from your NEXT turn; the current one keeps its resolved profile), or call with no argument to read the active role id.`,
    doctrine:
      'Your open items are re-rendered into your live context at every step, so this list is what you read back after a long tool call, a background job settles, or the user interrupts with something else.',
    whenNotToUse:
      'Do not use it for a single-step request, and keep findings, lessons and decisions in `memory` — this list holds what is still to be done, not what you learned doing it.',
    result:
      'add returns the new ids in order, with any title it refused and why. '
      + 'update returns the item at its new status, and says how many of its subtasks are still open when you close a parent. '
      + 'list returns every item, each task carrying its subtasks. '
      + 'mode returns the active role; a switch applies from the next turn and never changes what the current turn is allowed to do.',
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
      + 'fetch returns the page title, retrieval timestamp, and markdown; oversized pages are saved to the workspace VFS and clamped to a head — re-read the file in ranges, or name the path in the message of a lifetime:"task" hire so that agent reads it instead of you.',
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

/** Render a spec into the JSON-schema tool docstring. */
export function renderToolSchemaDescription(spec: BuiltinToolSpec): string {
  return [
    spec.summary,
    `Use when: ${spec.whenToUse}`,
    `Avoid when: ${spec.whenNotToUse}`,
    ...(spec.doctrine ? [spec.doctrine] : []),
    `Returns: ${spec.result}`,
  ].join('\n');
}

/** Spelled out so `satisfies` checks exhaustiveness without a type assertion. */
export const BUILTIN_TOOL_DESCRIPTIONS = {
  eval: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.eval),
  shell: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.shell),
  file: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.file),
  tasks: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.tasks),
  agents: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.agents),
  memory: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.memory),
  web: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.web),
  report: renderToolSchemaDescription(BUILTIN_TOOL_SPECS.report),
} satisfies Record<BuiltinToolName, string>;

/** Which substrate runs the program. */
export type SandboxSubstrate = 'hosted' | 'local';

const SANDBOX_WORKSPACE = '`require()` resolves the Node builtins (`path`, `url`, `util`, `crypto`, `buffer`, `events`, `stream`, …) plus `fs`, `fs/promises` and `child_process` implemented over your workspace files and shell, and `process.cwd()` is the workspace root. They are asynchronous only: `execSync`, `spawn` and every `fs.*Sync` call throw, so await the promise forms: `const { stdout } = await require("child_process").exec("ls -la")`, `await require("fs/promises").readFile("notes.md", "utf8")`. ';

const SANDBOX_FACTS = {
  hosted:
    'The sandbox is a fresh JavaScript isolate per program, written like a Node script: statements at the top level, `await` anywhere, and `return` (or a trailing expression) to hand back the result. Type annotations do not parse there. '
    + SANDBOX_WORKSPACE
    + '`fetch` reaches the internet. `console.log` output comes back beside the result. `env.workspace` is your workspace name and `env.state` is the `state` namespace.',
  local:
    'The sandbox runs the program in-process, written like a Node script: statements at the top level, `await` anywhere, and `return` (or a trailing expression) to hand back the result. Type annotations do not parse there. '
    + SANDBOX_WORKSPACE
    + '`fetch` is the machine\'s own. `console.log` output comes back beside the result.',
} satisfies Record<SandboxSubstrate, string>;

/** The `code` field description on the `eval` input schema, shared via `codemodeInputSchema`. */
export const CODEMODE_CODE_DESCRIPTION = 'The JavaScript program: top-level statements, `await` allowed, `return` (or a trailing expression) hands back the result.';

/**
 * The `eval` docstring: tool doctrine, sandbox facts, then every namespace declaration in order.
 * Both backends compose it here, never through a template token: a `$` in a declaration is text.
 */
export function renderCodemodeDescription(declarations: readonly (string | undefined)[], substrate: SandboxSubstrate = 'hosted'): string {
  return [
    BUILTIN_TOOL_DESCRIPTIONS.eval,
    SANDBOX_FACTS[substrate],
    'Every native tool is `tools.<name>(input)` here with the same input object. Tools saved with `workspace.createTool` are callable as `tools.<name>(...)`; their current declarations are in dynamic_context. The declaration below lists the native tools. Variables do not survive between programs; `state.set`/`state.get` do.',
    'Start every program with exactly one `//` comment on the first nonblank line. State the operation and target in plain language, for example `// Read package.json to inspect its scripts`. The interface shows this line to the user as the call intent.',
    `Namespaces bound in this sandbox:\n${declarations.filter((types) => types !== undefined && types !== '').join('\n\n')}`,
  ].join('\n\n');
}

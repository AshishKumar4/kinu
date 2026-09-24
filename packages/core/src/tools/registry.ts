import { REFUSAL_TYPE } from '../types/tool-outcome';

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
  /** One line: the first line of the schema description, and the Tools tab headline. */
  summary: string;
  /** What a correct call needs that its input schema cannot say, one fact each. */
  notes: readonly string[];
  /** One real call, rendered in the system prompt; must match the input schema. */
  example: string;
}

/** Every `agents` action; per-actor availability is agentsActionsFor in delegation/agents-tool.ts. */
export const AGENTS_TOOL_ACTIONS = [
  'swarm', 'hire', 'msg', 'list', 'dismiss',
] as const;

export type AgentsToolAction = (typeof AGENTS_TOOL_ACTIONS)[number];

/** `agents` notes by the wiring each needs; `renderAgentsToolDescription` keeps the wired ones. */
export const AGENTS_TOOL_NOTES = {
  swarm: '`swarm` runs short-lived nodes in parallel over this workspace and returns what they found, judged, or measured by your verifier when you give an `objective`. It takes minutes; on a live session it runs in the background and its result wakes you.',
  hire: '`hire` gives one workstream to one agent: a new one from `role` and `mission`, or an existing `agent` with `message`. A hired subordinate stays in your roster, with its context, after it reports.',
  task: '`lifetime:"task"` creates an agent for one question: the call waits for its answer, returns it, and archives the agent.',
  converse: '`msg` messages an agent without handing it a workstream; `list` reads the roster. A subordinate\'s report and a peer\'s reply arrive later as events.',
  peers: '`hire` with `scope:"workspace"` creates a specialist workspace; `msg` with `event_id` answers an incoming agent message.',
} as const;

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
  return {
    name: 'memory',
    summary: hasFacts
      ? 'Durable memory across turns: keyed facts, notes, and your past conversations.'
      : 'Durable memory across turns: notes and your past conversations.',
    notes: hasFacts ? ['`remember` on an existing key replaces its value.'] : [],
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
    summary: 'Run a JavaScript program that can call your tools and the sandbox namespaces.',
    notes: [
      'Write it like a Node script: top-level statements, `await` anywhere, and `return` (or a trailing expression) hands back the result. Type annotations do not parse.',
      '`tools.<name>(input)` calls a native tool with the input its schema declares; a tool saved with `workspace.createTool` joins `tools` from the next program, declared in dynamic_context.',
      '`require()` loads Node builtins, plus `fs`, `fs/promises` and `child_process` over your workspace files and shell; `process.cwd()` is the workspace root. Only promise forms work: `execSync`, `spawn` and `fs.*Sync` throw.',
      '`console.log` output comes back with the result. Variables do not survive between programs; `state` does.',
      'A refused call, in any namespace, resolves to a `Refusal` instead of throwing; returning it fails the call with that reason.',
      'Start with one `//` comment naming the operation and its target; the interface shows it as the call\'s intent.',
    ],
    example: "eval({code:\"// List the newest reports\\nconst fs = require('fs/promises');\\nconst files = await fs.readdir('reports');\\nreturn files.slice(0, 5)\"})",
  },
  shell: {
    name: 'shell',
    summary: 'Run a shell command in one runtime and return its output.',
    notes: [
      'Output holds both streams, labelled when both wrote, and starts with the exit code when it is not zero.',
      'Each runtime keeps its own files; `workspace` is the filesystem the `file` tool reads.',
      'In a container, `nproc` and `free` report the host: size parallelism from the cpus and memory the execution status lists.',
    ],
    example: "shell({runtime:'workspace', command:'npm test'})",
  },
  file: {
    name: 'file',
    summary: 'Read, list, stat, search, edit or write files in your workspace.',
    notes: [
      'Read a file before editing or overwriting it; the change is refused otherwise, or when the file changed after that read.',
      'A read that stops early names the offset that continues it.',
      'An edit fails when its target text is not there; `sed -i`, heredocs and scripts in `shell` write regardless.',
    ],
    example: "file({action:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  agents: {
    name: 'agents',
    summary: 'Delegate work to other agents and message them.',
    notes: Object.values(AGENTS_TOOL_NOTES),
    // Cheapest complete call: `ideate` is the one preset that takes no `objective`.
    example: "agents({action:'swarm', preset:'ideate', task:'Three ways to stop staging 502ing under load'})",
  },
  memory: memoryToolSpec(true),
  tasks: {
    name: 'tasks',
    summary: 'Your task list, shown in your context at every step, and your active role.',
    notes: [],
    example: "tasks({action:'add', titles:['Reproduce the 502', 'Patch the gateway timeout', 'Add a regression test']})",
  },
  web: {
    name: 'web',
    summary: 'Search the web, or fetch one URL as markdown.',
    notes: [
      'Private and internal addresses are blocked.',
      'A fetched page too long to return is saved to the workspace, and the result names the file.',
    ],
    example: "web({action:'search', query:'durable objects sqlite storage limits'})",
  },
  report: {
    name: 'report',
    summary: 'Report progress, completion or a blocker on your assignment to the workspace orchestrator.',
    notes: ['The answer your turn ends with reaches the orchestrator anyway; report milestones, not steps. A report wakes it.'],
    example: "report({status:'completed', content:'Auth migration merged; 3 regression tests added.'})",
  },
} satisfies Record<BuiltinToolName, BuiltinToolSpec>;

/** A spec as its schema description: the summary, then one line per note. */
export function renderToolSchemaDescription(spec: BuiltinToolSpec): string {
  return [spec.summary, ...spec.notes.map((note) => `- ${note}`)].join('\n');
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

const SANDBOX_RUNS = {
  hosted: 'Each program runs in a fresh isolate; `fetch` reaches the internet.',
  local: 'Each program runs in-process; `fetch` is the machine\'s own.',
} satisfies Record<SandboxSubstrate, string>;

/** The `code` field description on the `eval` input schema, shared via `codemodeInputSchema`. */
export const CODEMODE_CODE_DESCRIPTION = 'The JavaScript program.';

/**
 * The `eval` docstring: its registry description, the substrate, the one `Refusal` every namespace names, then
 * every namespace declaration in order.
 * Both backends compose it here, never through a template token: a `$` in a declaration is text.
 */
export function renderCodemodeDescription(declarations: readonly (string | undefined)[], substrate: SandboxSubstrate = 'hosted'): string {
  return [
    BUILTIN_TOOL_DESCRIPTIONS.eval,
    `- ${SANDBOX_RUNS[substrate]}`,
    'Namespaces:',
    REFUSAL_TYPE,
    ...declarations.filter((types): types is string => types !== undefined && types !== '').map((types) => types.trimEnd()),
  ].join('\n');
}

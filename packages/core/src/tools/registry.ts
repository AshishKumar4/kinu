import type { ToolSet } from 'ai';
import { REFUSAL_TYPE } from '../types/tool-outcome';
import type { CodemodeProvider } from '../types/codemode';
import { namespaceDeclaration, nativeOperations } from './operation-surfaces';

/** Canonical built-in tool names, reach, and descriptions. Renaming one breaks prompts and UI. */

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
  file: { native: true, codemode: 'file', replay: 'claimed' },
  agents: { native: true, codemode: 'agents', replay: 'claimed' },
  // Two saves leave two notes.
  memory: { native: true, codemode: 'memory', replay: 'claimed' },
  tasks: { native: true, codemode: 'tasks', replay: 'claimed' },
  web: { native: true, codemode: 'web', replay: 'safe' },
  report: { native: true, codemode: 'report', replay: 'claimed' },
  // Codemode-only by decision: occasional lanes that do not earn a standing choice.
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

/** Capabilities per codemode namespace; `workspace` survives while either `shell` or `slate` does. */
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

/** One filter over a named set, so a builtin added upstream never silently appears on a confined surface. */
export function keepBuiltins(builtin: ToolSet, names: readonly string[]): ToolSet {
  const kept: ToolSet = {};

  for (const name of names) {
    const entry = builtin[name];

    if (entry) kept[name] = entry;
  }

  return kept;
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




// `tasks` is separate from `memory`: live plan state for current work, not durable recall.



/** Memory spec gated on facts; `BUILTIN_TOOL_SPECS.memory` is the full surface. */
export function memoryToolSpec(hasFacts: boolean): BuiltinToolSpec {
  return {
    name: 'memory',
    summary: hasFacts
      ? 'Durable memory across turns: keyed facts, notes, and your past conversations.'
      : 'Durable memory across turns: notes and your past conversations.',
    notes: [],
    example: hasFacts
      ? "memory({op:'remember', key:'deploy.target', value:'staging'})"
      : "memory({op:'note', content:'Staging deploys need the tunnel up first.'})",
  };
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
      'A refused call, in any namespace, resolves to a `Refusal` instead of throwing: check for one before reading a result\'s fields. Returning it fails the call with that reason.',
      'Run independent calls together with `await Promise.all([...])`, and `return` the values you need rather than logging them.',
      'Start with one `//` comment naming the operation and its target; the interface shows it as the call\'s intent.',
    ],
    example: "eval({code:\"// List the newest reports\\nconst fs = require('fs/promises');\\nconst files = await fs.readdir('reports');\\nreturn files.slice(0, 5)\"})",
  },
  shell: {
    name: 'shell',
    summary: 'Run a shell command in one runtime and return its output.',
    notes: [
      'Every call is a fresh shell starting in `cwd` (default: your home), so a `cd` or `export` lasts only that call; '
        + 'concurrent calls run side by side. A `name` keeps its directory and exported variables from call to call, '
        + 'and runs one call at a time.',
      'Output starts with the directory the command started in, holds both streams, labelled when both wrote, and gives the exit code when it is not zero.',
      'Each runtime keeps its own files; `workspace` is the filesystem the `file` tool reads. Read and edit a file there with `file`, not `cat`, `head`, `sed` or heredocs; the shell is for programs, builds, tests, git and searches across many files.',
      'In a container, `nproc` and `free` report the host: size parallelism from the cpus and memory the execution status lists.',
    ],
    example: "shell({runtime:'workspace', command:'npm test'})",
  },
  file: {
    name: 'file',
    summary: 'Read, list, stat, search, edit or write files in your workspace.',
    notes: [
      'Find before you read: `search` a file for the lines you need, then `read` around them. Read a large file in pages with `offset` and `limit`; a read that stops early names the offset that continues it.',
      'Read a file in this turn before you `edit` it. An edit matches the text as last read, and fails when its `old_text` is absent or occurs more than once: copy just enough to be unique.',
    ],
    example: "file({op:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  agents: {
    name: 'agents',
    summary: 'Delegate work to other agents and message them.',
    notes: [],
    // Cheapest complete call: `ideate` is the one preset that takes no `objective`.
    example: "agents({op:'swarm', preset:'ideate', task:'Three ways to stop staging 502ing under load'})",
  },
  memory: memoryToolSpec(true),
  tasks: {
    name: 'tasks',
    summary: 'Your task list, shown in your context at every step, and your active role.',
    notes: [
      'Keep a list for work of three or more steps, never for a one-step request. Update it in the same step as the work it tracks, and mark an item done as soon as it is.',
    ],
    example: "tasks({op:'add', titles:['Reproduce the 502', 'Patch the gateway timeout', 'Add a regression test']})",
  },
  web: {
    name: 'web',
    summary: 'Search the web, fetch one URL as markdown, or take a screenshot of it.',
    notes: [
      'A fetched page too long to return is saved to the workspace, and the result names the file.',
      'Where Browser Run is not reachable, a rendered fetch or a screenshot refuses, naming what is missing.',
    ],
    example: "web({op:'search', query:'durable objects sqlite storage limits'})",
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
export function renderCodemodeDescription(
  providers: readonly Pick<CodemodeProvider, 'name' | 'types' | 'declarations' | 'tools'>[], native: ToolSet, substrate: SandboxSubstrate = 'hosted',
): string {
  const described = new Set(Object.values(native).flatMap(nativeOperations));
  // Only the members a narrowing or the work mode left are declared.

  const declarations = providers.map(({ name, types, declarations: members, tools }) => (members === undefined
    ? types
    : namespaceDeclaration(name, Object.fromEntries(Object.entries(members).filter(([member]) => Object.hasOwn(tools, member))), described)));

  return [
    BUILTIN_TOOL_DESCRIPTIONS.eval,
    `- ${SANDBOX_RUNS[substrate]}`,
    'Namespaces:',
    REFUSAL_TYPE,
    ...declarations.filter((types): types is string => types !== undefined && types !== '').map((types) => types.trimEnd()),
  ].join('\n');
}

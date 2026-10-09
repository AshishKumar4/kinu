import type { ToolSet } from 'ai';
import { REFUSAL_TYPE } from '../types/tool-outcome';
import type { CodemodeProvider, MemberDeclaration } from '../types/codemode';
import { namespaceDeclaration } from './operation-surfaces';

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

/** The plan review's submission tool. Not in TOOL_REACH: `buildBuiltinTools` adds it where its deps are wired. */
export const SUBMIT_PLAN_TOOL = 'submit_plan';

/** The agent's reply in a review comment thread; wired like `submit_plan`, and only while the owner awaits replies. */
export const REPLY_TO_COMMENT_TOOL = 'reply_to_comment';

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





// `tasks` is separate from `memory`: live plan state for current work, not durable recall.



/** Memory spec gated on facts and the account; `BUILTIN_TOOL_SPECS.memory` is the full surface. */
export function memoryToolSpec(hasFacts: boolean, hasAccount = false): BuiltinToolSpec {
  return {
    name: 'memory',
    summary: hasFacts
      ? `Durable memory across turns: keyed facts, notes, and your past conversations${hasAccount ? ', with your owner\'s account memory read alongside' : ''}.`
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
      '`describe(\'db\')` returns a namespace\'s full TypeScript declarations, `describe(\'db.select\')` one member\'s, and `describe()` all of them: read one before you rely on an option\'s name or a result\'s shape.',
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
      'Each runtime keeps its own files; `workspace` is the filesystem the `file` tool reads.',
      'In a container, `nproc` and `free` report the host: size parallelism from the cpus and memory the execution status lists.',
    ],
    example: "shell({runtime:'workspace', command:'npm test'})",
  },
  file: {
    name: 'file',
    summary: 'Read, list, stat, search, edit or write files in your workspace.',
    notes: [
      'Find before you read: `search` a file for the lines you need, then `read` around them with `offset` and `limit`. A read without them shows the file from the top, a window at a time; its footer says where to continue.',
      'Read a file before you `edit` it. An edit matches the text as last read, and fails when its `old_text` is absent or occurs more than once: copy just enough to be unique, without the line numbers a read puts before each line.',
    ],
    example: "file({op:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  agents: {
    name: 'agents',
    summary: 'Delegate work to other agents and message them.',
    notes: [
      'Do the work yourself by default. A helper costs more than it looks: you write its brief, you see only its report, and trusting that report means reading what it touched.',
      'Delegate only when the work is large, separable from your next step, and clearly costs more to do than to brief and check: independent pieces that can run at the same time, or a long side task whose raw output would flood your context.',
      'Do it yourself when it takes a handful of calls, when your next step depends on it, or when you would redo it to trust the result. Never delegate one small piece, and never split one modest job across several helpers.',
    ],
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

type DescribedProvider = Pick<CodemodeProvider, 'name' | 'summary' | 'types' | 'declarations' | 'tools'>;

/** The members a narrowing or the work mode left, as declared. */
function reachedDeclarations({ declarations, tools }: DescribedProvider): [string, MemberDeclaration][] {
  return Object.entries(declarations ?? {}).filter(([member]) => Object.hasOwn(tools, member));
}

/**
 * The `eval` docstring: its registry description, the substrate, then each namespace with what it is for and its
 * members' call forms. Full declarations are a program's to read on demand (`programDeclarations`), as Codex code mode
 * leaves them out: they were half the text of every request.
 * Both backends compose it here, never through a template token: a `$` in a call form is text.
 */
export function renderCodemodeDescription(providers: readonly DescribedProvider[], substrate: SandboxSubstrate = 'hosted'): string {
  const listed = providers.flatMap((provider) => {
    const members = reachedDeclarations(provider).map(([, declared]) => declared.call);
    const purpose = provider.summary === undefined ? '' : ` ${provider.summary}`;

    if (members.length > 0) return [`- ${provider.name}:${purpose} ${members.join(', ')}`];

    // A namespace declared only as text is listed by name; `describe` answers its declaration.
    return provider.declarations === undefined && provider.types !== undefined && provider.types !== '' ? [`- ${provider.name}:${purpose}`] : [];
  });

  return [
    BUILTIN_TOOL_DESCRIPTIONS.eval,
    `- ${SANDBOX_RUNS[substrate]}`,
    'Namespaces, each with its members\' call forms: positional arguments, then one object of options. '
      + 'Any call can resolve to a `Refusal`, `{ success: false, reason, error }`.',
    ...listed,
  ].join('\n');
}

/**
 * What `describe` answers in a program, by `ns` and `ns.member`, with `Refusal` beside them: each namespace's and each
 * member's full declaration, over the members a narrowing or the work mode left.
 */
export function programDeclarations(providers: readonly DescribedProvider[]): Readonly<Record<string, string>> {
  return Object.fromEntries([
    ['Refusal', REFUSAL_TYPE],
    ...providers.flatMap((provider): [string, string][] => {
      const members = reachedDeclarations(provider);

      if (provider.declarations === undefined) {
        return provider.types === undefined || provider.types === '' ? [] : [[provider.name, provider.types.trimEnd()]];
      }

      if (members.length === 0) return [];

      return [
        [provider.name, namespaceDeclaration(provider.name, Object.fromEntries(members))],
        ...members.map(([member, declared]): [string, string] => [`${provider.name}.${member}`, declared.full]),
      ];
    }),
  ]);
}

/**
 * `describe` as a program's own function over `declarations`: a namespace or member it does not have throws, naming
 * the namespaces it does. Source text, so each backend defines it in the program's scope.
 */
export function describeProgramSource(declarations: Readonly<Record<string, string>>): string {
  return `const describe = ((declared) => (name) => {
  const namespaces = Object.keys(declared).filter((key) => !key.includes('.'));
  if (name === undefined) return namespaces.map((key) => declared[key]).join('\\n');
  if (Object.hasOwn(declared, String(name))) return declared[String(name)];
  throw new Error(\`describe: nothing is named "\${String(name)}"; namespaces: \${namespaces.join(', ')}\`);
})(${JSON.stringify(declarations)});`;
}

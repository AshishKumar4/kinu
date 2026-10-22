import type { ToolSet } from 'ai';
import { REFUSAL_TYPE } from '../types/tool-outcome';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type MemberDeclaration } from '../types/codemode';
import { namespaceDeclaration } from './operation-surfaces';
import { EXEC_ANSWERS_AT_EXIT, EXEC_RUNS_WHERE_ITS_CWD_IS } from '../operations/executors';

/** Canonical built-in tool names, reach, and descriptions. Renaming one breaks prompts and UI. */

// Reach is not permission: an actor gets reach ∩ the deps its backend wires (test-utils/src/conformance/manifest.ts).
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
  // A send asks the owner, and a draft is a second draft when replayed.
  mail: { native: false, codemode: 'mail', replay: 'claimed' },
} as const satisfies Record<string, ToolReach>;

/** Replay policy by provider tool name; undeclared names (MCP, adapters) resolve to `claimed`. */
export function replayPolicyFor(toolName: string): ReplayPolicy {
  return isCapabilityName(toolName) ? TOOL_REACH[toolName].replay : 'claimed';
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

/** The subagent → parent progress tool id. */
export const REPORT_TOOL: BuiltinToolName = 'report';

/** The plan review's submission tool. Not in TOOL_REACH: `buildBuiltinTools` adds it where its deps are wired. */
export const SUBMIT_PLAN_TOOL = 'submit_plan';

/** The agent's reply in a review comment thread; wired like `submit_plan`, and only while the owner awaits replies. */
export const REPLY_TO_COMMENT_TOOL = 'reply_to_comment';

/** The agent's questions to the owner; wired only where a person is the conversation partner. It has no executor. */
export const ASK_OWNER_TOOL = 'ask_owner';

export const ASK_OWNER_DESCRIPTION = [
  'Ask the owner one to four questions with set choices, only when blocked on a decision that is theirs: tradeoffs they must weigh, which nothing you can read settles. Otherwise act, taking the conventional choice and saying so.',
  'Give each question two to four short options with the tradeoff in `description`, mark the one you recommend with `recommended`, and ask related questions in one call. Never offer "Other": the owner can always write their own.',
  'Do the work that does not depend on the answer first: asking ends your turn, and the answer becomes this call\'s result.',
].join('\n');

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
 * undeclared one (e.g. `pc`, `computer`) is exposed when `eval` is.
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

/**
 * A surface whose builtins are an admitted set (a head, a swarm node), narrowed as `allowedTools` narrows it: its
 * programs reach only the namespaces its admitted builtins, or a codemode-only capability, reach, so a program reaches
 * nothing its native tools do not. A tool outside TOOL_REACH (a kind tool, an external one) passes as `allowedTools`
 * says.
 */
export function narrowAdmittedSurface(admitted: readonly string[], allowedTools: readonly string[] | undefined): ToolSurfaceNarrowing {
  const allowed = narrowToolSurface(allowedTools);
  const held = new Set<string>([...admitted, ...CODEMODE_ONLY_REACH.map(({ name }) => name)]);

  const admits = (namespace: string): boolean => {
    const reaching = CAPABILITIES_BY_NAMESPACE[namespace];

    return reaching === undefined ? held.has('eval') : reaching.some((name) => held.has(name));
  };

  return {
    allowsTool: (name) => allowed.allowsTool(name) && (!isCapabilityName(name) || held.has(name)),
    allowsNamespace: (namespace) => allowed.allowsNamespace(namespace) && admits(namespace),
    narrowProviders: (providers) => allowed.narrowProviders(providers).filter((provider) => admits(provider.name)),
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
    summary: 'Run a JavaScript program that calls your tools and each environment\'s namespace.',
    notes: [
      'A Node-style script: top-level `await`, and `return` (or a trailing expression) gives the result. Type annotations do not parse.',
      '`tools.<name>(input)` calls a native tool; a tool saved with `workspace.createTool` joins `tools` from the next program.',
      '`require()` loads Node builtins, with `fs`, `fs/promises` and `child_process` over your workspace files and each machine\'s shell. `*Sync` forms throw; an awaited `exec`/`execFile` resolves to `{ stdout, stderr }`, once the child exits.',
      `With \`child_process\`: ${EXEC_RUNS_WHERE_ITS_CWD_IS}`,
      '`readFile` without an encoding returns a `Uint8Array`.',
      'Variables do not survive between programs; a `private` `db` table keeps data. Run independent calls together with `Promise.all`, and `return` what you need rather than logging it.',
      'A refused call resolves to a `Refusal`, `{ success: false, reason, error }`, instead of throwing: check for one before reading a result.',
      'Start with one `//` comment naming the operation and its target: it is shown as the call\'s intent.',
      '`describe(\'ns\')` and `describe(\'ns.member\')` return full TypeScript declarations: read one before relying on an option\'s name or a result\'s shape.',
    ],
    example: "eval({code:\"// List the newest reports\\nconst fs = require('fs/promises');\\nconst files = await fs.readdir('reports');\\nreturn files.slice(0, 5)\"})",
  },
  shell: {
    name: 'shell',
    summary: 'Run a shell command in one runtime and return its output.',
    notes: [
      'Each call is a fresh shell in `cwd` (default: your home), so `cd` and `export` last one call; a `name` keeps them across calls.',
      `On the workspace runtime: ${EXEC_RUNS_WHERE_ITS_CWD_IS}`,
      EXEC_ANSWERS_AT_EXIT,
      'Each runtime has its own files; `workspace` is the one the `file` tool reads.',
      'In a container, `nproc` and `free` report the host: size parallelism by the execution status.',
    ],
    example: "shell({runtime:'workspace', command:'npm test'})",
  },
  file: {
    name: 'file',
    summary: 'Read, list, stat, search, edit or write files in your workspace.',
    notes: [
      'In a large file, `search` for the lines you need, then `read` around them with `offset` and `limit`.',
      'Read a file before you `edit` it. Each `old_text` must occur exactly once, copied without the line numbers a read shows.',
    ],
    example: "file({op:'edit', path:'src/api.ts', edits:[{old_text:'timeout: 30', new_text:'timeout: 60'}]})",
  },
  agents: {
    name: 'agents',
    summary: 'Delegate work to other agents and message them.',
    notes: [
      'Do the work yourself by default: a subagent costs a brief, and you see only its report.',
      'Delegate only large work separable from your next step: independent pieces that can run at once, or a long side task whose output would flood your context. Never delegate a small piece, or split a modest job across subagents.',
    ],
    // Cheapest complete call: `ideate` is the one preset that takes no `objective`.
    example: "agents({op:'swarm', preset:'ideate', task:'Three ways to stop staging 502ing under load'})",
  },
  memory: memoryToolSpec(true),
  tasks: {
    name: 'tasks',
    summary: 'Your task list, shown in your context at every step, and your active role.',
    notes: [
      'Keep a list for work of three or more steps, not a one-step request; mark each item done as soon as it is.',
    ],
    example: "tasks({op:'add', titles:['Reproduce the 502', 'Patch the gateway timeout', 'Add a regression test']})",
  },
  web: {
    name: 'web',
    summary: 'Search the web, fetch one URL as markdown, or take a screenshot of it.',
    notes: [],
    example: "web({op:'search', query:'durable objects sqlite storage limits'})",
  },
  report: {
    name: 'report',
    summary: 'Report progress, completion or a blocker on your assignment to the workspace orchestrator.',
    notes: ['Your final answer reaches the orchestrator anyway: report milestones, not steps.'],
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
  hosted: '`fetch` reaches the internet.',
  local: 'Programs run in-process; `fetch` is this machine\'s own.',
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
export function renderCodemodeDescription(all: readonly DescribedProvider[], substrate: SandboxSubstrate = 'hosted'): string {
  // `tools.*` are the model's own tools, in its tool list and prompt; `describe` answers them, the docstring does not.
  const providers = all.filter((provider) => provider.name !== CRAFTED_TOOL_NAMESPACE);

  const listed = providers.flatMap((provider) => {
    const members = reachedDeclarations(provider).map(([, declared]) => declared.call);
    const purpose = provider.summary === undefined ? '' : ` ${provider.summary}`;

    if (members.length > 0) return [`- ${provider.name}:${purpose} ${members.join(', ')}`];

    // A namespace declared only as text is listed by name; `describe` answers its declaration.
    return provider.declarations === undefined && provider.types !== undefined && provider.types !== '' ? [`- ${provider.name}:${purpose}`] : [];
  });

  // Members are listed unqualified, and `tools.<name>` was the one qualified form shown, so models wrote
  // `tools.workspace.exec` (Luna, staging 5c522f12d): one member of a listed namespace shows the call as written.
  const shown = providers.flatMap((provider) => reachedDeclarations(provider).slice(0, 1).map(([member]) => `\`${provider.name}.${member}(...)\``))[0];

  return [
    BUILTIN_TOOL_DESCRIPTIONS.eval,
    `- ${SANDBOX_RUNS[substrate]}`,
    'MCP tools: `codemode.list()` lists servers and `codemode.list(server)` their tools; `codemode.search("intent")` finds '
      + 'tools; `codemode.describe(path)` gives one\'s input schema. Call the `tools.<name>(input)` path it returns.',
    ...(shown === undefined ? [] : [`Namespaces are globals, not under \`tools\`: call a member as ${shown}.`]),
    'Each namespace, with its members\' call forms (positional arguments, then one options object):',
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
 * `describe` as a program's own function over `declarations`: a member a declaration declares within it answers that
 * declaration (`workspace.slates.$list`, from `workspace.slates`'s); a name it does not have throws, naming the deepest
 * declared name holding it, else the namespaces it has. Source text, so each backend defines it in the program's scope.
 */
export function describeProgramSource(declarations: Readonly<Record<string, string>>): string {
  return `const describe = ((declared) => (name) => {
  const namespaces = Object.keys(declared).filter((key) => !key.includes('.'));
  if (name === undefined) return namespaces.map((key) => declared[key]).join('\\n');
  if (Object.hasOwn(declared, String(name))) return declared[String(name)];
  const parts = String(name).split('.');
  const holder = parts.slice(1).map((_, cut) => parts.slice(0, parts.length - 1 - cut).join('.')).find((prefix) => Object.hasOwn(declared, prefix));
  if (holder !== undefined && declared[holder].includes(\`\${parts.at(-1)}(\`)) return declared[holder];
  if (holder !== undefined) throw new Error(\`describe: nothing is named "\${String(name)}"; describe('\${holder}') declares what it holds\`);
  throw new Error(\`describe: nothing is named "\${String(name)}"; namespaces: \${namespaces.join(', ')}\`);
})(${JSON.stringify(declarations)});`;
}

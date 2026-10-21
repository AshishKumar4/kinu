/** Codemode sandbox contract: namespace names, the crafted `tools.*` declaration, and crafted-tool labelling. */

import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { asSchema, type ToolSet } from 'ai';
import { JsonObjectSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { hasPlanPermission, providersInWorkMode, toolsInWorkMode, workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import { branchableToolCall, bindProgramCall } from './outcome';
import { TOOL_REACH, CODEMODE_CODE_DESCRIPTION, describeProgramSource, programDeclarations, type ToolSurfaceNarrowing } from './registry';
import { MACHINE_FILES } from '../operations/executors';
import { slateReaches } from '../slates/surface';
import { KinuError, settle, settleSync } from '../obs';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type MemberDeclaration } from '../types/codemode';
import { parsesAsExpression } from '../craft/source';
import type { CraftedToolSource } from './crafted-executor';
import { toolDescription } from '../utils/tool-description';
import { allowedInPlan, defineOperation, serve, statedInput, type Served } from '../operations/operation';
import { nestedMembers, objectInputDeclaration, operationInputSchema, type NestedMembers } from './operation-surfaces';
import type { Impact } from '@agent-core/core/facets';
import type { MemberImpacts } from '../execution/call-effects';

export {
  CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type CodemodeResult,
} from '../types/codemode';

/** A program cannot call `eval` from inside itself, so declarations and bindings skip it. */
const SANDBOX_TOOL = 'eval';

/**
 * How a program's console shows a value: a string as written, anything else as JSON (never "[object Object]"), and a
 * value JSON cannot hold named as such. `SANDBOX_CONSOLE_PRELUDE` is this rule as source for the sandbox; a test holds
 * the two equal.
 */
export function shownConsoleValue(logged: { readonly value: unknown }): string {
  const { value } = logged;

  return settleSync(Effect.gen(function* () {
    if (typeof value === 'string') return value;
    const shown = yield* Effect.result(Effect.try({ try: () => JSON.stringify(value) ?? String(value), catch: (cause) => cause }));

    if (Result.isSuccess(shown)) return shown.success;

    return `[unserializable: ${shown.failure instanceof Error ? shown.failure.message : String(shown.failure)}]`;
  }));
}

/** A member a program calls in-process: what it passes, answered as JSON, as an executor's provider serves it. */
export type ProgramMember = (...args: JsonValue[]) => Promise<JsonValue | undefined>;

/** A namespace as a program holds it: its members, its member groups, and `then`, which is never a member. */
export interface ProgramNamespace {
  readonly [name: string]: ProgramMember | Readonly<Record<string, ProgramMember>> | undefined;
}

/**
 * A namespace as a program holds it in-process, as the cloud's sandbox holds one (its vendor's proxy, then
 * `reachableAsWritten`): each member it serves is its own property, so `'slates' in workspace` says whether slates are
 * served; a member group (`fs.read`) is an object of its members; `workspace.createTool` takes a function as its source;
 * `then` is undefined, so it is never a thenable. Any other name is a member it does not serve, refused by name when
 * called, in the sandbox's words.
 */
export function programNamespace(name: string, members: Readonly<Record<string, ProgramMember>>): ProgramNamespace {
  const create = members['createTool'];
  const served: ProgramNamespace = nestedMembers(members);

  // A function the program passes reaches the member as its source: what the cloud's sandbox sends it.
  const sourced: NestedMembers<ProgramMember> = name === 'workspace' && create !== undefined
    ? { createTool: async (...args) => create(...args.map((arg) => (typeof arg === 'function' ? String(arg) : arg))) }
    : {};

  return new Proxy({ ...served, ...sourced }, {
    get: (target, member) => {
      // Never a member: an await reads it, and a namespace is no promise.
      if (typeof member !== 'string' || member === 'then') return undefined;

      if (Object.hasOwn(target, member)) return target[member];

      return async () => settle(Effect.fail(new KinuError('missing', `Tool "${member}" not found`)));
    },
  });
}

/** `shownConsoleValue` as sandbox source, applied to every console level the sandbox captures. */
export const SANDBOX_CONSOLE_PRELUDE = 'const __kinuShown = (value) => { if (typeof value === "string") return value; '
  + 'try { return JSON.stringify(value) ?? String(value); } '
  + 'catch (error) { return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`; } }; '
  + 'for (const level of ["log", "warn", "error"]) { const write = console[level]; console[level] = (...args) => write(...args.map(__kinuShown)); }';

/** `programNamespace`'s createTool as sandbox source, over the program's `workspace` namespace: a function as its source. */
export const SANDBOX_CREATE_TOOL_PRELUDE = '{ const create = workspace.createTool; workspace.createTool = '
  + '(...args) => create(...args.map((arg) => (typeof arg === "function" ? String(arg) : arg))); }';

export function craftedToolDescription(name: string, description?: string): string {
  return description === undefined || description === '' ? `Crafted tool: ${name}` : description;
}


/** `eval`'s one input: the program it runs. */
export const EVAL_PROGRAM = defineOperation({
  ns: 'eval', name: 'run', slate: false, impact: 'execute', plan: true,
  help: 'Run a JavaScript program over the namespaces this turn reaches.',
  input: v.strictObject({ code: v.pipe(v.string(), v.description(CODEMODE_CODE_DESCRIPTION)) }),
  output: v.unknown(),
});

const CODEMODE_INPUT = operationInputSchema(EVAL_PROGRAM);

/** Shared by both backends; CF reassigns it over `createCodeTool`'s own schema. */
export function codemodeInputSchema(): typeof CODEMODE_INPUT {
  return CODEMODE_INPUT;
}

export interface CraftedDeclaration {
  readonly name: string;
  readonly description: string;
}

export function withCraftedToolDeclarations<Tool extends ToolSet[string]>(
  entry: Tool,
  read: () => readonly CraftedDeclaration[],
) {
  return Object.assign(entry, { craftedDeclarations: read });
}

type DeclaringProfile = { readonly workMode: WorkMode; readonly allowedTools: readonly string[] };

/** The turn's `eval`, when this profile may run it in this work mode. */
export function runnableSandbox(tools: ToolSet, profile: DeclaringProfile): ToolSet[string] | undefined {
  const sandbox = tools[SANDBOX_TOOL];

  if (!sandbox || !profile.allowedTools.includes(SANDBOX_TOOL)
    || workModeRefusal(profile.workMode, hasPlanPermission(sandbox), SANDBOX_TOOL) !== null) return undefined;

  return sandbox;
}

export function craftedToolDeclarations(tools: ToolSet, profile: DeclaringProfile): readonly CraftedDeclaration[] {
  const sandbox = runnableSandbox(tools, profile);

  if (!sandbox || !('craftedDeclarations' in sandbox)) return [];
  const read = v.parse(v.function(), sandbox.craftedDeclarations);

  return v.parse(v.array(v.object({ name: v.string(), description: v.string() })), read());
}

export interface ExternalToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** The input's JSON Schema, compact; absent when the tool's schema cannot be printed. */
  readonly inputSchema?: string;
}

/** The MCP and extension tools `eval` reaches this turn; none when the turn cannot run `eval`. */
export function externalToolDeclarations(
  tools: ToolSet, external: ToolSet, profile: DeclaringProfile,
): readonly ExternalToolDeclaration[] {
  if (runnableSandbox(tools, profile) === undefined) return [];

  return Object.entries(external)
    .filter(([name, entry]) => profile.allowedTools.includes(name)
      && workModeRefusal(profile.workMode, hasPlanPermission(entry), name) === null)
    .map(([name, entry]) => {
      const schema = v.safeParse(JsonObjectSchema, asSchema(entry.inputSchema).jsonSchema);
      const description = (toolDescription(entry) ?? name).replace(/\s+/gu, ' ').trim().replace(/\.$/u, '');

      return schema.success ? { name, description, inputSchema: JSON.stringify(schema.output) } : { name, description };
    });
}

/** One crafted tool's declaration: its body takes what its author wrote, so its arguments are its own. */
function craftedMemberDeclaration(entry: CraftedDeclaration): MemberDeclaration {
  return {
    full: `/** ${craftedToolDescription(entry.name, entry.description).replace(/\*\//g, '* /')} */\n${entry.name}(...args: unknown[]): Promise<unknown>;`,
    call: `${entry.name}(...args)`,
  };
}

/** The `tools.*` declaration of crafted tools; each native tool is declared by its own schema. */
export function renderCraftedToolsDeclaration(crafted: readonly CraftedDeclaration[]): string {
  const lines = crafted.flatMap((entry) => craftedMemberDeclaration(entry).full.split('\n').map((line) => `  ${line}`));

  return `export declare const ${CRAFTED_TOOL_NAMESPACE}: {\n${lines.join('\n')}\n};\n`;
}

/**
 * A tool as a catalog record: its own schema and description, one argument object, run by its own `execute`. A
 * program's `tools.<name>(input)` and a caller outside eval (`callOperation`) run this same record.
 */
function toolOperation(name: string, entry: ToolSet[string]): Served | null {
  const { execute } = entry;

  if (name === SANDBOX_TOOL || execute === undefined) return null;
  const stated = v.safeParse(JsonObjectSchema, asSchema(entry.inputSchema).jsonSchema);
  const planAllowed = hasPlanPermission(entry);

  const op = defineOperation({
    ns: CRAFTED_TOOL_NAMESPACE, name, help: toolDescription(entry) ?? name, slate: false,
    // What a tool does is its own to say; one a Plan turn may run observes.
    impact: planAllowed ? 'observe' : 'execute', plan: planAllowed,
    input: statedInput(stated.success ? stated.output : { type: 'object' }), output: v.unknown(),
  });

  return serve(op, async (input, { callId, signal }) => {
    const result = await execute(input, { toolCallId: callId, messages: [], context: undefined, ...(signal !== undefined && { abortSignal: signal }) });

    return result === undefined ? null : decodeJsonValue({ value: result });
  });
}

const CraftedDeclarationsSchema = v.object({ craftedDeclarations: v.function() });

/** The crafted tools `eval` holds now, by name and what each is for; none where it holds no crafted set. */
function craftedSet(sandbox: ToolSet[string] | undefined): readonly CraftedDeclaration[] {
  const declared = v.safeParse(CraftedDeclarationsSchema, sandbox);

  if (!declared.success) return [];

  return v.parse(v.array(v.object({ name: v.string(), description: v.string() })), declared.output.craftedDeclarations());
}

const ProgramResultSchema = v.object({ result: v.optional(v.unknown()) });

/**
 * Each crafted tool `eval` holds, as a record that runs its body as a program through that `eval`: a body is defined
 * only in a program, so a caller outside one reaches it the way a program does.
 */
function craftedOperations(sandbox: ToolSet[string] | undefined, crafted: readonly CraftedDeclaration[]): Served[] {
  const execute = sandbox?.execute;

  if (execute === undefined) return [];

  return crafted.map(({ name, description }) => serve(defineOperation({
    ns: CRAFTED_TOOL_NAMESPACE, name, help: craftedToolDescription(name, description), slate: false,
    impact: 'execute', plan: false, input: statedInput({ type: 'object' }), output: v.unknown(),
  }), async (input, { callId, signal }) => {
    const code = `return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`;
    const ran = await execute({ code }, { toolCallId: callId, messages: [], context: undefined, ...(signal !== undefined && { abortSignal: signal }) });
    const { result } = v.parse(ProgramResultSchema, decodeJsonValue({ value: ran }));

    return result ?? null;
  }));
}

/** `tools.*`: each tool as its record; `signal` is the calling program's, so a tool it reaches stops with its eval. */
export function toolsNamespace(tools: ToolSet, signal: AbortSignal | undefined): CodemodeProvider {
  const crafted = craftedSet(tools[SANDBOX_TOOL]);

  // A crafted name shadows a native one, as a program's own definition does.
  const named = new Map([...Object.entries(tools).flatMap(([name, entry]) => toolOperation(name, entry) ?? []), ...craftedOperations(tools[SANDBOX_TOOL], crafted)]
    .map((record) => [record.op.name, record]));

  const records = [...named.values()];
  const craftedByName = new Map(crafted.map((entry) => [entry.name, entry]));

  return {
    name: CRAFTED_TOOL_NAMESPACE,
    // What `describe` answers for each: a native tool by its own input schema, a crafted one as the turn's prompt
    // declares it. The eval docstring lists none: they are the model's own tools, already in its tool list and prompt.
    declarations: Object.fromEntries(records.map(({ op }) => {
      const craftedEntry = craftedByName.get(op.name);

      return [op.name, craftedEntry === undefined ? objectInputDeclaration(op) : craftedMemberDeclaration(craftedEntry)];
    })),
    positionalArgs: true,
    operations: records,
    tools: Object.fromEntries(records.map((record) => [record.op.name, {
      description: record.op.help,
      planAllowed: allowedInPlan(record.op),
      execute: async (...args: unknown[]) => {
        const input = v.safeParse(JsonObjectSchema, args[0] === undefined ? {} : args[0]);
        const { name } = record.op;

        return branchableToolCall(() => settle(Effect.gen(function* () {
          if (!input.success || args.length > 1) {
            return yield* new KinuError('bad_input', `tools.${name}(input): input must be one JSON object, the same shape the native \`${name}\` tool takes`);
          }

          const answered = yield* Effect.promise(() => record.run(input.output, { callId: `codemode-${nanoid()}`, ...(signal !== undefined && { signal }) }));

          return answered.value;
        })));
      },
    }])),
  };
}

/**
 * What a program reaches, the same on every backend: `tools.*` (the turn's external tools in this mode, then its native
 * tools over them), then each namespace, every one held to the role's reach and the mode. A backend only runs it.
 */
function programProviders(input: {
  readonly surface: { readonly native: ToolSet; readonly external: () => ToolSet };
  readonly namespaces: readonly CodemodeProvider[];
  readonly reach: ToolSurfaceNarrowing;
  readonly mode: WorkMode;
  readonly signal: AbortSignal | undefined;
}): CodemodeProvider[] {
  const { reach, mode } = input;
  const reached = (tools: ToolSet): ToolSet => Object.fromEntries(Object.entries(tools).filter(([name]) => reach.allowsTool(name)));
  // A native name shadows an external one.
  const tools = toolsNamespace({ ...toolsInWorkMode(mode, reached(input.surface.external())), ...reached(input.surface.native) }, input.signal);

  return [...reach.narrowProviders([tools]), ...providersInWorkMode(mode, reach.narrowProviders(input.namespaces))];
}

/**
 * One program as its call reaches it, the same on every backend: what it reaches (`programProviders`), `tools.*` holding
 * each crafted tool's failure census under its name (the body the program defines replaces it), and the `describe` the
 * program reads, declaring every namespace it reaches, `tools.*` among them. A backend binds and runs it.
 */
export function programSurface(input: Parameters<typeof programProviders>[0] & { readonly crafted: readonly CraftedDeclaration[] }) {
  // A crafted tool's census: what its body threw, thrown again as the host's failure under the tool's own name.
  const failures: CodemodeProvider['tools'] = Object.fromEntries(input.crafted.map((entry) => [entry.name, {
    description: entry.description,
    execute: async (...args: unknown[]) => {
      const failure = v.parse(v.object({ message: v.string(), name: v.string(), code: v.nullable(v.string()) }), args[0]);

      return settle(Effect.die(Object.assign(new Error(failure.message), { name: failure.name, code: failure.code })));
    },
  }]));

  const providers = programProviders(input).map((provider) => (provider.name === CRAFTED_TOOL_NAMESPACE
    ? { ...provider, tools: { ...provider.tools, ...failures } }
    : provider));

  return { providers, describe: describeProgramSource(programDeclarations(providers)) };
}

/** Each member's declared impact, by the operation it serves in `providers`, for its binding (`codemodeFunction`). */
export function servedImpacts(providers: readonly CodemodeProvider[]): MemberImpacts {
  const declared = new Map(providers.flatMap((provider) => (provider.operations ?? []).map((served) => [`${provider.name}/${served.op.name}`, served.op.impact] as const)));

  return (namespace, member) => declared.get(`${namespace}/${member}`) ?? null;
}

/** `tools.*` members, as `toolsNamespace` builds them. */
export function nativeToolFunctions(tools: ToolSet, signal: AbortSignal | undefined): CodemodeProvider['tools'] {
  return toolsNamespace(tools, signal).tools;
}

function accountedTool(namespace: string, member: string, owner: string | undefined): string {
  if (namespace === CRAFTED_TOOL_NAMESPACE) return member;

  if (owner !== undefined) return owner;

  if (member === 'exec') return 'shell';

  // A machine's own files are the `file` operations, so their failures are `file`'s, not the machine's.
  return member.startsWith(`${MACHINE_FILES}.`) ? 'file' : `${namespace}.${member}`;
}

export function codemodeFunction<Result>(namespace: string, member: string, invoke: (...args: unknown[]) => Promise<Result>, impact: Impact | null = null) {
  const owner = Object.entries(TOOL_REACH).find(([name, reach]) => name === namespace && reach.codemode === namespace);
  const tool = accountedTool(namespace, member, owner?.[0]);

  // `impact`: what the operation it serves declares, so a program's record says what the call does (`call-effects.ts`).
  const call = bindProgramCall({ tool, op: owner === undefined ? null : member, address: { namespace, member }, impact }, async (...args: unknown[]) => {
    const value = await invoke(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  });

  return async (...args: unknown[]): Promise<JsonValue | undefined> => {
    const value = await call(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  };
}

/**
 * A program's crafted tools, defined in its scope ahead of its code: a body reads the caller's `workspace`, `db` and
 * `tools`. `tools[name]` enters as the host's failure census for that name.
 */
export function renderCraftedDefinitions(crafted: readonly CraftedToolSource[]): string {
  const definitions = crafted.map((entry) => {
    const parseError = parsesAsExpression(entry.code);

    const factory = parseError === null
      // Async: the gate admits top-level `await`, which in a sync arrow is a SyntaxError that breaks the program.
      ? `async () => (\n${entry.code}\n)`
      : `() => { throw new Error(${JSON.stringify(`stored source does not parse: ${parseError}`)}); }`;

    return `  ${JSON.stringify(entry.name)}: __kinu.defineCrafted(${JSON.stringify(entry.name)}, ${factory}, tools[${JSON.stringify(entry.name)}]),`;
  });

  return ['Object.assign(tools, {', ...definitions, '});'].join('\n');
}

/**
 * The caller's reach as a slate holds it: every namespace narrowed to the members a slate reaches. A crafted tool's
 * body runs on these providers too, so what a slate cannot call directly it cannot call through a tool either.
 * `owner`: the owner's own slate calling as the owner, which alone keeps `agents`.
 */
export function slateToolReach(caller: ToolSurfaceNarrowing, owner = false): ToolSurfaceNarrowing {
  const allowsNamespace = (name: string) => name !== 'agent' && (owner || name !== 'agents') && caller.allowsNamespace(name);

  return {
    allowsTool: (name) => name !== 'agents' && name !== 'agent' && name !== 'eval' && caller.allowsTool(name),
    allowsNamespace,
    narrowProviders: (providers) => providers.filter((provider) => allowsNamespace(provider.name)).map(slateMembersOf),
  };
}

/** A namespace with only the members a slate reaches. */
function slateMembersOf<P extends { readonly name: string }>(provider: P): P {
  if (!('tools' in provider) || typeof provider.tools !== 'object' || provider.tools === null) return provider;
  const tools = Object.fromEntries(Object.entries(provider.tools).filter(([member]) => slateReaches({ namespace: provider.name, member })));

  return { ...provider, tools };
}

/** `namespace.member` among `providers`, or why it is not: out of reach (denied), or no such member (missing). */
function codemodeMember(providers: readonly CodemodeProvider[], namespace: string, member: string) {
  const provider = providers.find((candidate) => candidate.name === namespace);

  if (provider === undefined) return Effect.fail(new KinuError('denied', `${namespace} is not within this actor's reach right now`));
  const entry = Object.hasOwn(provider.tools, member) ? provider.tools[member] : undefined;

  if (entry === undefined) return Effect.fail(new KinuError('missing', `${namespace} has no member ${member}; it offers ${Object.keys(provider.tools).join(', ')}`));

  return Effect.succeed(entry);
}

/** Refuses exactly as {@link callCodemodeMember} would, without calling: for a member run elsewhere once allowed. */
export function requireCodemodeMember(providers: readonly CodemodeProvider[], namespace: string, member: string): void {
  return settleSync(Effect.asVoid(codemodeMember(providers, namespace, member)));
}

/** A held slate stub is not a grant: reach is re-resolved per call. */
export async function callCodemodeMember(providers: readonly CodemodeProvider[], namespace: string, member: string, args: readonly JsonValue[]): Promise<JsonValue | undefined> {
  const call = codemodeFunction(namespace, member, () => settle(Effect.gen(function* () {
    const entry = yield* codemodeMember(providers, namespace, member);

    return yield* Effect.promise(() => Promise.resolve(entry.execute(...args)));
  })));

  return call(...args);
}

export type { JsonValue };

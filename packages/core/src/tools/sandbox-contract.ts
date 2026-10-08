/** Codemode sandbox contract: namespace names, the crafted `tools.*` declaration, and crafted-tool labelling. */

import { Effect } from 'effect';
import * as v from 'valibot';
import { asSchema, type ToolSet } from 'ai';
import { JsonObjectSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { hasPlanPermission, workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import { branchableToolCall, bindProgramCall } from './outcome';
import { TOOL_REACH, CODEMODE_CODE_DESCRIPTION, type ToolSurfaceNarrowing } from './registry';
import { slateReaches } from '../slates/surface';
import { KinuError, settle, settleSync } from '../obs';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider } from '../types/codemode';
import { parsesAsExpression } from '../craft/source';
import type { CraftedToolSource } from './crafted-executor';
import { toolDescription } from '../utils/tool-description';
import { allowedInPlan, defineOperation, serve, statedInput, type Served } from '../operations/operation';
import { operationInputSchema } from './operation-surfaces';

export {
  CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type CodemodeResult,
} from '../types/codemode';

/** A program cannot call `eval` from inside itself, so declarations and bindings skip it. */
const SANDBOX_TOOL = 'eval';

export function craftedToolDescription(name: string, description?: string): string {
  return description === undefined || description === '' ? `Crafted tool: ${name}` : description;
}


/** `eval`'s one input: the program it runs. */
const PROGRAM = defineOperation({
  ns: 'eval', name: 'run', slate: false, impact: 'execute', plan: true,
  help: 'Run a JavaScript program over the namespaces this turn reaches.',
  input: v.strictObject({ code: v.pipe(v.string(), v.description(CODEMODE_CODE_DESCRIPTION)) }),
  output: v.unknown(),
});

const CODEMODE_INPUT = operationInputSchema(PROGRAM);

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

/** The `tools.*` declaration of crafted tools; each native tool is declared by its own schema. */
export function renderCraftedToolsDeclaration(crafted: readonly CraftedDeclaration[]): string {
  const lines = crafted.flatMap((entry) => [
    `  /** ${craftedToolDescription(entry.name, entry.description).replace(/\*\//g, '* /')} */`,
    `  ${entry.name}(...args: unknown[]): Promise<unknown>;`,
  ]);

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

const ProgramResultSchema = v.object({ result: v.optional(v.unknown()) });

/**
 * Each crafted tool `eval` holds, as a record that runs its body as a program through that `eval`: a body is defined
 * only in a program, so a caller outside one reaches it the way a program does.
 */
function craftedOperations(sandbox: ToolSet[string] | undefined): Served[] {
  const declared = v.safeParse(CraftedDeclarationsSchema, sandbox);
  const execute = sandbox?.execute;

  if (!declared.success || execute === undefined) return [];
  const crafted = v.parse(v.array(v.object({ name: v.string(), description: v.string() })), declared.output.craftedDeclarations());

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
  // A crafted name shadows a native one, as a program's own definition does.
  const named = new Map([...Object.entries(tools).flatMap(([name, entry]) => toolOperation(name, entry) ?? []), ...craftedOperations(tools[SANDBOX_TOOL])]
    .map((record) => [record.op.name, record]));

  const records = [...named.values()];

  return {
    name: CRAFTED_TOOL_NAMESPACE,
    // Declared by each tool's own schema, never here.
    types: '',
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

/** `tools.*` members, as `toolsNamespace` builds them. */
export function nativeToolFunctions(tools: ToolSet, signal: AbortSignal | undefined): CodemodeProvider['tools'] {
  return toolsNamespace(tools, signal).tools;
}

/** Failures of these members are accounted to `file`, not the exposing namespace. */
const FILE_MEMBERS = ['readFile', 'writeFile', 'editFile', 'readdir', 'exists', 'stat', 'mkdir', 'remove'];

function accountedTool(namespace: string, member: string, owner: string | undefined): string {
  if (namespace === CRAFTED_TOOL_NAMESPACE) return member;

  if (owner !== undefined) return owner;

  if (member === 'exec') return 'shell';

  return FILE_MEMBERS.includes(member) ? 'file' : `${namespace}.${member}`;
}

export function codemodeFunction<Result>(namespace: string, member: string, invoke: (...args: unknown[]) => Promise<Result>) {
  const owner = Object.entries(TOOL_REACH).find(([name, reach]) => name === namespace && reach.codemode === namespace);
  const tool = accountedTool(namespace, member, owner?.[0]);

  const call = bindProgramCall({ tool, op: owner === undefined ? null : member }, async (...args: unknown[]) => {
    const value = await invoke(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  }, namespace !== CRAFTED_TOOL_NAMESPACE);

  return async (...args: unknown[]): Promise<JsonValue | undefined> => {
    const value = await call(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  };
}

/**
 * A program's crafted tools, defined in its scope ahead of its code: a body reads the caller's `workspace`, `state`
 * and `tools`. `tools[name]` enters as the host's failure census for that name.
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

export function craftedFailureFunctions(crafted: readonly CraftedDeclaration[]): CodemodeProvider['tools'] {
  const functions: CodemodeProvider['tools'] = {};

  for (const entry of crafted) {
    functions[entry.name] = {
      description: entry.description,
      execute: async (...args) => {
        const failure = v.parse(v.object({ message: v.string(), name: v.string(), code: v.nullable(v.string()) }), args[0]);

        return settle(Effect.die(Object.assign(new Error(failure.message), { name: failure.name, code: failure.code })));
      },
    };
  }

  return functions;
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

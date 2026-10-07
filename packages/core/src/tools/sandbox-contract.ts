/** Codemode sandbox contract: namespace names, the crafted `tools.*` declaration, and crafted-tool labelling. */

import { Effect } from 'effect';
import * as v from 'valibot';
import { asSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import { JsonObjectSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { hasPlanPermission, workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import { branchableToolCall, bindProgramCall } from './outcome';
import { TOOL_REACH, CODEMODE_CODE_DESCRIPTION, type ToolSurfaceNarrowing } from './registry';
import { KinuError, settle } from '../obs';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider } from '../types/codemode';
import { parsesAsExpression } from '../craft/source';
import type { CraftedToolSource } from './crafted-executor';
import { toolDescription } from '../utils/tool-description';

export {
  CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type CodemodeResult,
} from '../types/codemode';

/** A program cannot call `eval` from inside itself, so declarations and bindings skip it. */
const SANDBOX_TOOL = 'eval';

export function craftedToolDescription(name: string, description?: string): string {
  return description === undefined || description === '' ? `Crafted tool: ${name}` : description;
}


const CodemodeInputSchema = z.object({ code: z.string().describe(CODEMODE_CODE_DESCRIPTION) });

/** Shared by both backends; CF reassigns it over `createCodeTool`'s own schema. */
export function codemodeInputSchema(): typeof CodemodeInputSchema {
  return CodemodeInputSchema;
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

/** `signal` is the calling program's: a tool it reaches here is stopped with the eval that called it. */
export function nativeToolFunctions(tools: ToolSet, signal: AbortSignal | undefined): CodemodeProvider['tools'] {
  const out: Record<string, CodemodeProvider['tools'][string]> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;

    if (name === SANDBOX_TOOL || execute === undefined) continue;
    out[name] = {
      description: toolDescription(tool) ?? name,
      planAllowed: hasPlanPermission(tool),
      execute: async (...args: unknown[]) => {
        const input = v.safeParse(JsonObjectSchema, args[0] === undefined ? {} : args[0]);

        return branchableToolCall(() => settle(Effect.gen(function* () {
          if (!input.success || args.length > 1) {
            return yield* new KinuError('bad_input', `tools.${name}(input): input must be one JSON object, the same shape the native \`${name}\` tool takes`);
          }

          const output = input.output;
          const options = { toolCallId: 'codemode-' + nanoid(), messages: [], context: undefined, ...(signal !== undefined && { abortSignal: signal }) };
          const result = yield* Effect.promise(() => Promise.resolve(execute(output, options)));

          return result === undefined ? undefined : decodeJsonValue({ value: result });
        })));
      },
    };
  }

  return out;
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

/** Slates inherit caller reach but may neither delegate nor steer the actor. */
export function slateToolReach(caller: ToolSurfaceNarrowing): ToolSurfaceNarrowing {
  const allowsNamespace = (name: string) => name !== 'agent' && name !== 'agents' && caller.allowsNamespace(name);

  return {
    allowsTool: (name) => name !== 'agents' && name !== 'agent' && name !== 'eval' && caller.allowsTool(name),
    allowsNamespace,
    narrowProviders: (providers) => providers.filter((provider) => allowsNamespace(provider.name)),
  };
}

/** A held slate binding is not a grant: reach is re-resolved per call. */
export async function callCodemodeMember(providers: readonly CodemodeProvider[], namespace: string, member: string, args: readonly JsonValue[]): Promise<JsonValue | undefined> {
  const call = codemodeFunction(namespace, member, () => settle(Effect.gen(function* () {
    const provider = providers.find((candidate) => candidate.name === namespace);

    if (provider === undefined) return yield* new KinuError('denied', `${namespace} is not within this actor's reach right now`);
    const entry = Object.hasOwn(provider.tools, member) ? provider.tools[member] : undefined;

    if (entry === undefined) return yield* new KinuError('missing', `${namespace} has no member ${member}; it offers ${Object.keys(provider.tools).join(', ')}`);

    return yield* Effect.promise(() => Promise.resolve(entry.execute(...args)));
  })));

  return call(...args);
}

export type { JsonValue };

/** Codemode sandbox contract: namespace names, the crafted `tools.*` declaration, and crafted-tool labelling. */

import * as v from 'valibot';
import type { Schema, ToolSet } from 'ai';
import { jsonSchema } from 'ai';
import { JsonObjectSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { hasPlanPermission, workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import { branchableToolCall, bindProgramCall } from './outcome';
import { TOOL_REACH, CODEMODE_CODE_DESCRIPTION, type ToolSurfaceNarrowing } from './registry';
import { toolInputViolation } from './tool-schema';
import { KinuError } from '../obs';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider } from '../types/codemode';

export {
  CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type CodemodeResult,
} from '../types/codemode';

/** A program cannot call `eval` from inside itself, so declarations and bindings skip it. */
const SANDBOX_TOOL = 'eval';

export function craftedToolDescription(name: string, description?: string): string {
  return description === undefined || description === '' ? `Crafted tool: ${name}` : description;
}


/** Shared by both backends; CF reassigns it over `createCodeTool`'s own schema. */
export function codemodeInputSchema(): Schema<{ code: string }> {
  return jsonSchema<{ code: string }>({
    type: 'object',
    properties: { code: { type: 'string', description: CODEMODE_CODE_DESCRIPTION } },
    required: ['code'],
  });
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

export function craftedToolDeclarations(
  tools: ToolSet,
  profile: { readonly workMode: WorkMode; readonly allowedTools: readonly string[] },
): readonly CraftedDeclaration[] {
  const sandbox = tools[SANDBOX_TOOL];

  if (!sandbox || !profile.allowedTools.includes(SANDBOX_TOOL)
    || workModeRefusal(profile.workMode, hasPlanPermission(sandbox), SANDBOX_TOOL) !== null
    || !('craftedDeclarations' in sandbox)) return [];
  const read = v.parse(v.function(), sandbox.craftedDeclarations);

  return v.parse(v.array(v.object({ name: v.string(), description: v.string() })), read());
}

/** The `tools.*` declaration of crafted tools; each native tool is declared by its own schema. */
export function renderCraftedToolsDeclaration(crafted: readonly CraftedDeclaration[]): string {
  const lines = crafted.flatMap((entry) => [
    `  /** ${craftedToolDescription(entry.name, entry.description).replace(/\*\//g, '* /')} */`,
    `  ${entry.name}(...args: unknown[]): Promise<unknown>;`,
  ]);

  return `export declare const ${CRAFTED_TOOL_NAMESPACE}: {\n${lines.join('\n')}\n};\n`;
}

function receivedKind(argument: { readonly value: unknown }): string {
  if (v.is(v.number(), argument.value)) return 'a number';

  if (v.is(v.boolean(), argument.value)) return 'a boolean';

  return Array.isArray(argument.value) ? 'an array' : 'an object';
}

/** Omitted reads as empty text; any other non-string is refused here. */
export function codemodeText(argument: { readonly value: unknown; readonly parameter: string }): string {
  if (argument.value === undefined || argument.value === null) return '';
  const text = v.safeParse(v.string(), argument.value);

  if (!text.success) throw new KinuError('bad_input', `${argument.parameter} takes a string, not ${receivedKind(argument)}`);

  return text.output;
}

export function nativeToolFunctions(tools: ToolSet): CodemodeProvider['tools'] {
  const out: Record<string, CodemodeProvider['tools'][string]> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;

    if (name === SANDBOX_TOOL || execute === undefined) continue;
    out[name] = {
      description: tool.description ?? name,
      planAllowed: hasPlanPermission(tool),
      execute: async (...args: unknown[]) => {
        const input = v.safeParse(JsonObjectSchema, args[0] === undefined ? {} : args[0]);

        return branchableToolCall(async () => {
          if (!input.success || args.length > 1) {
            throw new KinuError('bad_input', `tools.${name}(input): input must be one JSON object, the same shape the native \`${name}\` tool takes`);
          }

          const violation = await toolInputViolation(tool, input.output);

          if (violation !== null) throw new KinuError('bad_input', `tools.${name}(input) does not match the \`${name}\` tool's schema: ${violation}`);
          const result = await execute(input.output, { toolCallId: 'codemode-' + nanoid(), messages: [] });

          return result === undefined ? undefined : decodeJsonValue({ value: result });
        });
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

  const call = bindProgramCall({ tool, action: owner === undefined ? null : member }, async (...args: unknown[]) => {
    const value = await invoke(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  }, namespace !== CRAFTED_TOOL_NAMESPACE);

  return async (...args: unknown[]): Promise<JsonValue | undefined> => {
    const value = await call(...args);

    return value === undefined ? undefined : decodeJsonValue({ value });
  };
}

export function craftedFailureFunctions(crafted: readonly CraftedDeclaration[]): CodemodeProvider['tools'] {
  const functions: CodemodeProvider['tools'] = {};

  for (const entry of crafted) {
    functions[entry.name] = {
      description: entry.description,
      execute: async (...args) => {
        const failure = v.parse(v.object({ message: v.string(), name: v.string(), code: v.nullable(v.string()) }), args[0]);
        throw Object.assign(new Error(failure.message), { name: failure.name, code: failure.code });
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
  const call = codemodeFunction(namespace, member, async () => {
    const provider = providers.find((candidate) => candidate.name === namespace);

    if (provider === undefined) throw new KinuError('denied', `${namespace} is not within this actor's reach right now`);
    const entry = Object.hasOwn(provider.tools, member) ? provider.tools[member] : undefined;

    if (entry === undefined) throw new KinuError('missing', `${namespace} has no member ${member}; it offers ${Object.keys(provider.tools).join(', ')}`);

    return entry.execute(...args);
  });

  return call(...args);
}

export type { JsonValue };

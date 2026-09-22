/**
 * The codemode sandbox contract: what a program the model writes can reach.
 *
 * `eval` runs a JavaScript program in a fresh isolate. The program
 * sees:
 *
 *   tools.<name>(input)   EVERY tool the agent has on this turn — the native
 *                         builtins (`file`, `shell`, `memory`, `tasks`, `web`,
 *                         `agents`, `report`, …) with the same input object
 *                         the native call takes, and every crafted tool the
 *                         agent saved with `workspace.createTool`, called with
 *                         whatever arguments its own source declares.
 *   <executor>.*          one namespace per live execution environment
 *                         (`workspace`, `sandbox`, `device`, `parent`).
 *   state.*               a key/value store that survives between programs.
 *   <projection>.*        the codemode projections (`memory`, `tasks`, `web`,
 *                         `agents`, `agent`, `release`, `report`).
 *   require(), fetch      a Node-style `require` for `fs`, `path`,
 *                         `child_process` and the other builtins, and a real
 *                         `fetch` — both provided by the backend's prelude.
 *
 * This module owns the cross-backend parts of that: the namespace names, the
 * declaration text the model reads for `tools.*`, and the labelling of a
 * crafted tool. There is no second callable form and no refusing alias: a name
 * the declarations list is a name the program can call.
 */

import * as v from 'valibot';
import type { Schema, ToolSet } from 'ai';
import { jsonSchema } from 'ai';
import { JsonObjectSchema, JsonValueSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { hasPlanPermission, workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import { branchableToolCall, bindProgramCall } from './outcome';
import { TOOL_REACH, CODEMODE_CODE_DESCRIPTION, type ToolSurfaceNarrowing } from './registry';
import { KinuError } from '../obs';
import { CRAFTED_TOOL_NAMESPACE, type CodemodeProvider } from '../types/codemode';

export {
  CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type CodemodeResult,
} from '../types/codemode';

/** The sandbox's own entry. A program cannot call `eval` from inside
 *  itself, so the declaration and the bindings below both skip it: callers
 *  hand in the whole finished surface. */
const SANDBOX_TOOL = 'eval';

/** What a crafted tool with no stored description is labelled. One spelling,
 *  so the advertised set reads the same however it was assembled. */
export function craftedToolDescription(name: string, description?: string): string {
  return description === undefined || description === '' ? `Crafted tool: ${name}` : description;
}

/** The first sentence of a tool description — what a declaration's JSDoc
 *  carries. The native tools' full doctrine is on the native schema already;
 *  the sandbox declaration only has to name the tool and its input shape. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const match = /^(.+?[.!?])(\s|$)/.exec(line);

  return (match?.[1] ?? line).trim();
}

const SchemaObjectSchema = v.looseObject({
  type: v.optional(v.union([v.string(), v.array(v.string())])),
  properties: v.optional(JsonObjectSchema),
  required: v.optional(v.array(v.string())),
  items: v.optional(JsonValueSchema),
  enum: v.optional(v.array(JsonValueSchema)),
  const: v.optional(JsonValueSchema),
  anyOf: v.optional(v.array(JsonValueSchema)),
  oneOf: v.optional(v.array(JsonValueSchema)),
});

/**
 * Render a JSON Schema (already parsed as JSON) as a TypeScript type, compactly.
 *
 * Deliberately shallow on the exotic corners — a schema this cannot read renders
 * as `unknown`, never as a throw: a declaration block that fails to render is a
 * tool the model cannot see, which is worse than a loosely typed one.
 */
export function jsonSchemaToTs(schema: JsonValue | undefined, depth = 0): string {
  if (depth > 6) return 'unknown';
  const parsed = v.safeParse(SchemaObjectSchema, schema);

  if (!parsed.success) return 'unknown';
  const node = parsed.output;

  if (node.const !== undefined) return JSON.stringify(node.const);

  if (node.enum !== undefined) return node.enum.map((member) => JSON.stringify(member)).join(' | ');
  const variants = node.anyOf ?? node.oneOf;

  if (variants !== undefined) return variants.map((member) => jsonSchemaToTs(member, depth + 1)).join(' | ');
  const type = Array.isArray(node.type) ? node.type : [node.type];

  const rendered = type.map((member) => {
    switch (member) {
      case 'string': return 'string';
      case 'number':
      case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': return `${jsonSchemaToTs(node.items, depth + 1)}[]`;
      case 'object': {
        const properties = node.properties;

        if (properties === undefined) return 'Record<string, unknown>';
        const required = new Set(node.required ?? []);

        const fields = Object.entries(properties).map(([key, value]) => {
          const field = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);

          return `${field}${required.has(key) ? '' : '?'}: ${jsonSchemaToTs(value, depth + 1)}`;
        });

        return fields.length === 0 ? 'Record<string, unknown>' : `{ ${fields.join('; ')} }`;
      }

      case undefined:
      default: return 'unknown';
    }
  });

  return rendered.length === 0 ? 'unknown' : [...new Set(rendered)].join(' | ');
}

/** One native tool's JSON input schema, read off an AI SDK tool. `jsonSchema()`
 *  tools carry it as `.jsonSchema`; anything else renders as `unknown`. */
const NativeToolSchemaCarrier = v.looseObject({ jsonSchema: v.optional(JsonValueSchema) });

export function nativeToolInputSchema(tool: ToolSet[string]): JsonValue | undefined {
  const parsed = v.safeParse(NativeToolSchemaCarrier, tool.inputSchema);

  return parsed.success ? parsed.output.jsonSchema : undefined;
}

/** The `eval` input schema, shared by both backends so the tool's one
 *  `code` field is described one way — by CODEMODE_CODE_DESCRIPTION in
 *  registry.ts, NOT by codemode's own "async arrow function" label. CF wraps
 *  `createCodeTool` and reassigns this schema over the built tool's own; the
 *  CLI builds the `tool()` with it directly. */
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

/** The resolver travels with its tool through the same wrappers as planAllowed. */
export function withCraftedToolDeclarations<Tool extends ToolSet[string]>(
  entry: Tool,
  read: () => readonly CraftedDeclaration[],
) {
  return Object.assign(entry, { craftedDeclarations: read });
}

/** Describe only the installed sandbox and its existing invocation reach. */
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

/**
 * The `tools` declaration block the model reads: every native tool of the
 * finished surface with its input type, then every crafted tool. Native names
 * come first because they are stable across turns; the crafted set changes as
 * the agent saves tools.
 */
export function renderToolsDeclaration(
  native: ToolSet,
  crafted: readonly CraftedDeclaration[],
): string {
  const lines: string[] = [];

  for (const [name, tool] of Object.entries(native)) {
    if (name === SANDBOX_TOOL) continue;
    const input = jsonSchemaToTs(nativeToolInputSchema(tool));
    const summary = firstSentence(tool.description ?? name);
    lines.push(`  /** ${summary.replace(/\*\//g, '* /')} Same input as the native \`${name}\` tool. */`);
    lines.push(`  ${name}(input: ${input}): Promise<unknown>;`);
  }

  for (const entry of crafted) {
    lines.push(`  /** ${craftedToolDescription(entry.name, entry.description).replace(/\*\//g, '* /')} (crafted by you) */`);
    lines.push(`  ${entry.name}(...args: unknown[]): Promise<unknown>;`);
  }

  return `export declare const ${CRAFTED_TOOL_NAMESPACE}: {\n${lines.join('\n')}\n};\n`;
}

/**
 * The `tools` namespace's host functions: every native tool of a finished
 * surface, called with the one input object the native call takes. Anything
 * else answers a refusal that names the call. The tool's answer crosses the
 * sandbox boundary as JSON, which `decodeJsonValue` establishes. Both sandboxes
 * bind this; a program's `tools.shell(input)` reaches the same `shell` the model
 * calls natively.
 */
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

          const result = await execute(input.output, { toolCallId: 'codemode-' + nanoid(), messages: [] });

          return result === undefined ? undefined : decodeJsonValue({ value: result });
        });
      },
    };
  }

  return out;
}

/** The `file` tool's codemode members, which are accounted to `file` rather than
 *  to the namespace that exposed them. */
const FILE_MEMBERS = ['readFile', 'writeFile', 'editFile', 'readdir', 'exists', 'stat', 'mkdir', 'remove'];

/** Which native tool a codemode member's failures are filed under. */
function accountedTool(namespace: string, member: string, owner: string | undefined): string {
  if (namespace === CRAFTED_TOOL_NAMESPACE) return member;

  if (owner !== undefined) return owner;

  if (member === 'exec') return 'shell';

  return FILE_MEMBERS.includes(member) ? 'file' : `${namespace}.${member}`;
}

/** The host dispatcher shared by both sandboxes and by caller-scoped slate bindings. */
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

/** A local crafted definition reports a rejection through its own captured host member. */
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

/** Slates inherit caller reach, but an app may neither delegate nor steer the actor. */
export function slateToolReach(caller: ToolSurfaceNarrowing): ToolSurfaceNarrowing {
  const allowsNamespace = (name: string) => name !== 'agent' && name !== 'agents' && caller.allowsNamespace(name);

  return {
    allowsTool: (name) => name !== 'agents' && name !== 'agent' && name !== 'eval' && caller.allowsTool(name),
    allowsNamespace,
    narrowProviders: (providers) => providers.filter((provider) => allowsNamespace(provider.name)),
  };
}

/** Names and implementations are resolved together; a held slate binding is not a grant. */
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

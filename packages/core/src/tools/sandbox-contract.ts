/**
 * The codemode sandbox contract: what a program the model writes can reach.
 *
 * `execute_tools` runs a JavaScript program in a fresh isolate. The program
 * sees:
 *
 *   tools.<name>(input)   EVERY tool the agent has on this turn — the native
 *                         builtins (`file`, `run`, `memory`, `tasks`, `web`,
 *                         `agents`, `report`, …) with the same input object
 *                         the native call takes, and every crafted tool the
 *                         agent saved with `workspace.createTool`, called with
 *                         whatever arguments its own source declares.
 *   <executor>.*          one namespace per live execution environment
 *                         (`workspace`, `sandbox`, `laptop`, `parent`).
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
import type { ToolSet } from 'ai';
import { JsonObjectSchema, JsonValueSchema, decodeJsonValue, type JsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';

/** A provider's host-side result before the executor validates the VM boundary
 *  as JSON. Domain objects are allowed here; functions and symbols are not. */
export type CodemodeResult = object | string | number | boolean | null | undefined;

/**
 * A codemode sandbox provider: a named namespace of callable tools plus the
 * TypeScript declaration the model reads for it.
 *
 * `positionalArgs` states how the sandbox spreads a call: `ns.fn(a, b)` reaches
 * `execute(a, b)` when true, `execute({…})` when false. `prelude` is optional
 * sandbox-side JavaScript run after the namespace proxy exists, for members
 * that must be real in-sandbox functions (crafted tools are defined this way,
 * because their source closes over the other namespaces).
 */
export interface CodemodeProvider {
  readonly name: string;
  readonly tools: Record<string, {
    readonly description: string;
    readonly execute: (...args: unknown[]) => Promise<CodemodeResult>;
  }>;
  readonly types?: string;
  readonly positionalArgs?: boolean;
  readonly prelude?: string;
}

/** The ONE namespace every tool is callable in — native builtins and crafted
 *  tools alike — on every backend. */
export const CRAFTED_TOOL_NAMESPACE = 'tools';

/** The sandbox's own entry. A program cannot call `execute_tools` from inside
 *  itself, so the declaration and the bindings below both skip it: callers
 *  hand in the whole finished surface. */
const SANDBOX_TOOL = 'execute_tools';

/** What a crafted tool with no stored description is labelled. One spelling,
 *  so the advertised set reads the same however it was assembled. */
export function craftedToolDescription(name: string, description?: string): string {
  return description || `Crafted tool: ${name}`;
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
  description: v.optional(v.string()),
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
          const doc = v.safeParse(SchemaObjectSchema, value);
          const comment = doc.success && doc.output.description
            ? `/** ${firstSentence(doc.output.description).replace(/\*\//g, '* /')} */ `
            : '';
          return `${comment}${field}${required.has(key) ? '' : '?'}: ${jsonSchemaToTs(value, depth + 1)}`;
        });
        return fields.length === 0 ? 'Record<string, unknown>' : `{ ${fields.join('; ')} }`;
      }
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

export interface CraftedDeclaration {
  readonly name: string;
  readonly description: string;
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
 * bind this; a program's `tools.run(input)` reaches the same `run` the model
 * calls natively.
 */
export function nativeToolFunctions(tools: ToolSet): CodemodeProvider['tools'] {
  const out: Record<string, CodemodeProvider['tools'][string]> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (name === SANDBOX_TOOL || execute === undefined) continue;
    out[name] = {
      description: tool.description ?? name,
      execute: async (...args: unknown[]) => {
        const input = v.safeParse(JsonObjectSchema, args[0] === undefined ? {} : args[0]);
        if (!input.success) {
          return { error: `tools.${name}(input): input must be one JSON object, the same shape the native \`${name}\` tool takes` };
        }
        const result = await execute(input.output, { toolCallId: `codemode-${nanoid()}`, messages: [] });
        return result === undefined ? undefined : decodeJsonValue({ value: result });
      },
    };
  }
  return out;
}

export type { JsonValue };

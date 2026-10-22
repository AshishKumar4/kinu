import { Effect } from 'effect';
import * as v from 'valibot';
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { mcpCallResult } from './mcp-error';
import { KinuError, settle } from '../obs/index';
import { permitInPlan } from '../execution/work-mode';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { withClampedToolResults, type ClampToolResultOptions } from './clamp';
import { withEffectReceipt, type EffectClaimDeps } from './effect-claim';
import { mcpToolKey, suffixedMcpToolKey } from './mcp-naming';
import { revealMisrepresenting } from '../safety/untrusted-text';
import { sha256Hex } from '../safety/argument-digest';
import { registerMcpDescriptors } from './mcp-discovery';

/** An MCP tool after crossing the RPC seam, with namespacing context for dispatch. */
const SerializableToolDescriptorSchema = v.object({
  /** Registration id for `userMcp_callTool` routing. Never part of the tool key: it is a random per-registration nanoid. */
  serverId: v.string(),
  serverName: v.string(),
  name: v.string(),
  /** Tool key the LLM sees: core's `mcpToolKey(serverName, name)`, same rule on both backends. */
  toolKey: v.string(),
  description: v.optional(v.string()),
  title: v.optional(v.string()),
  /** JSON Schema (not Zod) so it survives RPC serialization. */
  inputSchema: v.optional(JsonObjectSchema),
  readOnly: v.optional(v.literal(true)),
  /** Its server says its domain is closed (`openWorldHint: false`): it reaches nothing beyond the service itself. */
  closedWorld: v.optional(v.literal(true)),
  /** The catalog entry the server was added from, so a seam can know its server by what it is, not by its name. */
  presetId: v.optional(v.string()),
});

export type SerializableToolDescriptor = v.InferOutput<typeof SerializableToolDescriptorSchema>;

export const McpToolSurfaceSchema = v.object({
  descriptors: v.array(SerializableToolDescriptorSchema),
  unavailable: v.array(v.object({ server: v.string(), reason: v.string() })),
});

/** Structural subset of the SDK `Tool`, so a version bump cannot re-shape it underneath. */
export interface RemoteMcpTool {
  name: string;
  description?: string;
  title?: string;
  annotations?: { title?: string; readOnlyHint?: boolean; openWorldHint?: boolean };
  inputSchema: unknown;
}

export interface McpToolRefusal {
  readonly server: string;
  readonly reason: string;
}

export type McpToolDescription = { readonly admitted: SerializableToolDescriptor } | { readonly refused: McpToolRefusal };

export interface ListedMcpTools {
  readonly tools: RemoteMcpTool[];
  readonly refused: McpToolRefusal[];
}

const ToolListPageSchema = v.looseObject({ tools: v.array(v.unknown()), nextCursor: v.optional(v.string()) });

const ListedToolSchema = v.looseObject({
  name: v.string(),
  description: v.optional(v.string()),
  title: v.optional(v.string()),
  annotations: v.optional(v.looseObject({ title: v.optional(v.string()), readOnlyHint: v.optional(v.boolean()), openWorldHint: v.optional(v.boolean()) })),
  inputSchema: v.optional(v.unknown()),
});

export function listMcpToolsLeniently(
  server: { readonly name: string },
  page: (cursor: string | undefined) => Promise<object>,
): Promise<ListedMcpTools> {
  return settle(Effect.gen(function* () {
    const tools: RemoteMcpTool[] = [];
    const refused: McpToolRefusal[] = [];
    let cursor: string | undefined;

    do {
      const at = cursor;
      const answer = yield* Effect.promise(() => page(at));
      const listed = v.safeParse(ToolListPageSchema, answer);

      if (!listed.success) {
        return yield* new KinuError('bad_input', `${server.name} answered tools/list without a tools array: ${JSON.stringify(answer)}`);
      }

      for (const entry of listed.output.tools) {
        const remote = v.safeParse(ListedToolSchema, entry);

        if (remote.success) tools.push({ ...remote.output, inputSchema: remote.output.inputSchema });
        else refused.push({ server: server.name, reason: `a listed tool has no name, so it is not offered: ${JSON.stringify(entry)}` });
      }

      cursor = listed.output.nextCursor;
    } while (cursor !== undefined);

    const listing: ListedMcpTools = { tools, refused };

    return listing;
  }));
}

const RemoteInputSchemaSchema = v.pipe(JsonObjectSchema, v.check((value) => !Array.isArray(value)));

/** Blank optional prose is omitted: an empty `description` would defeat the orchestrator's `??` fallback,
 *  and an empty `title` must not shadow `annotations.title`. */
export function describeMcpTool(
  server: { id: string; name: string },
  remote: RemoteMcpTool,
): McpToolDescription {
  const inputSchema = v.safeParse(RemoteInputSchemaSchema, remote.inputSchema);
  const rootType = inputSchema.success ? inputSchema.output.type : undefined;

  if (!inputSchema.success || (rootType !== undefined && rootType !== 'object')) {
    const found = inputSchema.success
      ? `its input schema's root type is ${JSON.stringify(rootType)}, not "object"`
      : `its input schema is ${schemaKind({ value: remote.inputSchema })}, not a JSON Schema object`;

    return { refused: { server: server.name, reason: `tool "${remote.name}" is not offered: ${found}` } };
  }

  const descriptor: SerializableToolDescriptor = {
    serverId: server.id,
    serverName: server.name,
    name: remote.name,
    toolKey: mcpToolKey(server.name, remote.name),
    inputSchema: inputSchema.output,
  };

  const description = nonBlank(sanitizeRemoteProse(remote.description));

  if (description !== undefined) descriptor.description = description;

  const title = nonBlank(sanitizeRemoteProse(remote.title))
    ?? nonBlank(sanitizeRemoteProse(remote.annotations?.title));

  if (title !== undefined) descriptor.title = title;

  if (remote.annotations?.readOnlyHint === true) descriptor.readOnly = true;

  if (remote.annotations?.openWorldHint === false) descriptor.closedWorld = true;

  return { admitted: descriptor };
}

function schemaKind(input: { value: unknown }): string {
  if (input.value === undefined) return 'missing';

  if (input.value === null) return 'null';

  if (v.is(v.array(v.unknown()), input.value)) return 'an array';

  return v.is(v.boolean(), input.value) ? `the boolean ${String(input.value)}` : `the scalar ${JSON.stringify(input.value)}`;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

const TAG_OPENER = /<(?=[a-zA-Z/!?])/g;

const HEADING_MARKER = /^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/gm;

const THEMATIC_BREAK = /^([ \t]{0,3})([-*_])((?:[ \t]*\2){2,}[ \t]*)$/gm;

const TILDES = /~+/g;

/** A server's prose as a quotation: misrepresenting characters shown, and HTML tags, headings, rules and
 *  strikethrough inert text. */
function quoteUntrusted(text: string): string {
  return revealMisrepresenting(text)
    .replace(TAG_OPENER, '&lt;')
    .replace(HEADING_MARKER, (_match, indent: string, marks: string) => `${indent}${marks.replace(/#/g, '\\#')}`)
    .replace(THEMATIC_BREAK, (_match, indent: string, mark: string, rest: string) => `${indent}\\${mark}${rest}`)
    .replace(TILDES, (run) => run.replace(/~/g, '\\~'));
}

function sanitizeRemoteProse(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;

  return quoteUntrusted(text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+|[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim());
}

/** Drops `""` only for keys that the admitted `inputSchema` declares optional; required keys pass through. */
export function omitEmptyOptionalArgs(
  args: JsonObject,
  inputSchema: JsonObject | undefined,
): JsonObject {
  const properties = inputSchema?.properties;

  if (!v.is(JsonObjectSchema, properties)) return args;

  const required = new Set(
    v.is(v.array(v.string()), inputSchema?.required) ? inputSchema.required : [],
  );

  const out: JsonObject = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === '' && key in properties && !required.has(key)) continue;
    out[key] = value;
  }

  return out;
}

/** A repeated key takes its server's name; every tool remains callable. */
function servedMcpDescriptors(descriptors: readonly SerializableToolDescriptor[]): SerializableToolDescriptor[] {
  const keyUses = new Map<string, number>();

  for (const descriptor of descriptors) keyUses.set(descriptor.toolKey, (keyUses.get(descriptor.toolKey) ?? 0) + 1);

  return descriptors
    .map((descriptor) => ((keyUses.get(descriptor.toolKey) ?? 0) > 1
      ? { ...descriptor, toolKey: suffixedMcpToolKey(descriptor.serverName, descriptor.name) }
      : descriptor))
    .sort(byServerThenTool);
}

/** Deterministic order (server, then tool) keeps the surface's content hash stable. */
function byServerThenTool(a: SerializableToolDescriptor, b: SerializableToolDescriptor): number {
  if (a.serverName !== b.serverName) return a.serverName < b.serverName ? -1 : 1;

  if (a.name === b.name) return 0;

  return a.name < b.name ? -1 : 1;
}

/** What a backend's MCP connections serve: descriptors, and the configured servers that produced none. */
export interface McpServedSurface {
  readonly descriptors: readonly SerializableToolDescriptor[];
  readonly unavailable: readonly { server: string; reason: string }[];
}

/**
 * Keyed by descriptor content, never a mutation watermark (which resets on cold start while rows survive).
 * The complete catalog stays host-side; discovery, not the prompt window, decides what a program reads.
 */
export class McpToolSurfaceCache<Tools> {
  private key: string | null = null;
  private built: Tools | null = null;
  private lastUnavailable: readonly { server: string; reason: string }[] = [];

  constructor(private readonly build: (descriptors: readonly SerializableToolDescriptor[]) => Promise<Tools>) {}

  /** Configured servers absent from the last served surface. */
  get unavailable(): readonly { server: string; reason: string }[] {
    return this.lastUnavailable;
  }

  async refresh(read: () => Promise<McpServedSurface>): Promise<Tools> {
    const served = await read();
    const key = sha256Hex(JSON.stringify(served.descriptors));

    this.lastUnavailable = served.unavailable;

    if (this.built !== null && key === this.key) return this.built;
    this.built = await this.build(servedMcpDescriptors(served.descriptors));
    this.key = key;

    return this.built;
  }
}

/**
 * What a program reads of one MCP result before it is cut: what the call's effect claim keeps for a replay in one row
 * (`do.sqlite.row_bytes`), at 8 bytes a character, past JSON's widest escape of 6, with room for the row's other
 * columns. The cut a model reads at once gave a program a cut, re-quoted text in place of the result it named.
 */
const PROGRAM_RESULT_MAX_CHARS = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 8;

/** MCP catalog as a callable surface; `call` is backend-owned. Only `readOnly: true` exempts a tool
 *  from the effect claim. */
export interface McpToolBuild {
  readonly call: (
    descriptor: SerializableToolDescriptor,
    args: JsonObject,
    options: ToolExecutionOptions<unknown>,
  ) => Promise<JsonValue>;
  readonly effectClaims: EffectClaimDeps;
  /** Where a result past its cut is saved whole. */
  readonly spill: NonNullable<ClampToolResultOptions['files']>;
}

export function buildMcpToolSet(
  descriptors: readonly SerializableToolDescriptor[],
  build: McpToolBuild,
): ToolSet {
  const tools: ToolSet = {};
  const readOnly = new Set<string>();

  for (const d of descriptors) {
    const entry = tool({
      description: d.description ?? `${d.serverName}/${d.name}`,
      inputSchema: jsonSchema<JsonObject>(d.inputSchema ?? { type: 'object' }),
      execute: async (args, options) => mcpCallResult(await build.call(d, args, options)),
    });

    if (d.readOnly === true) readOnly.add(d.toolKey);
    tools[d.toolKey] = d.readOnly === true ? permitInPlan(entry) : entry;
  }

  // Claim outermost (as in `buildActorTools`). No turn budget: only a program reads these, and what it hands the model
  // is charged as `eval`'s own.
  const wrapped = withEffectReceipt(
    withClampedToolResults(tools, { files: build.spill, producer: 'external_tool', maxChars: PROGRAM_RESULT_MAX_CHARS }),
    build.effectClaims,
    { safe: readOnly },
  );

  registerMcpDescriptors(wrapped, descriptors);

  return wrapped;
}


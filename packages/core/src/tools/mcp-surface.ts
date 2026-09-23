/** MCP tool surface both backends admit. A remote catalog is spent out of `stepContextLimit`
 *  minus the actor's own tool definitions; cf and CLI both price with {@link toolSurfaceTokens}. */

import * as v from 'valibot';
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import { estimateTokens } from '../llm';
import { stepContextLimit } from '../prompting/step-prune';
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/index';
import { permitInPlan } from '../execution/work-mode';
import { withClampedToolResults, type ClampToolResultOptions } from './clamp';
import { withEffectClaims, type EffectClaimDeps } from './effect-claim';
import { mcpToolKey, suffixedMcpToolKey } from './mcp-naming';

/** An MCP tool after crossing the RPC seam, with namespacing context for dispatch. */
export interface SerializableToolDescriptor {
  /** Registration id for `userMcp_callTool` routing. Never part of the tool key: it is a random per-registration nanoid. */
  serverId: string;
  serverName: string;
  name: string;
  /** Tool key the LLM sees: core's `mcpToolKey(serverName, name)`, same rule on both backends. */
  toolKey: string;
  description?: string;
  title?: string;
  /** JSON Schema (not Zod) so it survives RPC serialization. */
  inputSchema?: JsonObject;
  readOnly?: true;
}

export const SerializableToolDescriptorSchema = v.object({
  serverId: v.string(),
  serverName: v.string(),
  name: v.string(),
  toolKey: v.string(),
  description: v.optional(v.string()),
  title: v.optional(v.string()),
  inputSchema: v.optional(JsonObjectSchema),
  readOnly: v.optional(v.literal(true)),
});

export const McpToolSurfaceSchema = v.object({
  descriptors: v.array(SerializableToolDescriptorSchema),
  unavailable: v.array(v.object({ server: v.string(), reason: v.string() })),
});

/** Structural subset of the SDK `Tool`, so a version bump cannot re-shape it underneath. */
export interface RemoteMcpTool {
  name: string;
  description?: string;
  title?: string;
  annotations?: { title?: string; readOnlyHint?: boolean };
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
  annotations: v.optional(v.looseObject({ title: v.optional(v.string()), readOnlyHint: v.optional(v.boolean()) })),
  inputSchema: v.optional(v.unknown()),
});

export async function listMcpToolsLeniently(
  server: { readonly name: string },
  page: (cursor: string | undefined) => Promise<object>,
): Promise<ListedMcpTools> {
  const tools: RemoteMcpTool[] = [];
  const refused: McpToolRefusal[] = [];
  let cursor: string | undefined;

  do {
    const answer = await page(cursor);
    const listed = v.safeParse(ToolListPageSchema, answer);

    if (!listed.success) {
      throw new KinuError('bad_input', `${server.name} answered tools/list without a tools array: ${JSON.stringify(answer)}`);
    }

    for (const entry of listed.output.tools) {
      const remote = v.safeParse(ListedToolSchema, entry);

      if (remote.success) tools.push({ ...remote.output, inputSchema: remote.output.inputSchema });
      else refused.push({ server: server.name, reason: `a listed tool has no name, so it is not offered: ${JSON.stringify(entry)}` });
    }

    cursor = listed.output.nextCursor;
  } while (cursor !== undefined);

  return { tools, refused };
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

/** Line-start `## ` headings (prompting/sections.ts splits on them) and `<word>` blocks. */
const HEADING_LINE = /^#{1,6}[ \t]+/gm;

const TAG_LINE = /^<(?=\/?[a-zA-Z])/gm;

/** C0 except \t and \n, then DEL and C1; a loop because lint forbids control bytes in regex classes. */
function dropControlChars(text: string): string {
  let out = '';

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const kept = code === 0x09 || code === 0x0a || (code > 0x1f && !(code >= 0x7f && code <= 0x9f));

    if (kept) out += ch;
  }

  return out;
}

/** Normalizes third-party prose: drops control chars, collapses whitespace, neutralizes line-start
 *  directive shapes. Not a prompt-injection filter. */
function sanitizeRemoteProse(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;

  return dropControlChars(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+|[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .replace(HEADING_LINE, '')
    .replace(TAG_LINE, '&lt;');
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

/** Budget a remote MCP catalog is admitted against: `stepContextLimit` minus the actor's own tool surface. */
export interface McpSurfaceBudget {
  contextWindow: number;
  /** Null when nothing reported one. Read from the same `ModelCatalogSession` as the window. */
  modelOutputLimit: number | null;
  nativeToolTokens: number;
}

/** Estimated cost of a serialized tool surface; one scale for actor tools and descriptors. */
type ToolSurfacePriceable = ToolSet | SerializableToolDescriptor | readonly SerializableToolDescriptor[];

export function toolSurfaceTokens(surface: ToolSurfacePriceable): number {
  return estimateTokens(JSON.stringify(surface).length);
}

/** Deterministic order (server, then tool) keeps the surface's content hash stable. */
function byServerThenTool(a: SerializableToolDescriptor, b: SerializableToolDescriptor): number {
  if (a.serverName !== b.serverName) return a.serverName < b.serverName ? -1 : 1;

  if (a.name === b.name) return 0;

  return a.name < b.name ? -1 : 1;
}

export interface McpDescriptorAdmission {
  admitted: SerializableToolDescriptor[];
  deferred: { server: string; reason: string }[];
}

/** Admits as much of a remote catalog as the remaining budget carries. Prose gets equal shares of what
 *  remains; schemas are never truncated, so an unfitting descriptor is deferred whole and reported. */
export function admitMcpDescriptors(
  descriptors: readonly SerializableToolDescriptor[],
  budget: McpSurfaceBudget,
): McpDescriptorAdmission {
  const total = Math.max(0, stepContextLimit(budget) - budget.nativeToolTokens);

  const keyUses = new Map<string, number>();

  for (const descriptor of descriptors) keyUses.set(descriptor.toolKey, (keyUses.get(descriptor.toolKey) ?? 0) + 1);

  const ordered = descriptors
    .map((descriptor) => ((keyUses.get(descriptor.toolKey) ?? 0) > 1
      ? { ...descriptor, toolKey: suffixedMcpToolKey(descriptor.serverName, descriptor.name) }
      : descriptor))
    .sort(byServerThenTool);

  const admitted: SerializableToolDescriptor[] = [];
  const lost = new Map<string, number>();
  let spent = 0;

  for (const [index, descriptor] of ordered.entries()) {
    const bounded = withProseInside(descriptor, Math.floor((total - spent) / (ordered.length - index)));
    const cost = toolSurfaceTokens(bounded);

    if (spent + cost > total) {
      lost.set(descriptor.serverName, (lost.get(descriptor.serverName) ?? 0) + 1);
      continue;
    }

    spent += cost;
    admitted.push(bounded);
  }

  const reserve = budget.modelOutputLimit === null
    ? 'no reported output allowance to leave room for'
    : `this model's ${String(budget.modelOutputLimit)}-token output allowance`;

  const deferred = [...lost].map(([server, count]) => ({
    server,
    reason: `${String(count)} of its tools did not fit this turn's remaining tool budget of `
      + `${String(total)} tokens (a ${String(budget.contextWindow)}-token window less ${reserve}, and `
      + `${String(budget.nativeToolTokens)} already spent by this agent's own tools) `
      + '— those tools are absent',
  }));

  return { admitted, deferred };
}

/** Schema priced first; description then title get what the share has left. Clipped text is marked. */
function withProseInside(
  descriptor: SerializableToolDescriptor,
  share: number,
): SerializableToolDescriptor {
  if (descriptor.description === undefined && descriptor.title === undefined) return descriptor;
  const bare = { ...descriptor };
  delete bare.description;
  delete bare.title;
  let left = Math.max(0, share - toolSurfaceTokens(bare));
  const description = clampProse(descriptor.description, left);

  if (description !== undefined) left -= estimateTokens(description.length);
  const title = clampProse(descriptor.title, left);

  if (description === descriptor.description && title === descriptor.title) return descriptor;
  const bounded: SerializableToolDescriptor = { ...descriptor };

  if (description === undefined) delete bounded.description; else bounded.description = description;

  if (title === undefined) delete bounded.title; else bounded.title = title;

  return bounded;
}

/** Empty when the budget cannot carry any text: a lone ellipsis says less than the orchestrator's fallback. */
function clampProse(text: string | undefined, tokens: number): string | undefined {
  if (text === undefined) return undefined;

  if (tokens <= 0) return undefined;
  const cost = estimateTokens(text.length);

  if (cost <= tokens) return text;

  return `${text.slice(0, Math.floor(text.length * (tokens / cost)))}…`;
}

/** Admitted MCP catalog as a callable surface; `call` is backend-owned. Only `readOnly: true` exempts a tool
 *  from the effect claim, and the clamp runs inside the claim so a replay returns the published value. */
export interface McpToolBuild {
  readonly call: (
    descriptor: SerializableToolDescriptor,
    args: JsonObject,
    options: ToolExecutionOptions,
  ) => Promise<JsonValue>;
  readonly effectClaims: EffectClaimDeps;
  readonly clamp: ClampToolResultOptions;
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
      execute: async (args, options) => build.call(d, args, options),
    });

    if (d.readOnly === true) readOnly.add(d.toolKey);
    tools[d.toolKey] = d.readOnly === true ? permitInPlan(entry) : entry;
  }

  // Same clamp and spill as built-in tools, claim outermost (as in `buildActorTools`).
  return withEffectClaims(
    withClampedToolResults(tools, build.clamp),
    build.effectClaims,
    { safe: readOnly },
  );
}


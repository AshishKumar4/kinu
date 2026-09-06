/**
 * The MCP tool surface both backends admit — ONE policy, not two.
 *
 * A tool definition is not message traffic: it rides EVERY request of every
 * step of the turn, and for MCP a third party writes it. So a remote catalog
 * is spent out of the allocation the step pipeline already divides — core's
 * `stepContextLimit`, the resolved model's window minus the output allowance
 * it has to leave room for — less what the agent's OWN tool definitions
 * already spend of it. The actor's own tools come first; the third party gets
 * the remainder. Nothing here is a number somebody picked.
 *
 * The two backends reach this policy from opposite sides of their transports
 * and that is the only thing that differs about them: cf reads serialized
 * descriptors over RPC and caches the admitted build per turn
 * (`McpToolSurfaceCache`, cf-backend), while the CLI discovers over stdio at
 * session open and admits once against the session's resolved figures
 * (cli-backend). Both price with {@link toolSurfaceTokens} and admit with
 * {@link admitMcpDescriptors}, so a catalog divides identically wherever the
 * agent runs.
 */

import * as v from 'valibot';
import { estimateTokens } from '../llm';
import { stepContextLimit } from '../prompting/step-prune';
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { mcpToolKey } from './mcp-naming';

/** What an MCP tool looks like once it has crossed the RPC seam. Mirrors the
 *  fields of `@modelcontextprotocol/sdk/types.js#Tool` that the orchestrator
 *  needs, plus the namespacing context (`serverId`, `name`) so the dispatch
 *  closure can route the eventual `callMcpTool` correctly. */
export interface SerializableToolDescriptor {
  /** Registration id — how `userMcp_callTool` routes the call. Never part of
   *  the tool key: it is a random per-registration nanoid, so keying on it
   *  gave the same MCP tool a different name for every user. */
  serverId: string;
  serverName: string;
  /** Bare MCP tool name (no namespace prefix). */
  name: string;
  /** Final tool key the AI SDK / LLM sees — core's `mcpToolKey(serverName,
   *  name)`, the same rule on both backends, so a prompt or skill that
   *  names an MCP tool resolves identically wherever the agent runs.
   *  Computed once when the descriptor is built so the orchestrator and the
   *  model agree byte-for-byte. */
  toolKey: string;
  description?: string;
  title?: string;
  /** JSON Schema (not a Zod schema) — survives RPC serialization. The
   *  orchestrator passes this straight to `tool({ inputSchema: jsonSchema(...) })`. */
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  /** The server's `readOnlyHint` annotation, present exactly when it said so. */
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
  outputSchema: v.optional(JsonObjectSchema),
  readOnly: v.optional(v.literal(true)),
});
/** The whole descriptor surface `userMcp_toolDescriptors` serializes. */
export const McpToolSurfaceSchema = v.object({
  descriptors: v.array(SerializableToolDescriptorSchema),
  unavailable: v.array(v.object({ server: v.string(), reason: v.string() })),
});

/** The part of `@modelcontextprotocol/sdk/types.js#Tool` this seam reads.
 *  Structural on purpose: what crosses RPC is a plain JSON descriptor, so the
 *  seam depends on the FIELDS it forwards rather than on a nominal SDK type
 *  that a version bump can re-shape underneath it. */
export interface RemoteMcpTool {
  name: string;
  description?: string;
  title?: string;
  annotations?: { title?: string; readOnlyHint?: boolean };
  inputSchema: unknown;
  outputSchema?: unknown;
}

/**
 * One remote tool, as the descriptor that crosses the RPC seam.
 *
 * BLANK OPTIONAL PROSE IS OMITTED, not forwarded. `description: ""` is a
 * server saying nothing, and forwarding it as an empty string says something
 * different: the orchestrator's `d.description ?? "<server>/<tool>"` fallback
 * is nullish-guarded, so an empty string reached the model as a tool with NO
 * description at all instead of the synthesized one. `title` is the same
 * shape, and an empty `title` must not shadow a real `annotations.title`.
 */
export function describeMcpTool(
  server: { id: string; name: string },
  tool: RemoteMcpTool,
): SerializableToolDescriptor {
  const descriptor: SerializableToolDescriptor = {
    serverId: server.id,
    serverName: server.name,
    name: tool.name,
    toolKey: mcpToolKey(server.name, tool.name),
    inputSchema: v.parse(JsonObjectSchema, tool.inputSchema),
  };
  const description = nonBlank(tool.description);
  if (description !== undefined) descriptor.description = description;
  const title = nonBlank(tool.title) ?? nonBlank(tool.annotations?.title);
  if (title !== undefined) descriptor.title = title;
  if (tool.outputSchema) descriptor.outputSchema = v.parse(JsonObjectSchema, tool.outputSchema);
  if (tool.annotations?.readOnlyHint === true) descriptor.readOnly = true;
  return descriptor;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * What a remote MCP catalog is admitted against.
 *
 * THERE IS NO MCP NUMBER AT ALL. A tool definition is not message traffic: it
 * rides EVERY request of every step of the turn, and for MCP a third party
 * writes it. So the catalog is spent out of the allocation the step pipeline
 * already divides — core's `stepContextLimit`, the resolved model's window minus
 * the output allowance it has to leave room for — and what is left of that limit
 * for MCP is the limit minus the tool surface the actor was going to send
 * anyway. The actor's own tools come first; the third party gets the remainder.
 * Nothing here is a number somebody picked.
 */
export interface McpSurfaceBudget {
  /** The resolved model's context window, in tokens — the same figure the
   *  compaction trigger and the step-prune pass read. */
  contextWindow: number;
  /** The resolved model's output allowance, which the request has to leave room
   *  for. Read off the SAME `ModelCatalogSession` as the window, never a second
   *  source. */
  modelOutputLimit: number;
  /** What the actor's OWN tool definitions cost this turn, measured by
   *  {@link toolSurfaceTokens}. */
  nativeToolTokens: number;
}

/** The estimated cost of a serialized tool surface — ONE measure, so the
 *  actor's tools and an admitted descriptor are priced on the same scale. A
 *  budget whose two sides are counted differently is not a budget. `execute`
 *  closures and schema validators are functions and drop out of
 *  `JSON.stringify`, which leaves the description and the JSON Schema: what the
 *  request actually carries. */
export function toolSurfaceTokens<Surface>(surface: Surface): number {
  return estimateTokens(JSON.stringify(surface).length);
}

export interface McpDescriptorAdmission {
  /** In deterministic order, with prose bounded, inside the budget. */
  admitted: SerializableToolDescriptor[];
  /** One entry per server that lost tools to the budget, in the same order. */
  deferred: { server: string; reason: string }[];
}

/**
 * Admit as much of a remote catalog as this turn's remaining tool budget can
 * carry.
 *
 * ORDER IS BY (server, tool) NAME, not by connection iteration order: the
 * admitted set has to be the same on two turns that read the same rows, both so
 * the decision is reproducible and so the surface's content hash stops moving
 * for reasons nobody changed.
 *
 * PROSE GETS EQUAL SHARES of what remains, re-divided at every descriptor: the
 * first tool of a twenty-tool catalog may spend a twentieth of the budget on its
 * description, and whatever it leaves unspent returns to the rest. That is what
 * stops one server's essay from crowding out every other server, and it needs no
 * per-description percentage to tune.
 *
 * SCHEMAS ARE NEVER TRUNCATED — a clipped JSON Schema is a lie about what the
 * tool accepts, so a descriptor whose schema alone will not fit is deferred
 * whole. Deferral is REPORTED (the caller feeds `deferred` into the same
 * missing-capability channel a disconnected server uses), because a capability
 * silently absent is one the model plans without.
 */
export function admitMcpDescriptors(
  descriptors: readonly SerializableToolDescriptor[],
  budget: McpSurfaceBudget,
): McpDescriptorAdmission {
  const total = Math.max(0, stepContextLimit(budget) - budget.nativeToolTokens);
  const ordered = [...descriptors].sort((a, b) =>
    a.serverName === b.serverName
      ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      : (a.serverName < b.serverName ? -1 : 1));

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
  const deferred = [...lost].map(([server, count]) => ({
    server,
    reason: `${String(count)} of its tools did not fit this turn's remaining tool budget of `
      + `${String(total)} tokens (a ${String(budget.contextWindow)}-token window less this `
      + `model's ${String(budget.modelOutputLimit)}-token output allowance, and `
      + `${String(budget.nativeToolTokens)} already spent by this agent's own tools) `
      + '— those tools are absent',
  }));
  return { admitted, deferred };
}

/** The descriptor with its remote prose inside `share`.
 *
 *  The schema is atomic, so it is priced FIRST and the prose gets what the share
 *  has left — zero when the schema alone already fills it, which is how a fat
 *  tool loses its essay before it loses its contract. Description then title,
 *  each against what the previous one left, so the two together cannot spend the
 *  share twice. Clipped text is marked so a reader can tell a clamp from the
 *  server's own words. */
function withProseInside(
  descriptor: SerializableToolDescriptor,
  share: number,
): SerializableToolDescriptor {
  // A descriptor with no prose has nothing to bound, and a large catalog is
  // mostly these — no reason to serialize it twice to learn that.
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

/** Text within `tokens`, or nothing at all when the budget cannot carry any:
 *  a lone ellipsis says less than the synthesized `<server>/<tool>` description
 *  the orchestrator falls back to. Sliced in proportion to the measured cost, so
 *  the estimator stays the only scale in play. */
function clampProse(text: string | undefined, tokens: number): string | undefined {
  if (text === undefined) return undefined;
  if (tokens <= 0) return undefined;
  const cost = estimateTokens(text.length);
  if (cost <= tokens) return text;
  return `${text.slice(0, Math.floor(text.length * (tokens / cost)))}…`;
}

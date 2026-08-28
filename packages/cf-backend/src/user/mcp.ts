/**
 * Per-user MCP support — UserDO-side types, validation, and serialization
 * helpers. The actual MCP protocol work is done by the Cloudflare Agents SDK's
 * `MCPClientManager` (`agents/src/mcp/client.ts`). UserDO owns the
 * configuration table, the manager instance, and the OAuth callback URL.
 *
 * Why a serialized descriptor instead of the SDK's `Tool` shape?
 *   AI-SDK tools carry an `execute` closure; functions don't survive the
 *   DurableObject RPC boundary. The orchestrator reconstructs the closure
 *   locally and dispatches each call back to `UserDO.callMcpTool(...)`.
 */

import { sha256Hex } from '../lib/crypto';
import {
  JsonArraySchema, JsonObjectSchema, estimateTokens, mcpToolKey, stepContextLimit,
  type JsonObject,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as v from 'valibot';


export type McpTransport = 'auto' | 'sse' | 'streamable-http';

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
   *  name)`, the same rule the CLI backend uses, so a prompt or skill that
   *  names an MCP tool resolves identically on both backends. Computed once on
   *  UserDO so the orchestrator and the model agree byte-for-byte. */
  toolKey: string;
  description?: string;
  title?: string;
  /** JSON Schema (not a Zod schema) — survives RPC serialization. The
   *  orchestrator passes this straight to `tool({ inputSchema: jsonSchema(...) })`. */
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
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
  annotations?: { title?: string };
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

/**
 * The orchestrator's per-activation MCP tool cache, keyed by the HASH OF THE
 * DESCRIPTOR CONTENT — never by a mutation watermark. UserDO previously
 * carried a `_userMcpUpdatedAt` integer that reset to zero on every cold start
 * while its durable server rows and OAuth state survived; a reader that treated
 * zero as "never configured" silently stripped every MCP tool after an
 * eviction, and any revision mirror can miss a deletion. Deriving the key from
 * what was actually fetched has neither failure mode: cold reconstruction,
 * update, deletion and OAuth completion each invalidate exactly when the
 * durable surface differs from the cached one.
 *
 * `refresh` PROPAGATES a failed fetch or parse: the host decides what an
 * unreadable surface means (keep serving the last build, report, retry). The
 * cache itself never hides an I/O failure.
 */
export class McpToolSurfaceCache<Tools> {
  private key: string | null = null;
  private built: Tools | null = null;
  private lastUnavailable: readonly { server: string; reason: string }[] = [];

  constructor(
    private readonly build: (
      descriptors: readonly SerializableToolDescriptor[],
    ) => Promise<Tools>,
  ) {}

  /** Configured servers that produced no tools in the last served surface. */
  get unavailable(): readonly { server: string; reason: string }[] {
    return this.lastUnavailable;
  }

  /**
   * Fetch the canonical descriptor JSON, admit what this turn's remaining tool
   * budget can carry, and rebuild only when the admitted set would differ.
   *
   * The key carries BOTH budget inputs because both decide the admission: a
   * turn that switches to a smaller model must not keep serving the larger
   * model's surface, and neither must a turn whose own tool surface grew — a
   * narrowed role, a new skill set — keep serving a division that no longer
   * holds. The unavailable list follows every successfully READ surface, cached
   * or not: it describes the durable rows and the budget, not the build.
   */
  async refresh(fetchSurface: () => Promise<string>, budget: McpSurfaceBudget): Promise<Tools> {
    const raw = await fetchSurface();
    const answer = v.parse(McpToolSurfaceSchema, JSON.parse(raw));
    const admission = admitMcpDescriptors(answer.descriptors, budget);
    const key = `${await sha256Hex(raw)}:${String(budget.contextWindow)}`
      + `:${String(budget.modelOutputLimit)}:${String(budget.nativeToolTokens)}`;
    this.lastUnavailable = [...answer.unavailable, ...admission.deferred];
    if (this.built !== null && key === this.key) return this.built;
    this.built = await this.build(admission.admitted);
    this.key = key;
    return this.built;
  }
}

/** What the HTTP layer accepts when the user adds a server. */
export interface McpServerInput {
  name: string;
  serverUrl: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

/** Connection status as the SDK surfaces it. We re-derive at read time from
 *  `MCPClientManager.mcpConnections[id].connectionState` so the UI sees the
 *  live state, not whatever was last persisted. */
export type McpConnectionStatus =
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'ready'
  | 'discovering'
  | 'failed'
  | 'unknown';

export interface McpServerSummary {
  id: string;
  name: string;
  serverUrl: string;
  transport: McpTransport;
  status: McpConnectionStatus;
  error: string | null;
  toolsCount: number;
  authUrl: string | null;
  allowedTools: string[] | null;
  createdAt: number;
  updatedAt: number;
}

/** Internal config row, decoded. Not exposed across RPC; the orchestrator
 *  asks for tool descriptors directly. */
export interface McpServerConfig {
  id: string;
  name: string;
  serverUrl: string;
  transport: McpTransport;
  headers: Record<string, string> | null;
  allowedTools: string[] | null;
  createdAt: number;
  updatedAt: number;
}

const McpTransportSchema = v.picklist(['auto', 'sse', 'streamable-http']);
function isJsonRecord<Value>(value: Value): value is Value & JsonObject {
  return !Array.isArray(value) && v.is(JsonObjectSchema, value);
}

const RawMcpServerInputSchema = v.custom<JsonObject>(isJsonRecord, 'Expected a JSON object.');
const HeaderRecordSchema = v.pipe(
  RawMcpServerInputSchema,
  v.record(v.string(), v.string()),
);
const StringArraySchema = v.array(v.string());

/**
 * The canonical spelling of an MCP endpoint URL — ONE form per endpoint.
 *
 * Identity, the stored row and the origin a credential is pinned to all derive
 * from these bytes, so two spellings of one endpoint must not read as two
 * endpoints. WHATWG parsing already settles scheme case, host case, the default
 * port and percent-encoding. The fragment is dropped because it never leaves
 * the client. The path and query are left exactly as written: `/mcp` and
 * `/mcp/` are different resources to a server, and guessing otherwise would
 * silently retarget somebody's endpoint.
 */
export function canonicalMcpUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.href;
}

/**
 * Validate an `McpServerInput`. Throws with a user-readable message on
 * rejection. URL policy: `https://` always, plus `http://localhost` /
 * `http://127.0.0.1` / `http://[::1]` for local dev. The Agents SDK's
 * `MCPClientManager` already SSRF-checks; this is just a friendly upfront
 * pass so we don't store nonsense.
 *
 * The accepted URL comes back CANONICAL, and empty optional inputs come back
 * OMITTED: `headers: {}` is not a credential and must not make a row look like
 * it holds one. `allowedTools: []` is left alone — an empty allowlist means
 * "expose nothing", which is not the same statement as omitting it.
 */
export function validateMcpServerInput<Input>(input: Input): McpServerInput {
  const parsedInput = v.safeParse(RawMcpServerInputSchema, input);
  if (!parsedInput.success) {
    throw new Error('Body must be a JSON object.');
  }
  const obj = parsedInput.output;

  const name = validateMcpServerName(obj.name);

  const parsedServerUrl = v.safeParse(v.string(), obj.serverUrl);
  if (!parsedServerUrl.success || !parsedServerUrl.output.trim()) {
    throw new Error('`serverUrl` is required.');
  }
  const serverUrl = parsedServerUrl.output;
  if (!URL.canParse(serverUrl)) throw new Error('`serverUrl` is not a valid URL.');
  const parsed = new URL(serverUrl);
  const isHttps = parsed.protocol === 'https:';
  const isLocalDev = parsed.protocol === 'http:' && (
    parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1'
  );
  if (!isHttps && !isLocalDev) {
    throw new Error('`serverUrl` must use https:// (http:// allowed only for localhost).');
  }

  const parsedTransport = v.safeParse(v.nullish(McpTransportSchema), obj.transport);
  if (!parsedTransport.success) {
    throw new Error("`transport` must be one of 'auto', 'sse', 'streamable-http'.");
  }
  const transport = parsedTransport.output ?? 'auto';

  let headers: Record<string, string> | undefined;
  if (obj.headers !== undefined && obj.headers !== null) {
    const parsedHeaderObject = v.safeParse(RawMcpServerInputSchema, obj.headers);
    if (!parsedHeaderObject.success) {
      throw new Error('`headers` must be a flat object of string→string.');
    }
    const collected: Record<string, string> = {};
    for (const [k, value] of Object.entries(parsedHeaderObject.output)) {
      if (k.length === 0 || k.length > 128) throw new Error(`headers.${k} — key length out of range.`);
      const parsedValue = v.safeParse(v.string(), value);
      if (!parsedValue.success) throw new Error(`headers.${k} must be a string.`);
      collected[k] = parsedValue.output;
    }
    if (Object.keys(collected).length > 0) headers = collected;
  }

  let allowedTools: string[] | undefined;
  if (obj.allowedTools !== undefined && obj.allowedTools !== null) {
    const parsedAllowedTools = v.safeParse(JsonArraySchema, obj.allowedTools);
    if (!parsedAllowedTools.success) {
      throw new Error('`allowedTools` must be a string[] (or omitted to allow all).');
    }
    allowedTools = [];
    for (const toolName of parsedAllowedTools.output) {
      const parsedToolName = v.safeParse(v.pipe(v.string(), v.nonEmpty()), toolName);
      if (!parsedToolName.success) {
        throw new Error('`allowedTools` entries must be non-empty strings.');
      }
      allowedTools.push(parsedToolName.output);
    }
  }

  return { name, serverUrl: canonicalMcpUrl(serverUrl), transport, headers, allowedTools };
}

/**
 * THE server-name rule: present, non-blank, at most 64 characters once trimmed.
 *
 * One function because there are two write paths. `userMcp_update` carried its
 * own copy of the same two bounds under a different sentence, so a rename could
 * disagree with an add about the very name the UNIQUE index is built on. The
 * bound is on the TRIMMED value, which is what gets stored and what `lower(name)`
 * indexes.
 */
export function validateMcpServerName<Name>(name: Name): string {
  const parsed = v.safeParse(v.string(), name);
  if (!parsed.success || !parsed.output.trim()) throw new Error('`name` is required.');
  const trimmed = parsed.output.trim();
  if (trimmed.length > 64) throw new Error('`name` must be ≤ 64 characters.');
  return trimmed;
}

/** Decode an `allowed_tools` SQL column. Returns null when unset or
 *  unparseable, which the rest of the pipeline treats as "allow all". */
export function parseAllowedTools(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const parsed = v.safeParse(StringArraySchema, tolerate(() => JSON.parse(raw), 'malformed-input'));
  return parsed.success ? parsed.output : null;
}

/** Decode the `headers` SQL column into a header map. Returns null when unset
 *  or malformed, which the pipeline treats as "no custom headers". */
export function parseMcpHeaders(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  const parsed = v.safeParse(HeaderRecordSchema, tolerate(() => JSON.parse(raw), 'malformed-input'));
  return parsed.success ? parsed.output : null;
}

/**
 * The transport seam that spends an MCP server's stored credential WITHOUT
 * handing it to the SDK.
 *
 * WHY A CLOSURE AND NOT `requestInit.headers`. The Agents SDK snapshots a
 * registered server's transport options into `cf_agents_mcp_servers`:
 * `registerServer` calls `encodeMcpServerOptions`, whose `persistTransportOptions`
 * whitelist keeps `headers` and `requestInit` and `JSON.stringify`s them
 * (`agents/dist/client-zqKcsyFa.js:1022-1035,1786-1789`). A bearer token handed
 * over that way lands in plaintext DO SQL, outside this user's credential
 * envelope, and is replayed from there on every reconnect. `fetch` is NOT in
 * that whitelist, and both MCP transports route every network request through
 * it — `SSEClientTransport` for the GET stream (`sse.js:68`) and its POSTs via
 * `createFetchWithInit` (`sse.js:26,173`), `StreamableHTTPClientTransport` the
 * same (`streamableHttp.js:31-32,89,306,443`) — so the closure carries the
 * credential and the SDK stores nothing.
 *
 * `openHeaders` is asked PER REQUEST, so a rotated header is spent by the next
 * request with no reconnect and no decrypted copy held anywhere.
 *
 * THE PIN. Headers are attached only when the request's origin is the server's
 * own. The same `fetch` serves OAuth metadata discovery, which reaches an
 * authorization server that may be anywhere (`streamableHttp.js:356`), and a
 * credentialed request is never allowed to follow a redirect: `manual` means a
 * relocating endpoint fails visibly instead of forwarding the user's token to
 * whatever host the `Location` names.
 */
export function mcpCredentialTransport(
  serverUrl: string,
  openHeaders: () => Promise<Record<string, string> | null>,
): McpCredentialTransport {
  const origin = new URL(serverUrl).origin;
  return {
    fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (new URL(url.toString()).origin !== origin) return fetch(url, init);
      const credential = await openHeaders();
      if (credential === null || Object.keys(credential).length === 0) return fetch(url, init);
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(credential)) headers.set(name, value);
      return fetch(url, { ...init, headers, redirect: 'manual' });
    },
  };
}

/** The transport fragment {@link mcpCredentialTransport} contributes: the one
 *  option the SDK's persistence whitelist does NOT keep. Named because two
 *  callers spread it into a larger transport literal, and an anonymous shape
 *  there tells neither of them what they are spreading. */
export interface McpCredentialTransport {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Whether a failed MCP dispatch failed because the TRANSPORT was not
 * authorized. The one condition that justifies re-probing a live connection,
 * and it is decided by CLASS, never by prose.
 *
 * What this replaces: `/\b401\b|unauthorized/i` over `renderThrownChain`, which
 * is the whole rendered cause chain of whatever `callTool` threw. A remote tool
 * that answers "401 unauthorized from the upstream API" hands that sentence back
 * as a JSON-RPC error, the SDK raises it as an `McpError` carrying the server's
 * own words, and the matcher then tore down and re-authorized a connection that
 * was authorized fine. The text belonged to a third party; the decision did not.
 *
 * The pinned SDK classifies this itself, so nothing needs guessing:
 *
 *   `UnauthorizedError`   the transport attempted authorization and could not
 *                         complete it (`client/auth.js:7`; raised from both
 *                         transports' 401 paths — `streamableHttp.js:277,329,359`).
 *   `StreamableHTTPError` / `SseError` carry the HTTP status as `code`, so an
 *                         unresolved 401 is a NUMBER rather than a phrase
 *                         (`streamableHttp.js:12,317,364`, `sse.js:5`).
 *
 * Only those two shapes are consulted, which is what makes it structurally
 * impossible for a tool RESULT — or any wording a remote server chose — to
 * reach this decision. The `cause` chain is walked by class for the same reason:
 * a wrapper keeps the typed link, and the `seen` set keeps a cyclic chain from
 * becoming a loop.
 */
export function isMcpTransportUnauthorized(input: { cause: unknown }): boolean {
  const seen = new Set<unknown>();
  for (let error: unknown = input.cause; error instanceof Error && !seen.has(error); error = error.cause) {
    seen.add(error);
    if (error instanceof UnauthorizedError) return true;
    if ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401) return true;
  }
  return false;
}

/** Map the SDK's `MCPConnectionState` strings to our discriminated union.
 *  We avoid importing the SDK enum from a UI-adjacent module so the schema
 *  for the tests doesn't pull half the agents SDK transitively. */
export function mapConnectionStatus(state: string | undefined): McpConnectionStatus {
  switch (state) {
    case 'connecting':     return 'connecting';
    case 'authenticating': return 'authenticating';
    case 'connected':      return 'connected';
    case 'discovering':    return 'discovering';
    case 'ready':          return 'ready';
    case 'failed':         return 'failed';
    default:               return 'unknown';
  }
}

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
  JsonArraySchema, JsonObjectSchema,
  admitMcpDescriptors, McpToolSurfaceSchema,
  type JsonObject, type SerializableToolDescriptor, type McpSurfaceBudget,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as v from 'valibot';


export type McpTransport = 'auto' | 'sse' | 'streamable-http';

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
function canonicalMcpUrl(serverUrl: string): string {
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

/** The stored SDK options, read for ONE question: does the transport the SDK
 *  would restore carry request data of ours? Only the three credential-shaped
 *  fields are declared, so nothing else in the payload can be read here — the
 *  session state beside them is the SDK's business and is left alone. */
const StoredMcpServerOptionsSchema = v.object({
  transport: v.optional(v.object({
    headers: v.optional(v.unknown()),
    requestInit: v.optional(v.unknown()),
    eventSourceInit: v.optional(v.unknown()),
  })),
});

/**
 * Whether an SDK-stored `server_options` payload still holds a credential the
 * SDK would spend.
 *
 * `cf_agents_mcp_servers.server_options` is the SDK's OWN snapshot of a
 * registered server, and `restoreConnectionsFromStorage` rebuilds the live
 * transport out of it — `{ ...parsedOptions.transport, type, authProvider }`
 * (`agents/dist/client-zqKcsyFa.js:1557-1571`). So a credential that reached
 * that column is replayed to the third party on every reconnect, from outside
 * this user's encryption envelope, no matter what our own column says. Asking
 * this question of the SDK's bytes is what makes the scrub reach a row whose
 * credential column is NULL — the row a cleared credential leaves behind.
 *
 * THE THREE FIELDS. `requestInit` and `eventSourceInit` are what the plaintext
 * transport builder produced (`requestInit: { headers }` beside an
 * `eventSourceInit` wrapper, `7ba56550e^:src/user/mcp.ts:270-287`), and
 * `headers` is the third one the persistence whitelist keeps
 * (`persistTransportOptions`, `:1022-1035`). Nothing else on that whitelist can
 * hold a credential: `type`, `sessionId`, `protocolVersion`,
 * `reconnectionOptions`, `skipIssuerMetadataValidation`, `onInsufficientScope`
 * and `maxStepUpRetries` are the SDK's own connection state. Reading them as a
 * reason to rewrite would drop a resumable session on every activation and
 * re-register forever, which is why the question is about these three and not
 * about "the SDK persisted something".
 *
 * A payload that will not parse reads as holding nothing, because the SDK
 * cannot restore a credential out of bytes it cannot decode either.
 */
export function storedMcpOptionsCarryCredential(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const parsed = v.safeParse(
    StoredMcpServerOptionsSchema,
    tolerate(() => JSON.parse(raw), 'malformed-input'),
  );
  if (!parsed.success) return false;
  const transport = parsed.output.transport;
  if (!transport) return false;
  return [transport.headers, transport.requestInit, transport.eventSourceInit]
    .some((carried) => carried !== undefined && carried !== null);
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

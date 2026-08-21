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

import { JsonArraySchema, JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
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
 * Validate an `McpServerInput`. Throws with a user-readable message on
 * rejection. URL policy: `https://` always, plus `http://localhost` /
 * `http://127.0.0.1` / `http://[::1]` for local dev. The Agents SDK's
 * `MCPClientManager` already SSRF-checks; this is just a friendly upfront
 * pass so we don't store nonsense.
 */
export function validateMcpServerInput<Input>(input: Input): McpServerInput {
  const parsedInput = v.safeParse(RawMcpServerInputSchema, input);
  if (!parsedInput.success) {
    throw new Error('Body must be a JSON object.');
  }
  const obj = parsedInput.output;

  const parsedName = v.safeParse(v.string(), obj.name);
  if (!parsedName.success || !parsedName.output.trim()) throw new Error('`name` is required.');
  const name = parsedName.output;
  if (name.length > 64) throw new Error('`name` must be ≤ 64 characters.');

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
    headers = {};
    for (const [k, value] of Object.entries(parsedHeaderObject.output)) {
      if (k.length === 0 || k.length > 128) throw new Error(`headers.${k} — key length out of range.`);
      const parsedValue = v.safeParse(v.string(), value);
      if (!parsedValue.success) throw new Error(`headers.${k} must be a string.`);
      headers[k] = parsedValue.output;
    }
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

  return { name: name.trim(), serverUrl, transport, headers, allowedTools };
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

/** Build the transport options that carry custom auth headers for a private/
 *  bearer MCP server. `requestInit.headers` is the durable carrier: the MCP
 *  SDK persists it (plain JSON) and re-applies it on every (re)connect —
 *  including after DO hibernation — to BOTH the SSE GET stream (via the
 *  transport's `_commonHeaders`) and POST/Streamable requests. The
 *  `eventSourceInit.fetch` closure only selects the underlying fetch for the
 *  SSE stream in the Workers runtime; it is not serializable and does not
 *  carry the auth (the SDK re-derives headers from `requestInit` regardless).
 *  Returns undefined when the server has no custom headers. */
export function buildMcpHeaderTransportOpts(
  headers: Record<string, string> | null,
): {
  eventSourceInit: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> };
  requestInit: { headers: Record<string, string> };
} | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  return {
    eventSourceInit: {
      fetch: (url: string | URL, init?: RequestInit) => {
        const mergedHeaders = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) mergedHeaders.set(name, value);
        return fetch(url, { ...init, headers: mergedHeaders });
      },
    },
    requestInit: { headers },
  };
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

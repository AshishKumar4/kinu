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

export type McpTransport = 'auto' | 'sse' | 'streamable-http';

/** What an MCP tool looks like once it has crossed the RPC seam. Mirrors the
 *  fields of `@modelcontextprotocol/sdk/types.js#Tool` that the orchestrator
 *  needs, plus the namespacing context (`serverId`, `name`) so the dispatch
 *  closure can route the eventual `callMcpTool` correctly. */
export interface SerializableToolDescriptor {
  /** Hyphenless server id, matches the SDK's tool-name template
   *  (`tool_<serverIdNoHyphens>_<name>`). Stored alongside the raw id so
   *  the orchestrator doesn't need to recompute. */
  serverId: string;
  serverName: string;
  /** Bare MCP tool name (no namespace prefix). */
  name: string;
  /** Final tool key the AI SDK / LLM sees. Computed once on UserDO so the
   *  orchestrator and the model agree byte-for-byte. */
  toolKey: string;
  description?: string;
  title?: string;
  /** JSON Schema (not a Zod schema) — survives RPC serialization. The
   *  orchestrator passes this straight to `tool({ inputSchema: jsonSchema(...) })`. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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

const VALID_TRANSPORTS: ReadonlySet<McpTransport> = new Set<McpTransport>([
  'auto', 'sse', 'streamable-http',
]);

/**
 * Validate an `McpServerInput`. Throws with a user-readable message on
 * rejection. URL policy: `https://` always, plus `http://localhost` /
 * `http://127.0.0.1` / `http://[::1]` for local dev. The Agents SDK's
 * `MCPClientManager` already SSRF-checks; this is just a friendly upfront
 * pass so we don't store nonsense.
 */
export function validateMcpServerInput(input: unknown): McpServerInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Body must be a JSON object.');
  }
  const obj = input as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error('`name` is required.');
  if (name.length > 64) throw new Error('`name` must be ≤ 64 characters.');

  const serverUrl = obj.serverUrl;
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
    throw new Error('`serverUrl` is required.');
  }
  let parsed: URL;
  try { parsed = new URL(serverUrl); } catch { throw new Error('`serverUrl` is not a valid URL.'); }
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

  const transport: McpTransport = (() => {
    const t = obj.transport;
    if (t === undefined || t === null) return 'auto';
    if (typeof t !== 'string' || !VALID_TRANSPORTS.has(t as McpTransport)) {
      throw new Error("`transport` must be one of 'auto', 'sse', 'streamable-http'.");
    }
    return t as McpTransport;
  })();

  let headers: Record<string, string> | undefined;
  if (obj.headers !== undefined && obj.headers !== null) {
    if (typeof obj.headers !== 'object' || Array.isArray(obj.headers)) {
      throw new Error('`headers` must be a flat object of string→string.');
    }
    headers = {};
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new Error(`headers.${k} must be a string.`);
      if (k.length === 0 || k.length > 128) throw new Error(`headers.${k} — key length out of range.`);
      headers[k] = v;
    }
  }

  let allowedTools: string[] | undefined;
  if (obj.allowedTools !== undefined && obj.allowedTools !== null) {
    if (!Array.isArray(obj.allowedTools)) {
      throw new Error('`allowedTools` must be a string[] (or omitted to allow all).');
    }
    allowedTools = [];
    for (const t of obj.allowedTools) {
      if (typeof t !== 'string' || !t.trim()) throw new Error('`allowedTools` entries must be non-empty strings.');
      allowedTools.push(t);
    }
  }

  return { name: name.trim(), serverUrl, transport, headers, allowedTools };
}

/** Compute the tool-name the LLM will see. Mirrors the SDK
 *  (`agents/src/mcp/client.ts:1336`) so we don't drift. */
export function mcpToolKey(serverId: string, toolName: string): string {
  return `tool_${serverId.replace(/-/g, '')}_${toolName}`;
}

/** Decode an `allowed_tools` SQL column. Returns null when unset or
 *  unparseable, which the rest of the pipeline treats as "allow all". */
export function parseAllowedTools(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr.every((t) => typeof t === 'string')) return arr;
  } catch { /* fall through */ }
  return null;
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

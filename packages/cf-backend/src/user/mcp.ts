/**
 * UserDO-side MCP types, validation and serialization; protocol work is the Agents SDK's
 * `MCPClientManager`. Descriptors are serialized because `execute` closures can't cross DO RPC.
 */

import { sha256Hex } from '@kinu.run/core';
import {
  JsonArraySchema, JsonObjectSchema,
  admitMcpDescriptors, McpToolSurfaceSchema,
  mcpPresetById, MCP_PRESETS,
  type JsonObject, type JsonValue, type McpPreset, type McpPresetId,
  type SerializableToolDescriptor, type McpSurfaceBudget,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as v from 'valibot';


export type McpTransport = 'auto' | 'sse' | 'streamable-http';


/**
 * MCP tool cache keyed by a hash of the fetched descriptor content, never a mutation watermark
 * (watermarks reset on cold start while rows survive). `refresh` propagates fetch/parse failures.
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
   * Rebuild only when the admitted set would differ; the key includes both budget inputs.
   * The unavailable list follows every successfully read surface, cached or not.
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

export interface McpServerInput {
  name: string;
  serverUrl: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
  /** Absent on a custom server; when present, the preset's name, serverUrl and transport win. */
  presetId?: McpPresetId;
}

/** Re-derived at read time from `MCPClientManager.mcpConnections[id].connectionState`. */
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
  presetId: McpPresetId | null;
  createdAt: number;
  updatedAt: number;
}

/** Not exposed across RPC; the orchestrator asks for tool descriptors directly. */
export interface McpServerConfig {
  id: string;
  name: string;
  serverUrl: string;
  transport: McpTransport;
  headers: Record<string, string> | null;
  allowedTools: string[] | null;
  presetId: McpPresetId | null;
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
 * One spelling per endpoint: identity, stored row and credential origin derive from it.
 * Fragment dropped; path and query kept verbatim (`/mcp` and `/mcp/` differ).
 */
function canonicalMcpUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';

  return url.href;
}

/**
 * Throws a user-readable message. Requires https, or http on localhost/127.0.0.1/[::1].
 * Returns the canonical URL; empty `headers` omitted, `allowedTools: []` kept (expose nothing).
 * A preset add takes name, URL and transport from the catalog; `serverUrl` is optional there.
 */
export function validateMcpServerInput(input: JsonValue): McpServerInput {
  const parsedInput = v.safeParse(RawMcpServerInputSchema, input);

  if (!parsedInput.success) {
    throw new Error('Body must be a JSON object.');
  }

  const obj = parsedInput.output;

  const preset = validateMcpPresetId(obj.presetId);

  const name = preset ? preset.title : validateMcpServerName(obj.name);

  const parsedServerUrl = v.safeParse(v.string(), obj.serverUrl);

  if (!preset && (!parsedServerUrl.success || !parsedServerUrl.output.trim())) {
    throw new Error('`serverUrl` is required.');
  }

  const serverUrl = preset ? preset.serverUrl : v.parse(v.string(), obj.serverUrl);

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

  // Credentials belong in sealed `headers`; `serverUrl` is plaintext and Workers `fetch`
  // rejects URLs with userinfo.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('`serverUrl` must not carry a username or password — put credentials in `headers`.');
  }

  const parsedTransport = v.safeParse(v.nullish(McpTransportSchema), obj.transport);

  if (!parsedTransport.success) {
    throw new Error("`transport` must be one of 'auto', 'sse', 'streamable-http'.");
  }

  const transport = preset ? preset.transport : (parsedTransport.output ?? 'auto');

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

  return {
    name, serverUrl: canonicalMcpUrl(serverUrl), transport, headers, allowedTools,
    presetId: preset?.id,
  };
}

/** Absent → custom server; a non-catalog id is an error. The preset's fields can't be overridden. */
function validateMcpPresetId(presetId: JsonValue | undefined): McpPreset | undefined {
  if (presetId === undefined || presetId === null) return undefined;

  const parsedPresetId = v.safeParse(v.string(), presetId);

  if (!parsedPresetId.success) throw new Error('`presetId` must be a string.');

  const preset = mcpPresetById(parsedPresetId.output);

  if (!preset) throw new Error(`Unknown MCP preset '${parsedPresetId.output}'.`);

  return preset;
}

/** Shared by add and update: non-blank, at most 64 chars after trim (the stored, indexed value). */
export function validateMcpServerName(name: JsonValue): string {
  const parsed = v.safeParse(v.string(), name);

  if (!parsed.success || !parsed.output.trim()) throw new Error('`name` is required.');
  const trimmed = parsed.output.trim();

  if (trimmed.length > 64) throw new Error('`name` must be ≤ 64 characters.');

  return trimmed;
}

/** Null when the column is unset or fails the schema. */
function jsonColumn<Schema extends v.GenericSchema>(raw: string | null | undefined, schema: Schema): v.InferOutput<Schema> | null {
  if (!raw) return null;
  const parsed = v.safeParse(schema, tolerate(() => JSON.parse(raw), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/** Null means "allow all". */
export function parseAllowedTools(raw: string | null | undefined): string[] | null {
  return jsonColumn(raw, StringArraySchema);
}

/** Null means "no custom headers". */
export function parseMcpHeaders(raw: string | null | undefined): Record<string, string> | null {
  return jsonColumn(raw, HeaderRecordSchema);
}

/**
 * Credentials go via a `fetch` closure, not `requestInit.headers`: the SDK persists headers and
 * requestInit to `cf_agents_mcp_servers` in plaintext, but not `fetch`. Headers are read per
 * request, attached only for the server's own origin, and redirects are `manual`.
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

/** The one transport option the SDK's persistence whitelist does not keep. */
export interface McpCredentialTransport {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

/** Declares only the three credential-shaped transport fields; the SDK's session state is left alone. */
const StoredMcpServerOptionsSchema = v.object({
  transport: v.optional(v.object({
    headers: v.optional(v.unknown()),
    requestInit: v.optional(v.unknown()),
    eventSourceInit: v.optional(v.unknown()),
  })),
});

/**
 * Whether SDK-stored `server_options` still hold a credential; `restoreConnectionsFromStorage` replays it.
 * Only `headers`/`requestInit`/`eventSourceInit` count; unparseable payloads hold nothing.
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
 * Whether a failed MCP dispatch failed on transport authorization, decided by error class, never text.
 * Only `UnauthorizedError` and a 401 `code` on `StreamableHTTPError`/`SseError` count.
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

/** Avoids importing the SDK enum so this module doesn't pull the agents SDK transitively. */
export function mapConnectionStatus(state: string | undefined): McpConnectionStatus {
  switch (state) {
    case 'connecting':     return 'connecting';
    case 'authenticating': return 'authenticating';
    case 'connected':      return 'connected';
    case 'discovering':    return 'discovering';
    case 'ready':          return 'ready';
    case 'failed':         return 'failed';
    case undefined:
    default:               return 'unknown';
  }
}

/** `appConfigured` is only meaningful for `oauth-app` presets: whether env carries both client credentials. */
export interface McpPresetAvailability {
  readonly id: McpPresetId;
  readonly appConfigured: boolean;
}

/** The only place these `Env` names exist; messages and the deploy doc take their wording from here. */
const MCP_APP_ENV = {
  github: { id: 'MCP_GITHUB_CLIENT_ID', secret: 'MCP_GITHUB_CLIENT_SECRET' },
  google: { id: 'MCP_GOOGLE_CLIENT_ID', secret: 'MCP_GOOGLE_CLIENT_SECRET' },
} as const satisfies Partial<Record<McpPresetId, {
  readonly id: keyof Env;
  readonly secret: keyof Env;
}>>;

/** Literal keys so `env[k]` resolves via the optional Env fields, not the index signature. */
type McpAppEnvKey =
  (typeof MCP_APP_ENV)[keyof typeof MCP_APP_ENV][keyof (typeof MCP_APP_ENV)['github']];

export function mcpAppEnvNames(
  preset: McpPreset,
): { readonly clientIdEnv: McpAppEnvKey; readonly clientSecretEnv: McpAppEnvKey } | undefined {
  if (preset.auth !== 'oauth-app') return undefined;

  if (preset.id === 'github' || preset.id === 'google') {
    const names = MCP_APP_ENV[preset.id];

    return { clientIdEnv: names.id, clientSecretEnv: names.secret };
  }

  return undefined;
}

export function mcpAppCredentials(
  env: Env,
  preset: McpPreset,
): { clientId: string; clientSecret: string } | null {
  const names = mcpAppEnvNames(preset);

  if (!names) return null;

  const clientId = env[names.clientIdEnv];
  const clientSecret = env[names.clientSecretEnv];

  // An empty string fails the same check a missing binding does.
  if (!clientId || !clientSecret) return null;

  return { clientId, clientSecret };
}

/** Non-`oauth-app` presets report `appConfigured: true`; there is nothing to configure. */
export function listMcpPresetAvailability(env: Env): McpPresetAvailability[] {
  return MCP_PRESETS.map((preset) => ({
    id: preset.id,
    appConfigured: preset.auth !== 'oauth-app' || mcpAppCredentials(env, preset) !== null,
  }));
}

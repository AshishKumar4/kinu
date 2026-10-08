/**
 * UserDO-side MCP adapters over the Agents SDK's `MCPClientManager`: credential transport, session renewal,
 * listing and the deployment's preset credentials. Validation is core's (`mcp/servers.ts`). Descriptors are
 * serialized because `execute` closures can't cross DO RPC.
 */

import {
  describeMcpTool, listMcpToolsLeniently,
  MCP_PRESETS,
  type ListedMcpTools, type McpPreset, type McpPresetId, type McpToolRefusal, type McpTransport,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderCauseChain, tolerate, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError, SseError, UnauthorizedError, type Client } from '@modelcontextprotocol/client';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import * as v from 'valibot';


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

/** Whether a failed MCP dispatch failed on transport authorization, decided by error class, never text. */
export function isMcpTransportUnauthorized(input: { cause: unknown }): boolean {
  return causeChain(input).some((error) => error instanceof UnauthorizedError
    || (error instanceof SdkHttpError && error.status === 401)
    || (error instanceof SseError && error.code === 401));
}

function causeChain(input: { cause: unknown }): Error[] {
  const chain: Error[] = [];

  for (let error: unknown = input.cause; error instanceof Error && !chain.includes(error); error = error.cause) chain.push(error);

  return chain;
}

export type McpToolListing = { readonly listed: ListedMcpTools } | { readonly failure: string };

export async function readUndiscoveredToolList(server: { readonly name: string }, client: Pick<Client, 'request'>): Promise<McpToolListing> {
  try {
    return {
      listed: await listMcpToolsLeniently(server, (cursor) => client.request(
        { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
        ResultSchema,
      )),
    };
  } catch (cause) {
    const error = toKinuError({ doing: `reading the tool list of MCP server ${server.name}`, cause, otherwise: 'unavailable' });
    diagnostics.failure('mcp.tool_list_unreadable', error, { server: server.name });

    return { failure: renderCauseChain(error) };
  }
}

export function mcpListingRefusals(server: { readonly id: string; readonly name: string }, listed: ListedMcpTools): McpToolRefusal[] {
  return [...listed.refused, ...listed.tools.flatMap((tool) => {
    const described = describeMcpTool(server, tool);

    return 'refused' in described ? [described.refused] : [];
  })];
}

export interface McpSessionHost {
  readonly mcpConnections: Readonly<Record<string, McpSessionConnection | undefined>>;
  connectToServer(id: string): Promise<{ readonly state: string; readonly error?: string }>;
  discoverIfConnected(id: string): Promise<{ readonly success: boolean } | undefined>;
}

interface McpSessionConnection {
  readonly sessionId: string | undefined;
  clearResumedSession(): void;
}

interface SessionTraffic {
  readonly calls: Set<Promise<unknown>>;
  readonly renewals: Map<string, Promise<void>>;
}

const sessionTraffic = new WeakMap<McpSessionHost, Map<string, SessionTraffic>>();

export async function callRenewingExpiredSession<Result>(
  host: McpSessionHost,
  serverId: string,
  call: () => Promise<Result>,
): Promise<Result> {
  const servers = sessionTraffic.get(host) ?? new Map<string, SessionTraffic>();
  sessionTraffic.set(host, servers);
  const traffic = servers.get(serverId) ?? { calls: new Set(), renewals: new Map() };
  servers.set(serverId, traffic);
  const expired = host.mcpConnections[serverId]?.sessionId;

  try {
    return await sent(traffic, call);
  } catch (cause) {
    if (expired === undefined || !causeChain({ cause }).some((error) => error instanceof SdkHttpError && error.status === 404)) throw cause;
  }

  const renewal = traffic.renewals.get(expired)
    ?? renewSession({ host, serverId, expired, traffic }).finally(() => traffic.renewals.delete(expired));

  traffic.renewals.set(expired, renewal);
  await renewal;

  return sent(traffic, call);
}

async function sent<Result>(traffic: SessionTraffic, call: () => Promise<Result>): Promise<Result> {
  const running = call();
  traffic.calls.add(running);

  try {
    return await running;
  } finally {
    traffic.calls.delete(running);
  }
}

async function renewSession(input: { host: McpSessionHost; serverId: string; expired: string; traffic: SessionTraffic }): Promise<void> {
  const { host, serverId, expired } = input;
  // Starting a session closes the old client and every call still on it.
  await Promise.allSettled(input.traffic.calls);
  const connection = host.mcpConnections[serverId];

  if (connection === undefined || connection.sessionId !== expired) return;
  connection.clearResumedSession();
  const started = await host.connectToServer(serverId);

  if (started.state !== 'connected') {
    throw new KinuError('unavailable', `MCP server ${serverId} ended its session and a new one did not start (${started.error ?? started.state})`);
  }

  await host.discoverIfConnected(serverId);
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

/** A connection as observed: the SDK's state, `closed` for a ready one whose client lost its transport, `absent` for none. */
export type McpObservedState = McpConnectionStatus | 'closed' | 'absent';

/** The members of an SDK connection an observation reads. */
export interface McpObservedConnection {
  readonly connectionState: string;
  readonly connectionError?: string | null;
  readonly client?: { readonly transport?: unknown };
}

/**
 * The SDK leaves a connection `ready` when its transport closes (`Protocol._onclose` clears only the
 * client's transport), so its next request fails "Not connected"; that connection reads as `closed`.
 */
export function observedMcpState(connection: McpObservedConnection | undefined): McpObservedState {
  if (connection === undefined) return 'absent';
  const status = mapConnectionStatus(connection.connectionState);

  if (status === 'ready' && connection.client !== undefined && connection.client.transport === undefined) return 'closed';

  return status;
}

/** Logs `mcp.connection_changed` once per change of a server's observed state, with the state it left. */
export class McpTransitionLog {
  private readonly seen = new Map<string, McpObservedState>();

  constructor(private readonly connections: () => Readonly<Record<string, McpObservedConnection | undefined>>) {}

  /** `after` names what prompted the look: an SDK event type, or the step that just ran. */
  observe(after: string): void {
    const live = this.connections();

    for (const serverId of new Set([...this.seen.keys(), ...Object.keys(live)])) {
      const from = this.seen.get(serverId) ?? 'absent';
      const to = observedMcpState(live[serverId]);

      if (to === from) continue;

      if (to === 'absent') this.seen.delete(serverId);
      else this.seen.set(serverId, to);
      diagnostics.event('mcp.connection_changed', { serverId, from, to, after, error: live[serverId]?.connectionError ?? '' });
    }
  }
}

/** What an MCP call failed on; `mcp.call_failed` carries it. `tool_error` is a server's own `isError` answer. */
export type McpFailureKind =
  | 'auth' | 'not_connected' | 'connection_closed' | 'timeout' | 'http' | 'server_error' | 'protocol'
  | 'send_failed' | 'cancelled' | 'refused' | 'tool_error' | 'unknown';

/** A call refused before dispatch: its server's connection was not usable, and `kind` says how. */
export class McpServerUnreachable extends KinuError {
  constructor(readonly kind: McpFailureKind, message: string) {
    super('unavailable', message);
  }
}

/** Decided by error class and code, never text: the first link of the cause chain that says. */
export function classifyMcpFailure(input: { cause: unknown }): McpFailureKind {
  if (isMcpTransportUnauthorized(input)) return 'auth';

  for (const error of causeChain(input)) {
    const kind = failureKindOf(error);

    if (kind !== undefined) return kind;
  }

  return 'unknown';
}

/** A Kinu code that says nothing of the wire (`unavailable`, `io`, ...) defers to its cause. */
const KINU_FAILURE_KINDS: Partial<Record<ErrorCode, McpFailureKind>> = {
  cancelled: 'cancelled', timeout: 'timeout', denied: 'refused', missing: 'refused', bad_input: 'refused', unsupported: 'refused',
};

function failureKindOf(error: Error): McpFailureKind | undefined {
  if (error instanceof McpServerUnreachable) return error.kind;

  // Before `SdkError`, which `SdkHttpError` extends.
  if (error instanceof SdkHttpError || error instanceof SseError) return 'http';

  if (error instanceof SdkError) return SDK_FAILURE_KINDS[error.code] ?? 'protocol';

  if (error instanceof ProtocolError) return 'server_error';

  if (error instanceof KinuError) return KINU_FAILURE_KINDS[error.code];

  return undefined;
}

/** Any other local SDK refusal is a protocol mismatch between the client and the server. */
const SDK_FAILURE_KINDS: Partial<Record<SdkErrorCode, McpFailureKind>> = {
  [SdkErrorCode.NotConnected]: 'not_connected',
  [SdkErrorCode.ConnectionClosed]: 'connection_closed',
  [SdkErrorCode.RequestTimeout]: 'timeout',
  [SdkErrorCode.SendFailed]: 'send_failed',
};

/** `appConfigured` is only meaningful for `oauth-app` presets: whether env carries both client
 *  credentials. */
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

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
import { diagnostics, KinuError, renderCauseChain, tolerate, toKinuError } from '@kinu.run/core/obs';
import { SdkHttpError, SseError, UnauthorizedError, type Client } from '@modelcontextprotocol/client';
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

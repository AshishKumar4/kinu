/**
 * UserDO-side MCP adapters over the Agents SDK's `MCPClientManager`: credential transport, observed states and the
 * deployment's preset credentials. What reads the MCP SDK's own classes is `mcp-wire.ts`, loaded with the SDK at the
 * first call that meets the wire. Validation is core's (`mcp/servers.ts`). Descriptors are serialized because `execute`
 * closures can't cross DO RPC.
 */

import {
  describeMcpTool,
  MCP_PRESETS,
  type ListedMcpTools, type McpConnectionStatus, type McpPreset, type McpPresetAvailability, type McpPresetId,
  type McpToolRefusal,
} from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';


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

export type McpToolListing = { readonly listed: ListedMcpTools } | { readonly failure: string };

export function mcpListingRefusals(server: { readonly id: string; readonly name: string }, listed: ListedMcpTools): McpToolRefusal[] {
  return [...listed.refused, ...listed.tools.flatMap((tool) => {
    const described = describeMcpTool(server, tool);

    return 'refused' in described ? [described.refused] : [];
  })];
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

/** The states a call goes out in: the transport is open, whether or not discovery has finished. */
export const CALLABLE_MCP_STATES: ReadonlySet<McpObservedState> = new Set(['ready', 'connected', 'discovering']);

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

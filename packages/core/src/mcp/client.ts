/**
 * The client side of an account's MCP servers as the Agents SDK's `MCPClientManager` keeps them, with nothing of the
 * MCP SDK itself: the credential transport, connection states as observed, the transition log and listing refusals.
 * What reads the SDK's own classes (failures, tool lists, session renewal) loads with the SDK, at a call's first use.
 */

import { diagnostics } from '../obs/index';
import { copyHeaders } from '../providers/fetch-shim';
import { describeMcpTool, type ListedMcpTools, type McpToolRefusal } from '../tools/mcp-surface';
import type { McpConnectionStatus } from './servers';

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
      const headers = copyHeaders(init?.headers);

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

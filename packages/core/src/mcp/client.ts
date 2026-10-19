/**
 * The client side of an account's MCP servers as the Agents SDK's `MCPClientManager` keeps them, with nothing of the
 * MCP SDK itself: the credential transport, connection states as observed, the transition log and listing refusals.
 * What reads the SDK's own classes (failures, tool lists, session renewal) loads with the SDK, at a call's first use.
 */

import { Effect, Exit } from 'effect';
import { diagnostics, hold } from '../obs/index';
import { copyHeaders } from '../providers/fetch-shim';
import { describeMcpTool, type ListedMcpTools, type McpToolRefusal } from '../tools/mcp-surface';
import type { McpConnectionStatus } from './servers';

/**
 * The `fetch` every account MCP server's transport runs on. Credentials go via this closure, not `requestInit.headers`:
 * the SDK persists headers and requestInit to `cf_agents_mcp_servers` in plaintext, but not `fetch`. Headers are read per
 * request, attached only for the server's own origin, and redirects are `manual`. The SDK's token requests go through it
 * too, and it presents each refresh token once ({@link refreshingOnce}). `signIn: 'first'` is for a server that must be
 * signed in to before it is used: one that answers anyone's `initialize` and `tools/list` (Gmail's MCP, measured
 * 2026-10-19) would connect unsigned and refuse the first call of some turn, so its endpoint is answered 401, as it
 * answers a call, until the request carries a token, and the sign-in starts when the server is added.
 */
export function mcpCredentialTransport(
  serverUrl: string,
  openHeaders: () => Promise<Record<string, string> | null>,
  signIn: 'first' | 'when-asked' = 'when-asked',
): McpCredentialTransport {
  const endpoint = new URL(serverUrl);

  return {
    fetch: refreshingOnce(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const at = new URL(url.toString());

      if (at.origin !== endpoint.origin) return fetch(url, init);

      if (signIn === 'first' && at.pathname === endpoint.pathname && !copyHeaders(init?.headers).has('authorization')) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      }

      const credential = await openHeaders();

      if (credential === null || Object.keys(credential).length === 0) return fetch(url, init);
      const headers = copyHeaders(init?.headers);

      for (const [name, value] of Object.entries(credential)) headers.set(name, value);

      return fetch(url, { ...init, headers, redirect: 'manual' });
    }),
  };
}

/** The one transport option the SDK's persistence whitelist does not keep. */
export interface McpCredentialTransport {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

type TransportFetch = McpCredentialTransport['fetch'];

/** The refresh token a token request presents, or null for any other request. */
function presentedRefreshToken(init: RequestInit | undefined): string | null {
  const body = init?.body;

  if (!(body instanceof URLSearchParams) && typeof body !== 'string') return null;
  const form = new URLSearchParams(body);

  return form.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : null;
}

/**
 * `send`, presenting each refresh token once. Every request a connection sends that meets a 401 runs its own SDK auth
 * flow, and a connection sends several at once (discovery lists tools, prompts and resources together; a turn calls
 * tools in parallel), so each flow refreshed the same token, and a provider that rotates refresh tokens revokes the grant
 * on the second. A token request presenting a refresh token already sent is answered with a copy of that one answer,
 * in flight or come, however long the token endpoint takes; a request that got no answer fails each that shared it, and
 * the next presents the token again.
 */
function refreshingOnce(send: TransportFetch): TransportFetch {
  const answers = new Map<string, Promise<Response>>();

  return async (url, init) => {
    const token = presentedRefreshToken(init);

    if (token === null) return send(url, init);
    const key = `${url.toString()} ${token}`;
    const known = answers.get(key);

    if (known !== undefined) return (await known).clone();
    const answer = send(url, init);

    answers.set(key, answer);

    // A request that got no answer leaves the token unanswered, so the next presents it again; this one fails as sent.
    if (Exit.isFailure(await hold(Effect.promise(async () => answer)))) answers.delete(key);

    return (await answer).clone();
  };
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

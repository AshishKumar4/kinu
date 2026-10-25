/**
 * The client side of an account's MCP servers with nothing of the MCP SDK itself: the fetch every request runs on, the
 * refusals it records, and what a tool listing found. What reads the SDK's own classes loads with the SDK, at a
 * server's first use.
 */

import { copyHeaders } from '../providers/fetch-shim';
import { safeJsonParse } from '../utils/json';
import { describeMcpTool, type ListedMcpTools, type McpToolRefusal } from '../tools/mcp-surface';

export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The `fetch` every account MCP server's transport and sign-in run on. A server's stored headers are opened per
 * request, so a rotated credential applies at once and no opened copy is held; they are attached only for the server's
 * own origin, whose redirects are `manual`, so no credential follows a redirect elsewhere. Every refusal the server's
 * origin answers is reported to `refused`.
 */
export function mcpCredentialFetch(
  serverUrl: string,
  openHeaders: () => Promise<Record<string, string> | null>,
  refused: (refusal: McpRefusal) => void,
): McpFetch {
  const endpoint = new URL(serverUrl);

  const sent = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(url.toString()).origin !== endpoint.origin) return fetch(url, init);
    const credential = await openHeaders();

    if (credential === null || Object.keys(credential).length === 0) return fetch(url, init);
    const headers = copyHeaders(init?.headers);

    for (const [name, value] of Object.entries(credential)) headers.set(name, value);

    return fetch(url, { ...init, headers, redirect: 'manual' });
  };

  return async (url, init) => {
    const response = await sent(url, init);

    // The SDK keeps only the status and the body of a refusal, and a server may answer one with its whole result
    // (Gmail's MCP refuses a token with its tool list, 2026-10-23); what the server said of the token is kept here.
    if (!response.ok && new URL(url.toString()).origin === endpoint.origin) {
      refused({ method: init?.method ?? 'GET', rpc: rpcMethodOf(init), status: response.status, wwwAuthenticate: response.headers.get('www-authenticate') });
    }

    return response;
  };
}

/** A server's own origin refusing a request: its status and what its `WWW-Authenticate` said, never its body. */
export interface McpRefusal {
  readonly method: string;
  /** The JSON-RPC method the request carried (`tools/list`), or null for one that carried none or several. */
  readonly rpc: string | null;
  readonly status: number;
  readonly wwwAuthenticate: string | null;
}

/** The one JSON-RPC method a request's body names; a body that is not JSON (`safeJsonParse` keeps it as text) names none. */
function rpcMethodOf(init: RequestInit | undefined): string | null {
  if (typeof init?.body !== 'string') return null;
  const message = safeJsonParse(init.body);

  return typeof message === 'object' && message !== null && !Array.isArray(message) && typeof message['method'] === 'string' ? message['method'] : null;
}

export type McpToolListing = { readonly listed: ListedMcpTools } | { readonly failure: string };

export function mcpListingRefusals(server: { readonly id: string; readonly name: string }, listed: ListedMcpTools): McpToolRefusal[] {
  return [...listed.refused, ...listed.tools.flatMap((tool) => {
    const described = describeMcpTool(server, tool);

    return 'refused' in described ? [described.refused] : [];
  })];
}

/** What an MCP call failed on; `mcp.call_failed` carries it. `tool_error` is a server's own `isError` answer. */
export type McpFailureKind =
  | 'auth' | 'not_connected' | 'connection_closed' | 'timeout' | 'http' | 'server_error' | 'protocol'
  | 'send_failed' | 'cancelled' | 'refused' | 'tool_error' | 'unknown';

/**
 * The MCP SDK's side of an account's MCP servers: a server's client connected from its row, its tool list, its OAuth
 * sign-in and the renewal of its login, and failures read by the SDK's error classes. `mcp-servers.ts` loads it at the
 * first request that meets the wire, and the SDK with it: evaluating the SDK builds its schemas, which every isolate's
 * startup paid for, MCP or not.
 */

import { Effect, Result } from 'effect';
import { listMcpToolsLeniently, type McpConnectionStatus, type McpFailureKind, type McpFetch, type McpToolListing, type McpTransport } from '@kinu.run/core';
import { attempt, diagnostics, KinuError, renderCauseChain, type ErrorCode } from '@kinu.run/core/obs';
import {
  auth, Client, discoverAuthorizationServerMetadata, InsufficientScopeError, OAuthError, OAuthErrorCode, ProtocolError, refreshAuthorization, SdkError, SdkErrorCode,
  SdkHttpError, SSEClientTransport, SseError, StreamableHTTPClientTransport, UnauthorizedError, type AuthProvider,
} from '@modelcontextprotocol/client';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AccountMcpOAuthProvider, KeptLogin } from './mcp-oauth-provider';
import type { McpSession } from './mcp-servers';

/** A server as its client is built: where it is, the fetch its requests run on, and the login its requests present. */
export interface McpEndpoint {
  readonly name: string;
  readonly url: string;
  readonly transport: McpTransport;
  readonly fetch: McpFetch;
  /** Absent where a stored header authenticates the server. */
  readonly bearer: AuthProvider | undefined;
}

/** A server's client while its object is awake, and the session its row keeps of it. */
export interface McpLive {
  readonly client: Client;
  readonly session: McpSession;
}

/**
 * `endpoint`'s client, over the session its row keeps: a legacy session is resumed with no request, a server known to
 * speak the legacy protocol is initialized without the era probe, and anything else connects as new, Streamable HTTP
 * first where the server was added as `auto`, then SSE where it does not serve that.
 */
function connectMcp(endpoint: McpEndpoint, kept: McpSession | null): Effect.Effect<McpLive, KinuError> {
  const doing = `connecting to MCP server ${endpoint.name}`;

  const over = (kind: McpSession['transport']): Effect.Effect<McpLive, KinuError> => attempt({ doing, otherwise: 'unavailable' }, async () => {
    const client = new Client({ name: 'kinu', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    const resumed = kind === 'streamable-http' ? kept?.sessionId : undefined;

    const transport = kind === 'sse'
      ? new SSEClientTransport(new URL(endpoint.url), { fetch: endpoint.fetch, authProvider: endpoint.bearer })
      : new StreamableHTTPClientTransport(new URL(endpoint.url), {
          fetch: endpoint.fetch, authProvider: endpoint.bearer,
          ...resumed !== undefined && { sessionId: resumed, protocolVersion: kept?.protocolVersion },
        });

    // SSE is the 2024 transport, which only the legacy protocol speaks.
    const legacy = kind === 'sse' || (kept?.era === 'legacy' && resumed === undefined);

    await client.connect(transport, legacy ? { prior: { kind: 'legacy' } } : undefined);

    if (transport instanceof SSEClientTransport) return { client, session: { transport: kind, era: 'legacy' } };
    const sessionId = transport.sessionId;
    const protocolVersion = transport.protocolVersion;
    const era = resumed !== undefined ? 'legacy' : client.getProtocolEra() ?? 'legacy';

    return { client, session: { transport: kind, era, ...sessionId !== undefined && { sessionId }, ...protocolVersion !== undefined && { protocolVersion } } };
  });

  const [first, ...rest] = transportsToTry(endpoint.transport, kept);

  return rest.reduce((connecting, kind) => Effect.catch(connecting, (failure) => (notServed(failure) ? over(kind) : Effect.fail(failure))), over(first));
}

/** The transports a connect tries, in order: the one the last connection found, else the one the server was added
 *  with, `auto` trying Streamable HTTP and then SSE. */
function transportsToTry(added: McpTransport, kept: McpSession | null): readonly [McpSession['transport'], ...McpSession['transport'][]] {
  if (kept !== null) return [kept.transport];

  return added === 'auto' ? ['streamable-http', 'sse'] : [added];
}

/** The HTTP status a request was refused with, where the server's answer is in the failure's chain. */
function httpStatusOf(failure: KinuError): number | undefined {
  return causeChain({ cause: failure }).find((link): link is SdkHttpError => link instanceof SdkHttpError)?.status;
}

/** A transport the server does not serve: Streamable HTTP's POST on an SSE server is answered 404 or 405. */
function notServed(failure: KinuError): boolean {
  const status = httpStatusOf(failure);

  return status === 404 || status === 405;
}

/**
 * Why a call that failed on `live` was never sent, so it may go out once more on a new client: the server ended the
 * session it carried, which it answers 404 having run nothing (MCP 2025-11-25, basic/transports), or the transport had
 * closed, which the SDK refuses before sending. Null for any other failure, which the server may have acted on.
 */
function unsentBy(live: McpLive, failure: KinuError): 'session_ended' | 'not_connected' | null {
  if (live.session.sessionId !== undefined && httpStatusOf(failure) === 404) return 'session_ended';

  return causeChain({ cause: failure }).some((link) => link instanceof SdkError && link.code === SdkErrorCode.NotConnected) ? 'not_connected' : null;
}

/** `live`'s client closed; with `end`, the session it holds ended at the server first, as MCP asks of a client done
 *  with one. */
function closeMcp(live: McpLive, end: boolean): Effect.Effect<void, KinuError> {
  return attempt({ doing: 'closing an MCP client', otherwise: 'unavailable' }, async () => {
    const { transport } = live.client;

    try {
      if (end && transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
    } finally {
      await live.client.close();
    }
  });
}

/**
 * `server`'s tool list, or why it has none. A server that refused the request by its HTTP status is named with that
 * status, never the body the SDK quotes: Gmail's MCP refuses a token it will not take with 403, no reason, and its whole
 * tool list as the body (2026-10-23). What the server said of the token is in `mcp.server_refused`.
 */
function listMcpTools(server: { readonly name: string }, client: Pick<Client, 'request'>): Effect.Effect<McpToolListing> {
  const read = attempt({ doing: `reading the tool list of MCP server ${server.name}`, otherwise: 'unavailable' },
    async () => listMcpToolsLeniently(server, (cursor) => client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, ResultSchema)));

  return Effect.match(read, {
    onSuccess: (listed): McpToolListing => ({ listed }),
    onFailure: (failure): McpToolListing => {
      diagnostics.failure('mcp.tool_list_unreadable', failure, { server: server.name });
      const status = httpStatusOf(failure);

      return { failure: status === undefined ? renderCauseChain(failure) : `${server.name} refused its tool list: HTTP ${String(status)}` };
    },
  });
}

/** The issuer's refusals that end a login: no renewal can succeed, and the person signs in again. */
const LOGIN_ENDED: ReadonlySet<string> = new Set([OAuthErrorCode.InvalidGrant, OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient]);

/** The SDK's one tolerance between two names of an issuer (`issuersMatch`, not exported): a single trailing `/`. */
function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/u, '') === b.replace(/\/$/u, '');
}

/**
 * `provider`'s `login` renewed at the issuer that granted it: `renewed`, or why it cannot be, when only a sign-in can give
 * it a login again: the issuer refused the grant, or no OAuth client of that issuer is held to renew it with. Where to
 * renew is read from that issuer's own metadata, never from what the server names now (SEP-2352, as the SDK's `auth`
 * binds a login): neither a server that names another issuer nor a protected-resource read that failed, which the SDK's
 * discovery takes for the server's own origin, can send the refresh token or the client's credentials elsewhere. The
 * grant keeps its resource, so the refresh names none (RFC 8707 §2.2). Any other failure (the issuer unreachable, or
 * answering 5xx) is the renewal's, and leaves the login as it was.
 */
function renewMcpLogin(input: {
  readonly name: string;
  readonly provider: AccountMcpOAuthProvider;
  readonly fetch: McpFetch;
  readonly login: KeptLogin & { readonly refresh_token: string };
}): Effect.Effect<'renewed' | { readonly ended: string }, KinuError> {
  const { provider, login } = input;
  const doing = `renewing the sign-in of MCP server ${input.name}`;

  return Effect.gen(function* () {
    const { issuer } = login;

    if (issuer === undefined) return { ended: 'its sign-in names no issuer to renew it at' };
    const client = yield* attempt({ doing, otherwise: 'unavailable' }, async () => provider.clientInformation());

    if (client === undefined) return { ended: 'it holds no OAuth client to renew its sign-in with' };

    if (client.issuer !== undefined && !sameIssuer(client.issuer, issuer)) return { ended: `its OAuth client was registered with ${client.issuer}, not ${issuer}, which granted its sign-in` };
    const metadata = yield* attempt({ doing, otherwise: 'unavailable' }, async () => discoverAuthorizationServerMetadata(issuer, { fetchFn: input.fetch }));

    const refreshed = yield* Effect.result(attempt({ doing, otherwise: 'unavailable' }, async () => refreshAuthorization(issuer, {
      metadata, clientInformation: client, refreshToken: login.refresh_token, fetchFn: input.fetch,
    })));

    if (Result.isFailure(refreshed)) {
      const refused = causeChain({ cause: refreshed.failure }).find((link): link is OAuthError => link instanceof OAuthError);

      if (refused !== undefined && LOGIN_ENDED.has(refused.code)) return { ended: refused.message };

      return yield* refreshed.failure;
    }

    yield* attempt({ doing, otherwise: 'io' }, async () => provider.saveTokens({ ...refreshed.success, issuer }));

    return 'renewed';
  });
}

/** A sign-in begun at `provider`'s issuer, always to its authorization page, never a renewal: the address the person
 *  signs in at. Its OAuth client is registered first where it has none. */
function beginMcpSignIn(input: { readonly name: string; readonly serverUrl: string; readonly provider: AccountMcpOAuthProvider; readonly fetch: McpFetch }): Effect.Effect<string, KinuError> {
  const { provider } = input;

  return Effect.gen(function* () {
    yield* attempt({ doing: `beginning a sign-in to MCP server ${input.name}`, otherwise: 'unavailable' },
      async () => auth(provider, { serverUrl: input.serverUrl, fetchFn: input.fetch, forceReauthorization: true }));
    const { authUrl } = provider;

    if (authUrl === undefined) return yield* new KinuError('unavailable', `${input.name} named no page to sign in at.`);

    return authUrl;
  });
}

/** The sign-in `state` names ended at the callback with `code`: exchanged for a login, under the code verifier its
 *  begin kept for that state alone, which is spent either way. */
function finishMcpSignIn(input: {
  readonly name: string;
  readonly serverUrl: string;
  readonly provider: AccountMcpOAuthProvider;
  readonly fetch: McpFetch;
  readonly state: string;
  readonly code: string;
  readonly iss: string | undefined;
}): Effect.Effect<void, KinuError> {
  const { provider } = input;

  return attempt({ doing: `completing the sign-in to MCP server ${input.name}`, otherwise: 'unavailable' }, async () => provider.runWithCodeVerifierState(input.state, async () => {
    try {
      await auth(provider, { serverUrl: input.serverUrl, authorizationCode: input.code, iss: input.iss, fetchFn: input.fetch });
    } finally {
      await provider.deleteCodeVerifier();
    }
  }));
}

/** Whether a failed MCP dispatch failed on transport authorization, decided by error class, never text. */
function isMcpTransportUnauthorized(input: { cause: unknown }): boolean {
  return causeChain(input).some((error) => error instanceof UnauthorizedError || error instanceof InsufficientScopeError
    || (error instanceof SdkHttpError && error.status === 401)
    || (error instanceof SseError && error.code === 401));
}

function causeChain(input: { cause: unknown }): Error[] {
  const chain: Error[] = [];

  for (let error: unknown = input.cause; error instanceof Error && !chain.includes(error); error = error.cause) chain.push(error);

  return chain;
}

/**
 * Decided by error class and code, never text: the first link of the cause chain that says. A call refused before
 * dispatch carries no transport error, so `status`, its server's when the call failed, says what it met.
 */
function classifyMcpFailure(input: { cause: unknown; status?: McpConnectionStatus }): McpFailureKind {
  if (isMcpTransportUnauthorized(input) || input.status === 'needs_sign_in') return 'auth';

  for (const error of causeChain(input)) {
    const kind = failureKindOf(error);

    if (kind !== undefined) return kind;
  }

  return 'unknown';
}

/** Whether a failure is the server's word that the login it was handed is no good: its row then needs a sign-in. */
function isMcpAuthFailure(failure: KinuError): boolean {
  return isMcpTransportUnauthorized({ cause: failure });
}

/** A Kinu code that says nothing of the wire (`unavailable`, `io`, ...) defers to its cause. */
const KINU_FAILURE_KINDS: Partial<Record<ErrorCode, McpFailureKind>> = {
  cancelled: 'cancelled', timeout: 'timeout', denied: 'refused', missing: 'refused', bad_input: 'refused', unsupported: 'refused',
};

function failureKindOf(error: Error): McpFailureKind | undefined {
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

/** The SDK's half of the client, as `mcp-servers.ts` loads it at the first request that meets the wire. */
export const mcpWire = {
  connectMcp, unsentBy, closeMcp, listMcpTools, renewMcpLogin, beginMcpSignIn, finishMcpSignIn, classifyMcpFailure, isMcpAuthFailure,
};

export type McpWire = typeof mcpWire;

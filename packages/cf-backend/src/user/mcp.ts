/**
 * The MCP SDK's side of a UserDO's MCP calls: failures read by the SDK's error classes, tool lists read with its result
 * schema, and the renewal of a session the server ended. `mcp-servers.ts` loads it at the first call that meets the
 * wire, and the SDK with it: evaluating the SDK builds its schemas, which every isolate's startup paid for, MCP or not.
 */

import { CALLABLE_MCP_STATES, listMcpToolsLeniently, type McpFailureKind, type McpObservedState, type McpRefusal, type McpToolListing } from '@kinu.run/core';
import { diagnostics, joining, KinuError, renderCauseChain, toKinuError, type ErrorCode, type Joined } from '@kinu.run/core/obs';
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError, SseError, UnauthorizedError, type Client } from '@modelcontextprotocol/client';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

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

/**
 * `server`'s tool list, or why it has none. A server that refused the request by its HTTP status is named with that
 * status and what it said of the token (`refusal`, its last `WWW-Authenticate`), never the body the SDK quotes: Gmail's
 * MCP refuses a token it will not take with 403, no reason, and its whole tool list as the body (2026-10-23).
 */
export async function readUndiscoveredToolList(
  server: { readonly name: string },
  client: Pick<Client, 'request'>,
  refusals: () => readonly McpRefusal[] = () => [],
): Promise<McpToolListing> {
  const before = refusals().length;

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
    const status = causeChain({ cause }).find((link): link is SdkHttpError => link instanceof SdkHttpError)?.status;

    if (status === undefined) return { failure: renderCauseChain(error) };
    // This listing's own refusal: a tools/list refused with this status since it began, not another request's.
    const said = refusals().slice(before).filter((refusal) => refusal.rpc === 'tools/list' && refusal.status === status).at(-1)?.wwwAuthenticate ?? null;

    return { failure: `${server.name} refused its tool list: HTTP ${String(status)}, ${said === null ? 'with no reason given' : `saying ${said}`}` };
  }
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
  readonly renewals: Joined<string, void>;
}

const sessionTraffic = new WeakMap<McpSessionHost, Map<string, SessionTraffic>>();

export async function callRenewingExpiredSession<Result>(
  host: McpSessionHost,
  serverId: string,
  call: () => Promise<Result>,
): Promise<Result> {
  const servers = sessionTraffic.get(host) ?? new Map<string, SessionTraffic>();
  sessionTraffic.set(host, servers);
  const traffic = servers.get(serverId) ?? { calls: new Set(), renewals: joining<string, void>() };
  servers.set(serverId, traffic);
  const expired = host.mcpConnections[serverId]?.sessionId;

  try {
    return await sent(traffic, call);
  } catch (cause) {
    if (expired === undefined || !causeChain({ cause }).some((error) => error instanceof SdkHttpError && error.status === 404)) throw cause;
  }

  await traffic.renewals(expired, () => renewSession({ host, serverId, expired, traffic }));

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

/**
 * Decided by error class and code, never text: the first link of the cause chain that says. A call refused before
 * dispatch carries no transport error, so `state`, the connection's when the call failed, says what it met.
 */
export function classifyMcpFailure(input: { cause: unknown; state?: McpObservedState }): McpFailureKind {
  if (isMcpTransportUnauthorized(input)) return 'auth';

  for (const error of causeChain(input)) {
    const kind = failureKindOf(error);

    if (kind !== undefined) return kind;
  }

  if (input.state === 'authenticating') return 'auth';

  return input.state === undefined || CALLABLE_MCP_STATES.has(input.state) ? 'unknown' : 'not_connected';
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

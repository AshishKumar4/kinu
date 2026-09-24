/**
 * The WebSocket half of the agent RPC policy (core `AGENT_RPC_ACCESS`), and the identity headers the edge
 * rewrites. `rejectOutOfScopeRpc` pins scoped `pta_…` sockets to scope rows. Scopes persist as a connection
 * tag so the restriction survives DO hibernation (`websocket.hibernation_state`; an in-memory allowlist
 * would widen to full access on wake).
 */
import { diagnostics, tolerate } from '@kinu.run/core/obs';
import type { WSMessage } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import {
  type AccessTokenScope, type AgentRpcAccess, type AgentRpcMethod, DEV_IDENTITY_HEADER, normalizeAccessTokenScopes,
  requiredRpcAccess, rpcAccessScope,
} from '@kinu.run/core';
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';

/** Always rewritten by the edge after authentication so clients cannot smuggle it. */
export const CLI_SCOPES_HEADER = 'x-kinu-cli-scopes';

const CLI_SCOPES_TAG_PREFIX = 'cli-scopes:';

/** Token hash and authorization generation; always rewritten by the edge, like the scopes header. */
export const CLI_BEARER_HEADER = 'x-kinu-cli-bearer';

/** Written by the edge beside the scope and bearer headers. */
const USER_ID_HEADER = 'x-kinu-user-id';

/** The session auth time the step-up gate compares; same writer and rule as the user id header. */
export const AUTH_TIME_HEADER = 'x-kinu-auth-time';

/** Lets a socket restored from hibernation know whose authority it runs on, so revocation applies. */
const CLI_BEARER_TAG_PREFIX = 'cli-bearer:';

/** `readable: false` must refuse rather than read as "no bearer to check". */
export type CliSocketBearer =
  | { readonly readable: true; readonly tokenHash: string; readonly generation: number }
  | { readonly readable: false };

const CLI_BEARER_RE = /^([a-f0-9]{64}):(\d{1,15})$/;

/** Null when the connection carries no CLI bearer (a browser session). */
export function cliBearerConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;

  // Header presence marks a CLI connection, so a malformed value still gets a tag (unreadable, not unchecked).
  return `${CLI_BEARER_TAG_PREFIX}${CLI_BEARER_RE.test(headerValue) ? headerValue : ''}`;
}

export function cliBearerFromTags(tags: Iterable<string>): CliSocketBearer | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_BEARER_TAG_PREFIX)) continue;
    const match = CLI_BEARER_RE.exec(tag.slice(CLI_BEARER_TAG_PREFIX.length));

    if (!match) return { readable: false };

    return { readable: true, tokenHash: match[1], generation: Number(match[2]) };
  }

  return null;
}

/** Hash of the authenticated cookie; always rewritten by the edge so clients cannot smuggle it. */
export const SESSION_BEARER_HEADER = 'x-kinu-session-bearer';

/** Lets a socket restored from hibernation know whose sign-in it runs on, so logout applies. */
const SESSION_BEARER_TAG_PREFIX = 'session-bearer:';

const SESSION_BEARER_RE = /^[a-f0-9]{64}$/;

/** Null when the connection carries no browser session (a CLI ticket connection). */
export function sessionBearerConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;

  // Same rule as the CLI bearer: an unparseable value still gets a tag and is refused at frame time.
  return `${SESSION_BEARER_TAG_PREFIX}${SESSION_BEARER_RE.test(headerValue) ? headerValue : ''}`;
}

/** A present-but-unparseable tag answers `{ unreadable: true }` so the frame gate refuses it. */
export function sessionBearerFromTags(tags: Iterable<string>): { tokenHash: string } | { unreadable: true } | null {
  for (const tag of tags) {
    if (!tag.startsWith(SESSION_BEARER_TAG_PREFIX)) continue;
    const value = tag.slice(SESSION_BEARER_TAG_PREFIX.length);

    if (!SESSION_BEARER_RE.test(value)) return { unreadable: true };

    return { tokenHash: value };
  }

  return null;
}

/** Every identity header is rewritten from the verified identity: none can be smuggled or stripped. */
export function appendIdentityHeaders(h: Headers, identity: AuthIdentity): Headers {
  const next = new Headers(h);
  // The object reads the identity below, never the credential.
  next.delete(DEV_IDENTITY_HEADER);
  next.set(USER_ID_HEADER, identity.userId);

  if (identity.authTime) next.set(AUTH_TIME_HEADER, String(identity.authTime));
  next.delete(CLI_SCOPES_HEADER);

  if (identity.cliScopes) next.set(CLI_SCOPES_HEADER, identity.cliScopes.join(','));
  next.delete(CLI_BEARER_HEADER);

  if (identity.cliBearer) {
    next.set(CLI_BEARER_HEADER, `${identity.cliBearer.tokenHash}:${identity.cliBearer.generation}`);
  }

  next.delete(SESSION_BEARER_HEADER);

  if (identity.sessionTokenHash) {
    next.set(SESSION_BEARER_HEADER, identity.sessionTokenHash);
  }

  return next;
}

/** Compile-time proof every table key is a real public method on the agent. */
type AgentRpcMethodsExist = {
  [Method in AgentRpcMethod]: OrchestratorAgent[Method] extends (...args: never[]) => infer _Result
    ? true
    : false;
}[AgentRpcMethod];

const agentRpcMethodsExist: AgentRpcMethodsExist = true;

void agentRpcMethodsExist;

/** Members unsigned: restated signatures hit TS2589 in `handleAgentRpc` (2026-09-22); `v.function()` checks the name. */
export type AgentRpcDispatch = {
  readonly [Method in AgentRpcMethod]?: (...args: never[]) => void;
};

/** Null when the connection is unrestricted (interactive session or browser). */
export function cliScopesConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const normalized = normalizeAccessTokenScopes(headerValue.split(','));

  // A scoped header that fails to parse must fail closed, not fall open to
  // an unrestricted connection: an empty scope set denies every RPC.
  return `${CLI_SCOPES_TAG_PREFIX}${normalized.ok ? normalized.scopes.join(',') : ''}`;
}

function cliScopesFromTags(tags: Iterable<string>): AccessTokenScope[] | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_SCOPES_TAG_PREFIX)) continue;
    const parsed = normalizeAccessTokenScopes(tag.slice(CLI_SCOPES_TAG_PREFIX.length).split(','));

    return parsed.ok ? parsed.scopes : [];
  }

  return null;
}

/** The SDK's own `isRPCRequest`: every socket gate reads exactly the frames the SDK will run. */
const RpcFrameSchema = v.object({
  type: v.literal('rpc'),
  id: v.string(),
  method: v.string(),
  args: v.array(v.unknown()),
});

export interface RpcFrame {
  readonly id: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export function rpcFrameOf(message: WSMessage): RpcFrame | null {
  if (!v.is(v.string(), message)) return null;
  const frame = v.safeParse(RpcFrameSchema, tolerate(() => JSON.parse(message), 'malformed-input'));

  return frame.success ? { id: frame.output.id, method: frame.output.method, args: frame.output.args } : null;
}

interface RpcDenial {
  error: string;
  reason: 'not_invokable' | 'scope_missing' | 'interactive_only';
}

function rpcDenial(method: string, access: AgentRpcAccess | null, required: AccessTokenScope | null): RpcDenial {
  if (access === 'never') {
    return { error: `${method} is not remotely invokable.`, reason: 'not_invokable' };
  }

  if (required) {
    return {
      error: `This access token does not have the ${required} scope required by ${method}.`,
      reason: 'scope_missing',
    };
  }

  return {
    error: `${method} requires an interactive CLI session token. Sign in with: kinu auth`,
    reason: 'interactive_only',
  };
}

/** Returns an rpc-error frame for an out-of-scope call on an access-token connection; else null. */
export function rejectOutOfScopeRpc(tags: Iterable<string>, message: WSMessage): string | null {
  const scopes = cliScopesFromTags(tags);

  if (scopes === null) return null;
  const rpc = rpcFrameOf(message);

  if (rpc === null) return null;
  const { id, method } = rpc;

  const access = requiredRpcAccess(method);
  const required = rpcAccessScope(access);

  if (required && scopes.includes(required)) return null;

  const { error, reason } = rpcDenial(method, access, required);

  // Log the refused method and wanted scope, never the token or frame. `outcome` is explicit: the
  // sink reads 'ok' by default, which would count refusals as successes.
  diagnostics.event('rpc_gate.denied', {
    outcome: 'denied',
    reason,
    tool: method,
    source: required ?? 'interactive',
  });

  return JSON.stringify({ type: 'rpc', id, success: false, error });
}

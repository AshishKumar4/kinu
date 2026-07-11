/**
 * Scope enforcement for the agent websocket — the DO-side counterpart to the
 * REST router's accessTokenDenial. A scoped `pta_…` access token with
 * `workspace.exec` may mint a connect ticket, and the resulting websocket reaches
 * the OrchestratorAgent's full @callable RPC surface; this module pins those
 * connections to chat frames plus an explicit read-only RPC allowlist.
 *
 * The edge worker verifies the ticket, resolves the bearer's scopes, and
 * forwards them on a worker-set header (never trusted from the client). The
 * DO persists them as a connection tag — tags ride the WebSocket attachment,
 * so the restriction survives DO hibernation — and rejects out-of-scope
 * `{type:'rpc'}` frames before the agents-SDK dispatcher sees them.
 *
 * Interactive `ptc_…` session sockets carry no scope header/tag and stay
 * unrestricted.
 */
import { type AccessTokenScope, normalizeAccessTokenScopes } from './access-token-store.js';

/** Worker→DO header carrying the verified connect-ticket scopes. Always
 *  rewritten by the edge after authentication so clients cannot smuggle it. */
export const CLI_SCOPES_HEADER = 'x-proteus-cli-scopes';

/** Connection tag persisting the scope restriction across hibernation. */
const CLI_SCOPES_TAG_PREFIX = 'cli-scopes:';

/** Read-only @callables a scoped connection may invoke, keyed to the scope
 *  each requires — the websocket mirror of requiredAccessScope in
 *  cli/routes.ts. Every other @callable (consent, config, model, fork,
 *  revert, restore, approval mode, …) is denied: methods added in the future
 *  are interactive-session-only until listed here. */
const SCOPED_RPC_ALLOWLIST: Record<string, AccessTokenScope> = {
  getEvolutionChangelog: 'workspace.read',
  listMounts: 'workspace.read',
  getWorkspaceAgents: 'workspace.read',
  latestAlternateTakes: 'workspace.read',
  listFileCheckpoints: 'workspace.read',
  planFileRestore: 'workspace.read',
  checkpointStatus: 'workspace.read',
};

/** Build the connection tag for a verified scopes header value; null when the
 *  connection is unrestricted (interactive session or browser). */
export function cliScopesConnectionTag(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const normalized = normalizeAccessTokenScopes(headerValue.split(','));
  // A scoped header that fails to parse must fail closed, not fall open to
  // an unrestricted connection: an empty scope set denies every RPC.
  return `${CLI_SCOPES_TAG_PREFIX}${normalized.ok ? normalized.scopes.join(',') : ''}`;
}

/** Scopes persisted on a connection's tags; null when unrestricted. */
export function cliScopesFromTags(tags: Iterable<string>): AccessTokenScope[] | null {
  for (const tag of tags) {
    if (!tag.startsWith(CLI_SCOPES_TAG_PREFIX)) continue;
    const parsed = normalizeAccessTokenScopes(tag.slice(CLI_SCOPES_TAG_PREFIX.length).split(','));
    return parsed.ok ? parsed.scopes : [];
  }
  return null;
}

/** Gate one inbound websocket frame. Returns a serialized rpc-error frame to
 *  send back when the frame is an out-of-scope `{type:'rpc'}` request from an
 *  access-token connection; null when the frame may proceed (chat frames,
 *  allowlisted read RPCs, and everything on unrestricted connections). */
export function rejectOutOfScopeRpc(tags: Iterable<string>, message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const scopes = cliScopesFromTags(tags);
  if (scopes === null) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(message); } catch { return null; }
  // Match exactly the frames the agents-SDK dispatches as RPC.
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'rpc' || typeof frame.id !== 'string'
    || typeof frame.method !== 'string' || !Array.isArray(frame.args)) return null;

  const required = SCOPED_RPC_ALLOWLIST[frame.method];
  if (required && scopes.includes(required)) return null;
  const error = required
    ? `This access token does not have the ${required} scope required by ${frame.method}.`
    : `${frame.method} requires an interactive CLI session token. Sign in with: proteus auth`;
  return JSON.stringify({ type: 'rpc', id: frame.id, success: false, error });
}

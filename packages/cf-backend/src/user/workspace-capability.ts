/**
 * Workspace capability tokens + the taint registry — the UserDO's caller
 * boundary.
 *
 * Every secret a Proteus user owns (provider credentials, MCP servers, the
 * physical-machine tunnel, the product-change ledger) lives in their UserDO,
 * and until now any holder of a UserDO stub reached all of it. This module is
 * the attenuation primitive: a workspace Durable Object proves WHICH workspace
 * it is with a per-workspace secret, and the UserDO looks its tier up live.
 *
 * The token is identity, not capability. Tier state lives only in
 * `workspace_tiers`, so re-tainting or restoring a workspace is a single row
 * update — no token rotation, no cached grants to invalidate.
 *
 * Secrets are hashed at rest exactly like `user_cli_tokens` / `user_devices`:
 * the raw token is returned once to the workspace DO and never stored here.
 *
 * Trust boundary, stated honestly: Cloudflare gives a Durable Object no way to
 * learn which stub-holder is calling it, so `OWNER_SESSION` is a claim, not a
 * proof. What this boundary buys is that the *tool surface* — the part of
 * Proteus an injected prompt can steer — reaches the UserDO only through code
 * that presents a workspace token, and is therefore attenuated by tier no
 * matter which tool gate someone forgets. It is not a defence against edits to
 * Proteus's own trusted source.
 */
import { nanoid } from '@proteus/core';
import { sha256Hex } from '../lib/crypto.js';

export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

/** A workspace's reach into the owner's wider world.
 *  - `full`   — solo-owner workspace: the whole user surface.
 *  - `shared` — a second human can put text into this agent's context, so every
 *               turn is potentially adversarial: in-workspace capability is
 *               untouched, reach beyond it is cut. */
export type WorkspaceTier = 'full' | 'shared';

const TIER_RANK: Record<WorkspaceTier, number> = { shared: 1, full: 2 };

function isWorkspaceTier(value: unknown): value is WorkspaceTier {
  return value === 'full' || value === 'shared';
}

/**
 * The attenuation matrix, as data. Every privileged UserDO method names one of
 * these; the minimum tier here is the whole policy.
 *
 * `full` is the fail-closed default for anything reaching outside the
 * workspace. Only two capabilities survive tainting, and both are load-bearing
 * for the agent's own function rather than reach into the owner's world:
 * model-inference credentials (headers attach inside trusted DO code and never
 * enter LLM context) and renaming the calling workspace itself.
 */
export const WORKSPACE_CAPABILITY_TIERS = {
  /** Provider credentials used for model inference (+ the model picker's view
   *  of them). Kept: the agent must still be able to think. */
  'credentials.model': 'shared',
  /** Everything else in the credential store (`github`, future admin keys) and
   *  every write to it. A guest-steered agent holding the owner's GitHub PAT is
   *  repo takeover. */
  'credentials.other': 'full',
  /** Cloudflare AI Gateway discovery/selection — account administration, not
   *  inference. */
  'ai_gateway.admin': 'full',
  /** MCP tool descriptors + dispatch. MCP tools act with the owner's
   *  credentials against the owner's accounts. */
  'mcp.tools': 'full',
  /** MCP server registry (add/remove/update/list/OAuth callback). */
  'mcp.manage': 'full',
  /** JSON-RPC onto the owner's physical machine. */
  'device.rpc': 'full',
  /** Per-(agent, device) consent policy — read or write. Consent UI reachable
   *  by the wrong human is a confused-deputy trap, so there is no ask-flow at
   *  `shared` either. */
  'device.consent': 'full',
  /** Device registry + the daemon's own token/ticket exchange. */
  'device.manage': 'full',
  /** The owner's workspace roster — the peer roster is this list. Reading it
   *  leaks the owner's other workspace names. */
  'workspaces.read': 'full',
  /** Registry writes: create (the escape hatch out of confinement), delete,
   *  visit tracking. */
  'workspaces.write': 'full',
  /** Renaming the CALLING workspace. Workspace-scoped, so it survives
   *  tainting; callers may never rename a different workspace. */
  'workspaces.rename_self': 'shared',
  /** Cross-owner peer admission grants. */
  'peers.grants': 'full',
  /** The product-change ledger. Deploy governance is owner-level by
   *  definition. */
  'product_change': 'full',
  /** The owner's profile — their verified email is what outbound notifications
   *  and inbound email trust are keyed on. */
  'profile': 'full',
  /** User-level defaults (default model, strategy, gateway selection). */
  'config': 'full',
  /** CLI bearer tokens, CI access tokens, agent websocket tickets. Minting one
   *  of these is account takeover. */
  'auth_tokens': 'full',
  /** The Codex OAuth device flow. */
  'codex_auth': 'full',
} as const satisfies Record<string, WorkspaceTier>;

export type WorkspaceCapability = keyof typeof WORKSPACE_CAPABILITY_TIERS;

/** Who is invoking a privileged UserDO method.
 *
 *  `OWNER_SESSION` — a Worker route acting for the owner, whose identity the
 *  edge already verified (session cookie, CLI bearer, or the DO's own internal
 *  use of a sibling method).
 *
 *  `{ workspaceToken }` — a workspace Durable Object presenting the secret the
 *  owner's UserDO minted for it. */
export const OWNER_SESSION = 'owner_session' as const;
export type UserCaller = typeof OWNER_SESSION | { readonly workspaceToken: string };

export type ResolvedCaller =
  | { readonly kind: 'owner_session' }
  | { readonly kind: 'workspace'; readonly workspace: string; readonly tier: WorkspaceTier };

/** Thrown by `requireTier`. Crosses the Worker→DO RPC boundary as its message,
 *  which is written to be honest to both a human and an LLM reading a tool
 *  error: agents behave better when limits are declared than when calls
 *  mysteriously fail. */
export class CapabilityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDeniedError';
  }
}

export function initWorkspaceCapabilityTables(sql: SqlExec): void {
  // One row per workspace that has ever claimed an owner. `token_hash` is the
  // workspace's proof of identity; the raw token lives only in that workspace's
  // own Durable Object.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_capability_tokens (
      workspace_name TEXT PRIMARY KEY,
      token_hash     TEXT NOT NULL UNIQUE,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_capability_token_hash
              ON workspace_capability_tokens (token_hash)`);

  // The taint registry. Written alongside the token at claim time and by the
  // share/unshare flow thereafter. A capability token whose workspace has no
  // row here is denied — the registry is authoritative, and a half-applied
  // share must not read as `full`.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_tiers (
      workspace_name TEXT PRIMARY KEY,
      tier           TEXT NOT NULL CHECK (tier IN ('full','shared')),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}

/** The hash currently registered for a workspace, or null when it has never
 *  been issued an identity. Comparing this against the hash the workspace
 *  itself reports is what makes provisioning self-healing: any disagreement,
 *  however it arose, is repaired by re-minting. */
export function workspaceCapabilityHash(sql: SqlExec, workspaceName: string): string | null {
  const row = sql.exec(
    `SELECT token_hash FROM workspace_capability_tokens WHERE workspace_name = ? LIMIT 1`, workspaceName,
  ).toArray()[0];
  return typeof row?.token_hash === 'string' ? row.token_hash : null;
}

/** Mint (or re-mint) the capability token for `workspaceName` and ensure it has
 *  a tier. Re-minting replaces the previous secret, which is how a workspace
 *  whose Durable Object storage was reset recovers; the tier is preserved so a
 *  re-mint can never launder a tainted workspace back to `full`. */
export async function mintWorkspaceCapability(
  sql: SqlExec,
  workspaceName: string,
): Promise<{ token: string; tokenHash: string }> {
  const token = `pwc_${nanoid(44)}`;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_capability_tokens (workspace_name, token_hash, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
    workspaceName, tokenHash, now,
  );
  sql.exec(
    `INSERT INTO workspace_tiers (workspace_name, tier, updated_at) VALUES (?, 'full', ?)
     ON CONFLICT(workspace_name) DO NOTHING`,
    workspaceName, now,
  );
  return { token, tokenHash };
}

/** Drop a workspace's identity and tier — called when the workspace itself is
 *  deleted, so a later same-name recreate starts from a fresh secret. */
export function revokeWorkspaceCapability(sql: SqlExec, workspaceName: string): void {
  sql.exec(`DELETE FROM workspace_capability_tokens WHERE workspace_name = ?`, workspaceName);
  sql.exec(`DELETE FROM workspace_tiers WHERE workspace_name = ?`, workspaceName);
}

/** The registered tier, or null when the workspace has no registry row. */
export function getWorkspaceTier(sql: SqlExec, workspaceName: string): WorkspaceTier | null {
  const row = sql.exec(
    `SELECT tier FROM workspace_tiers WHERE workspace_name = ? LIMIT 1`, workspaceName,
  ).toArray()[0];
  return isWorkspaceTier(row?.tier) ? row.tier : null;
}

/** The taint registry's write path. Wave B1 mints every workspace `full`; the
 *  share/unshare flow is what moves a workspace to `shared` and back. */
export function setWorkspaceTier(sql: SqlExec, workspaceName: string, tier: WorkspaceTier): void {
  sql.exec(
    `INSERT INTO workspace_tiers (workspace_name, tier, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_name) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    workspaceName, tier, Date.now(),
  );
}

/** Resolve a caller to a principal. Fails closed at every step: an
 *  unrecognized shape, an unknown token, or a token whose workspace has no
 *  registry row is denied rather than defaulted. */
async function resolveCaller(sql: SqlExec, caller: UserCaller): Promise<ResolvedCaller> {
  if (caller === OWNER_SESSION) return { kind: 'owner_session' };
  const token = (caller as { workspaceToken?: unknown } | null)?.workspaceToken;
  if (typeof token !== 'string' || token === '') {
    throw new CapabilityDeniedError(
      'This call carried no workspace identity. Privileged user-level calls must present a workspace capability token.',
    );
  }
  const tokenHash = await sha256Hex(token);
  const row = sql.exec(
    `SELECT workspace_name FROM workspace_capability_tokens WHERE token_hash = ? LIMIT 1`, tokenHash,
  ).toArray()[0];
  const workspace = typeof row?.workspace_name === 'string' ? row.workspace_name : null;
  if (!workspace) {
    throw new CapabilityDeniedError('Unrecognized workspace capability token.');
  }
  const tier = getWorkspaceTier(sql, workspace);
  if (!tier) {
    throw new CapabilityDeniedError(
      `Workspace "${workspace}" has no capability tier registered; refusing the call.`,
    );
  }
  return { kind: 'workspace', workspace, tier };
}

/** The gate. Called first thing in every privileged UserDO method; returns the
 *  resolved principal so a method can additionally scope itself (e.g. renaming
 *  only the calling workspace). */
export async function requireTier(
  sql: SqlExec,
  caller: UserCaller,
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  const resolved = await resolveCaller(sql, caller);
  if (resolved.kind === 'owner_session') return resolved;
  const minimum = WORKSPACE_CAPABILITY_TIERS[capability];
  if (TIER_RANK[resolved.tier] < TIER_RANK[minimum]) {
    throw new CapabilityDeniedError(
      `"${capability}" is not available to a ${resolved.tier} workspace. `
      + `Workspace "${resolved.workspace}" is shared with someone other than its owner, `
      + 'so it keeps full capability inside itself but cannot reach the owner\'s wider account.',
    );
  }
  return resolved;
}

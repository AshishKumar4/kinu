/**
 * Workspace capability tokens + the taint registry — the UserDO's caller
 * boundary.
 *
 * Every secret a Proteus user owns (provider credentials, MCP servers, the
 * physical-machine tunnel, the release ledger) lives in their UserDO,
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
 * Trust boundary, stated honestly. Cloudflare gives a Durable Object no way to
 * learn which stub-holder is calling it, so no caller kind here is an
 * attestation of WHO is calling — both kinds are secrets, and the boundary is
 * exactly "does the caller hold this secret".
 *
 *   - A workspace token is held only by that workspace's Durable Object, so it
 *     genuinely names one workspace and carries its tier.
 *   - The owner capability is derived from a Worker secret, so it cannot be
 *     typed, guessed, or reached by code running without the bindings — the
 *     Loader-sandboxed crafted tools, the sandbox container, the CLI, the
 *     browser. It is NOT a defence against other Durable Objects in this same
 *     Worker script, which share `env` and can derive it too; that is not
 *     expressible on this platform, and pretending otherwise would be worse
 *     than saying so.
 *
 * What the boundary buys is unchanged and still the point: the *tool surface* —
 * the part of Proteus an injected prompt can steer — reaches the UserDO only
 * through code that presents a workspace token, and is therefore attenuated by
 * tier no matter which tool gate someone forgets.
 */
import { nanoid, type SqlExec } from '@proteus/core';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../lib/crypto';
import * as v from 'valibot';

/** A workspace's reach into the owner's wider world.
 *  - `full`   — solo-owner workspace: the whole user surface.
 *  - `shared` — a second human can put text into this agent's context, so every
 *               turn is potentially adversarial: in-workspace capability is
 *               untouched, reach beyond it is cut. */
export type WorkspaceTier = 'full' | 'shared';

const TIER_RANK = { shared: 1, full: 2 } satisfies Record<WorkspaceTier, number>;

function isWorkspaceTier<Value>(value: Value): value is Value & WorkspaceTier {
  return v.is(v.picklist(['full', 'shared']), value);
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
  /** The egress secret vault: add, rotate, revoke, and list bindings. Binding
   *  the owner's secret to a host is the same class of act as storing a
   *  credential, so it sits beside `credentials.other` at `full`. */
  'egress_secrets.manage': 'full',
  /** Turning a placeholder in an intercepted request back into the real
   *  secret. `full` because a tainted workspace must not be able to ask for
   *  the substitution even though the container it rides already holds the
   *  placeholder — the placeholder is not the authority, this call is. */
  'egress_secrets.inject': 'full',
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
  /** Reading the owner's experience library — the crafts, lessons and facts
   *  the owner's OTHER workspaces published. Hits carry their source workspace
   *  and their content, so this is the same leak `workspaces.read` is. */
  'experience.read': 'full',
  /** Publishing into that library. A shared workspace's knowledge is partly
   *  a guest's; letting it flow into the owner's other workspaces would carry
   *  injected content straight past the boundary. */
  'experience.write': 'full',
  /** The release ledger. Deploy governance is owner-level by
   *  definition. */
  'release': 'full',
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
 *  `{ ownerToken }` — Worker code acting for the owner, whose identity the edge
 *  already verified (session cookie, CLI bearer), or the DO's own internal use
 *  of a sibling method. Obtained from `ownerCaller(env)`; see the trust-boundary
 *  note at the top of this file for exactly what it proves.
 *
 *  `{ workspaceToken }` — a workspace Durable Object presenting the secret the
 *  owner's UserDO minted for it. */
export type UserCaller = { readonly ownerToken: string } | { readonly workspaceToken: string };

export type ResolvedCaller =
  | { readonly kind: 'owner_session' }
  | { readonly kind: 'workspace'; readonly workspace: string; readonly tier: WorkspaceTier };

/** The bindings the owner capability is derived from. Deliberately the same
 *  secret that seals the credential store: both are the Worker's root trust
 *  material for the user plane, so there is one thing to provision, one thing
 *  to rotate, and no second key whose absence is a silent downgrade. The two
 *  uses are domain-separated by the label below, so neither value can stand in
 *  for the other. */
export interface OwnerCapabilityEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

const OWNER_CAPABILITY_LABEL = 'proteus.owner-capability.v1';

/** Derived tokens, cached per secret — the derivation is deterministic, so the
 *  cache holds nothing the process was not already holding. */
const ownerTokens = new Map<string, Promise<string>>();

/**
 * The caller a Worker route presents when it is acting for the signed-in
 * owner. Async and env-bound on purpose: owner authority is a secret this
 * deployment holds, not a string any module can type.
 */
export async function ownerCaller(env: OwnerCapabilityEnv): Promise<UserCaller> {
  return { ownerToken: await ownerToken(env) };
}

/** Thrown when the deployment holds no root secret. Its own class because the
 *  whole signed-in surface depends on it, and both the browser and CLI planes
 *  turn it into one deliberate answer instead of an opaque 500. */
export class OwnerCapabilityUnavailableError extends Error {
  constructor() {
    super(
      'This deployment is not configured to serve signed-in users: CREDENTIAL_ENCRYPTION_KEY is not set. '
      + 'See docs/DEPLOYMENT.md.',
    );
    this.name = 'OwnerCapabilityUnavailableError';
  }
}

function ownerToken(env: OwnerCapabilityEnv): Promise<string> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  if (!secret) throw new OwnerCapabilityUnavailableError();
  let pending = ownerTokens.get(secret);
  if (!pending) {
    pending = hmacSha256Hex(secret, OWNER_CAPABILITY_LABEL);
    ownerTokens.set(secret, pending);
  }
  return pending;
}

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
  const row = v.safeParse(v.object({ token_hash: v.string() }), sql.exec(
    `SELECT token_hash FROM workspace_capability_tokens WHERE workspace_name = ? LIMIT 1`, workspaceName,
  ).toArray()[0]);
  return row.success ? row.output.token_hash : null;
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
const UserCallerSchema = v.union([
  v.object({ ownerToken: v.string() }),
  v.object({ workspaceToken: v.string() }),
]);

async function resolveCaller<Caller>(sql: SqlExec, env: OwnerCapabilityEnv, caller: Caller): Promise<ResolvedCaller> {
  const parsedCaller = v.safeParse(UserCallerSchema, caller);
  if (!parsedCaller.success) {
    throw new CapabilityDeniedError(
      'This call carried no valid caller identity. Privileged user-level calls must present a capability token.',
    );
  }
  if ('ownerToken' in parsedCaller.output) {
    const presentedOwner = parsedCaller.output.ownerToken;
    if (timingSafeEqual(presentedOwner, await ownerToken(env))) return { kind: 'owner_session' };
    throw new CapabilityDeniedError('Unrecognized owner capability.');
  }
  const token = parsedCaller.output.workspaceToken;
  if (token === '') {
    throw new CapabilityDeniedError(
      'This call carried no workspace identity. Privileged user-level calls must present a workspace capability token.',
    );
  }
  const tokenHash = await sha256Hex(token);
  const row = v.safeParse(v.object({ workspace_name: v.string() }), sql.exec(
    `SELECT workspace_name FROM workspace_capability_tokens WHERE token_hash = ? LIMIT 1`, tokenHash,
  ).toArray()[0]);
  const workspace = row.success ? row.output.workspace_name : null;
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
export async function requireTier<Caller>(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  caller: Caller,
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  const resolved = await resolveCaller(sql, env, caller);
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

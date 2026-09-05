/**
 * Workspace capability tokens — the UserDO's caller boundary.
 *
 * Every secret a Kinu user owns (provider credentials, MCP servers, the
 * physical-machine tunnel, the release ledger) lives in their UserDO,
 * and until now any holder of a UserDO stub reached all of it. This module is
 * the attenuation primitive: a workspace Durable Object proves WHICH workspace
 * it is with a per-workspace secret, and the UserDO admits what that identity
 * may reach.
 *
 * The token is identity, not authority. The raw token is returned once to the
 * workspace DO and never stored here. Secrets are hashed at rest exactly like
 * `user_cli_tokens` / `user_devices`.
 *
 * Trust boundary, stated honestly. Cloudflare gives a Durable Object no way to
 * learn which stub-holder is calling it, so no caller kind here is an
 * attestation of WHO is calling — both kinds are secrets, and the boundary is
 * exactly "does the caller hold this secret".
 *
 *   - A workspace token is held only by that workspace's Durable Object, so it
 *     genuinely names one workspace. It reaches every capability except the
 *     account authorities the matrix marks `owner_only`.
 *   - The owner capability is derived from a Worker secret, so it cannot be
 *     typed, guessed, or reached by code running without the bindings — the
 *     Loader-sandboxed crafted tools, the sandbox container, the CLI, the
 *     browser. It is NOT a defence against other Durable Objects in this same
 *     Worker script, which share `env` and can derive it too; that is not
 *     expressible on this platform, and pretending otherwise would be worse
 *     than saying so.
 *
 * What the boundary buys is unchanged and still the point: the *tool surface* —
 * the part of Kinu an injected prompt can steer — reaches the UserDO only
 * through code that presents a workspace token, and is therefore attenuated
 * no matter which tool gate someone forgets.
 */
import { nanoid, type SqlExec } from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../lib/crypto';
import * as v from 'valibot';

/** What a capability requires of its caller.
 *
 *  `workspace` admits the signed-in owner and any workspace holding a
 *  registered capability token. `owner_only` admits no workspace at all: the
 *  capability IS an account authority, and a workspace capability token is
 *  never one. Device registration and device consent are the two — a
 *  workspace that could register a device would mint a device token and dial
 *  its own daemon, and one that could write consent would grant itself the
 *  owner's shell.
 *
 *  This is capability-level. A capability a workspace legitimately uses may
 *  still hold an owner-only METHOD (the profile catalog inside `config`), and
 *  that stays a check in the method. */
export type CapabilityFloor = 'workspace' | 'owner_only';

/**
 * The attenuation matrix, as data. Every privileged UserDO method names one of
 * these; the floor here is the whole policy.
 *
 * `workspace` is the default for anything a workspace legitimately reaches.
 * `owner_only` marks the account authorities no workspace token ever carries:
 * device registration and device consent.
 */
const WORKSPACE_CAPABILITY_TIERS = {
  /** Provider credentials used for model inference (+ the model picker's view
   *  of them). Kept: the agent must still be able to think. */
  'credentials.model': 'workspace',
  /** Everything else in the credential store (`github`, future admin keys) and
   *  every write to it. A steered agent holding the owner's GitHub PAT is
   *  repo takeover. */
  'credentials.other': 'workspace',
  /** The egress secret vault: add, rotate, revoke, and list bindings. Binding
   *  the owner's secret to a host is the same class of act as storing a
   *  credential, so it sits beside `credentials.other`. */
  'egress_secrets.manage': 'workspace',
  /** Turning a placeholder in an intercepted request back into the real
   *  secret. The destination and grant check happens here — the placeholder
   *  the container holds is not the authority, this call is. */
  'egress_secrets.inject': 'workspace',
  /** Cloudflare AI Gateway discovery/selection — account administration, not
   *  inference. */
  'ai_gateway.admin': 'workspace',
  /** MCP tool descriptors + dispatch. MCP tools act with the owner's
   *  credentials against the owner's accounts. */
  'mcp.tools': 'workspace',
  /** MCP server registry (add/remove/update/list/OAuth callback). */
  'mcp.manage': 'workspace',
  /** JSON-RPC onto the owner's physical machine. */
  'device.rpc': 'workspace',
  /** WRITING the per-(agent, device) consent policy, and reading the whole
   *  account's roster of grants. Owner-only: a workspace that can write this
   *  table grants itself `full_filesystem` on the owner's machine and skips the
   *  card entirely, which is the confused-deputy trap the ask-flow exists to
   *  prevent. Every caller is an owner-authenticated settings route. */
  'device.consent': 'owner_only',
  /** Asking whether THE CALLING workspace holds the full-filesystem tier on
   *  the connected device. The device file view narrows itself with the
   *  answer, so refusing it would widen the path scope rather than close it;
   *  the answer is about the caller's own grant and grants nothing. */
  'device.consent.read_self': 'workspace',
  /** Device registry and the daemon's own token/ticket exchange. Owner-only:
   *  `registerDevice` mints a device token, and a token is a daemon slot the
   *  owner's commands can be routed to. */
  'device.manage': 'owner_only',
  /** The owner's workspace roster — the peer roster is this list. Reading it
   *  leaks the owner's other workspace names. */
  'workspaces.read': 'workspace',
  /** Registry writes: create (the escape hatch out of confinement), delete,
   *  visit tracking. */
  'workspaces.write': 'workspace',
  /** Renaming the CALLING workspace. Workspace-scoped; callers may never
   *  rename a different workspace. */
  'workspaces.rename_self': 'workspace',
  /** Cross-owner peer admission grants. */
  'peers.grants': 'workspace',
  /** Reading the owner's experience library — the crafts, lessons, facts and
   *  agent loops the owner's OTHER workspaces published. */
  'experience.read': 'workspace',
  /** Publishing into that library. */
  'experience.write': 'workspace',
  /** The release ledger. Deploy governance is owner-level by
   *  definition. */
  'release': 'workspace',
  /** The owner's profile — their verified email is what outbound notifications
   *  and inbound email trust are keyed on. */
  'profile': 'workspace',
  /** Account role/tier catalog needed to resolve this workspace's next turn. */
  'profile.resolve': 'workspace',
  /** User-level defaults (default model, strategy, gateway selection). */
  'config': 'workspace',
  /** CLI bearer tokens, CI access tokens, agent websocket tickets. Minting one
   *  of these is account takeover. */
  'auth_tokens': 'workspace',
  /** Asking whether a bearer that authenticated a websocket ON THIS WORKSPACE
   *  may still act. The answer is a yes/no about a socket the workspace is
   *  already holding, it names no token and mints nothing, and the only thing
   *  a caller can do with it is CLOSE that socket. */
  'auth_tokens.socket': 'workspace',
  /** The Codex OAuth device flow. */
  'codex_auth': 'workspace',
} as const satisfies Record<string, CapabilityFloor>;

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
  | { readonly kind: 'workspace'; readonly workspace: string };

/** The bindings the owner capability is derived from. Deliberately the same
 *  secret that seals the credential store: both are the Worker's root trust
 *  material for the user plane, so there is one thing to provision, one thing
 *  to rotate, and no second key whose absence is a silent downgrade. The two
 *  uses are domain-separated by the label below, so neither value can stand in
 *  for the other. */
export interface OwnerCapabilityEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

const OWNER_CAPABILITY_LABEL = 'kinu.owner-capability.v1';

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

/**
 * Why a call was refused, as a closed word. The MESSAGE is written for whoever
 * reads the error and names the workspace; the reason is written for whoever
 * counts the denials and must not, which is why there are two of them.
 */
export type CapabilityDenialReason =
  | 'no_caller_identity'
  | 'unrecognized_owner'
  | 'no_workspace_identity'
  | 'unrecognized_workspace'
  | 'owner_only';

/**
 * Refuse a privileged call, and count it.
 *
 * Every denial in this file goes through here rather than constructing the error
 * directly. That is the whole reason it exists: five separate `throw` sites are
 * five chances for the next one to be added without telemetry, and an
 * authorization surface with no denial rate is one whose misconfiguration is
 * invisible until a person complains. The return type is `never`, so a call site
 * reads as the refusal it is.
 *
 * NEITHER THE TOKEN NOR THE MESSAGE IS A FIELD. The message names the workspace,
 * and a workspace name here is mission-derived user text; the reason and the
 * capability are our own vocabulary and are what a rate is grouped by.
 *
 * `outcome` is stated rather than left to default. The analytics sink reads a
 * plain `diagnostics.event` as a success, so without it every refusal this
 * authorization surface produces was counted as one that went through.
 */
function denyCapability(
  reason: CapabilityDenialReason,
  capability: WorkspaceCapability,
  message: string,
): never {
  diagnostics.event('capability.denied', {
    reason, capability, outcome: 'denied', source: 'workspace_capability',
  });
  throw new CapabilityDeniedError(message);
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

  // A rotation whose subtree push did not reach every replica. `token_hash` is
  // the hash the registry already committed, so the row is not a second
  // authority — it is the fact that the ROOT holds that token while some
  // descendant still presents the previous one. Written when a root install
  // reports a missed push and cleared when a full push reports none; every
  // reconcile between the two retries the push, because the hash comparison
  // alone reads "both sides agree" from a root that is the only one agreeing.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_capability_reconcile (
      workspace_name TEXT PRIMARY KEY,
      token_hash     TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}

/** Whether a workspace has a rotation whose subtree push missed a replica. */
export function pendingCapabilityReconcile(sql: SqlExec, workspaceName: string): string | null {
  const row = v.safeParse(v.object({ token_hash: v.string() }), sql.exec(
    `SELECT token_hash FROM workspace_capability_reconcile WHERE workspace_name = ? LIMIT 1`, workspaceName,
  ).toArray()[0]);
  return row.success ? row.output.token_hash : null;
}

/** Record or re-arm a missed subtree push. `attempts` rises on every retry so
 *  a stuck replica is visible as a growing count rather than as silence. */
export function armCapabilityReconcile(sql: SqlExec, workspaceName: string, tokenHash: string): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_capability_reconcile (workspace_name, token_hash, attempts, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(workspace_name) DO UPDATE SET
       token_hash = excluded.token_hash, attempts = attempts + 1, updated_at = excluded.updated_at`,
    workspaceName, tokenHash, now, now,
  );
}

/** Clear the intent once every replica holds the token the registry expects. */
export function clearCapabilityReconcile(sql: SqlExec, workspaceName: string): void {
  sql.exec(`DELETE FROM workspace_capability_reconcile WHERE workspace_name = ?`, workspaceName);
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

/** A fresh capability secret and its hash, written NOWHERE.
 *
 *  Hashing is asynchronous, and a Durable Object serializes nothing across an
 *  await: a mint that hashed and wrote in one call had a delete land between the
 *  two, and the write then revived the identity of a workspace whose teardown
 *  had already revoked it. Splitting the async half out is what lets the caller
 *  re-check its admission and write in ONE synchronous turn — see
 *  {@link commitWorkspaceCapability}. */
export async function freshWorkspaceCapability(): Promise<{ token: string; tokenHash: string }> {
  const token = `pwc_${nanoid(44)}`;
  return { token, tokenHash: await sha256Hex(token) };
}

/** Register (or re-register) a freshly minted capability hash for
 *  `workspaceName`. Re-minting replaces the previous secret, which is how a
 *  workspace whose Durable Object storage was reset recovers.
 *
 *  SYNCHRONOUS, and it must stay that way: the caller's admission check and
 *  this write are one uninterruptible turn, which is what makes a revoked
 *  workspace impossible to re-mint from a reconcile already in flight.
 */
export function commitWorkspaceCapability(sql: SqlExec, workspaceName: string, tokenHash: string): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_capability_tokens (workspace_name, token_hash, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
    workspaceName, tokenHash, now,
  );
}

/** Drop a workspace's identity — called when the workspace itself is
 *  deleted, so a later same-name recreate starts from a fresh secret. */
export function revokeWorkspaceCapability(sql: SqlExec, workspaceName: string): void {
  sql.exec(`DELETE FROM workspace_capability_tokens WHERE workspace_name = ?`, workspaceName);
}

/** Resolve a caller to a principal. Fails closed at every step: an
 *  unrecognized shape, an unknown token, or a token whose workspace has no
 *  registry row is denied rather than defaulted. */
const UserCallerSchema = v.union([
  v.object({ ownerToken: v.string() }),
  v.object({ workspaceToken: v.string() }),
]);

async function resolveCaller<Caller>(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  caller: Caller,
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  const parsedCaller = v.safeParse(UserCallerSchema, caller);
  if (!parsedCaller.success) {
    denyCapability('no_caller_identity', capability,
      'This call carried no valid caller identity. Privileged user-level calls must present a capability token.');
  }
  if ('ownerToken' in parsedCaller.output) {
    const presentedOwner = parsedCaller.output.ownerToken;
    if (timingSafeEqual(presentedOwner, await ownerToken(env))) return { kind: 'owner_session' };
    denyCapability('unrecognized_owner', capability, 'Unrecognized owner capability.');
  }
  const token = parsedCaller.output.workspaceToken;
  if (token === '') {
    denyCapability('no_workspace_identity', capability,
      'This call carried no workspace identity. Privileged user-level calls must present a workspace capability token.');
  }
  const tokenHash = await sha256Hex(token);
  const row = v.safeParse(v.object({ workspace_name: v.string() }), sql.exec(
    `SELECT workspace_name FROM workspace_capability_tokens WHERE token_hash = ? LIMIT 1`, tokenHash,
  ).toArray()[0]);
  const workspace = row.success ? row.output.workspace_name : null;
  if (!workspace) {
    denyCapability('unrecognized_workspace', capability, 'Unrecognized workspace capability token.');
  }
  return { kind: 'workspace', workspace };
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
  const resolved = await resolveCaller(sql, env, caller, capability);
  if (resolved.kind === 'owner_session') return resolved;
  if (WORKSPACE_CAPABILITY_TIERS[capability] === 'owner_only') {
    denyCapability('owner_only', capability,
      `"${capability}" is an account authority and is reachable only by the signed-in owner. `
      + `Workspace "${resolved.workspace}" presented a workspace capability token, which never carries `
      + 'owner authority.');
  }
  return resolved;
}

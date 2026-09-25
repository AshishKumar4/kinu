/**
 * Workspace capability tokens: the UserDO's caller boundary. A Durable Object cannot learn which stub-holder
 * calls it, so both caller kinds are secrets; the owner capability does not defend against other DOs in this Worker.
 */

import * as v from 'valibot';
import { diagnostics } from '../obs/log';
import type { SqlExec } from '../types/primitives';
import { hmacSha256Hex, timingSafeEqual } from '../utils/crypto';
import { nanoid } from '../utils/nanoid';
import { sha256Hex } from './argument-digest';

/** `workspace` admits the owner and any registered workspace token; `owner_only` admits no workspace
 *  (account authorities). Owner-only methods inside a workspace capability stay checked in the method. */
export type CapabilityFloor = 'workspace' | 'owner_only';

/** The attenuation matrix; every privileged UserDO method names one entry. */
const WORKSPACE_CAPABILITY_TIERS = {
  /** Provider credentials for model inference and the model picker's view of them. */
  'credentials.model': 'workspace',
  /** The rest of the credential store (`github`, admin keys) and every write to it. */
  'credentials.other': 'workspace',
  /** Egress secret vault: add, rotate, revoke, list bindings. */
  'egress_secrets.manage': 'workspace',
  /** Resolving an intercepted placeholder to the real secret; the destination and grant check happens here. */
  'egress_secrets.inject': 'workspace',
  /** AI Gateway discovery/selection: account administration, not inference. */
  'ai_gateway.admin': 'workspace',
  /** MCP tool descriptors and dispatch (acts with the owner's credentials). */
  'mcp.tools': 'workspace',
  'mcp.manage': 'workspace',
  'device.rpc': 'workspace',
  /** Writing per-(agent, device) consent and reading all grants. Owner-only: a workspace writing this grants itself
   *  `full_filesystem` and skips the ask card. */
  'device.consent': 'owner_only',
  /** Whether the calling workspace holds the full-filesystem tier; refusing would widen the file view, not close it. */
  'device.consent.read_self': 'workspace',
  /** Device registry and daemon token/ticket exchange. Owner-only: `registerDevice` mints a device token. */
  'device.manage': 'owner_only',
  /** The owner's workspace roster (leaks other workspace names). */
  'workspaces.read': 'workspace',
  /** Registry writes: create (the escape hatch out of confinement), delete, visit tracking. */
  'workspaces.write': 'workspace',
  /** Renaming the calling workspace only. */
  'workspaces.rename_self': 'workspace',
  /** The calling workspace's own tile only. */
  'workspaces.overview_self': 'workspace',
  'peers.grants': 'workspace',
  /** Reading the owner's experience library published by other workspaces. */
  'experience.read': 'workspace',
  'experience.write': 'workspace',
  'release': 'workspace',
  /** The owner's profile; notification and inbound email trust key on its verified email. */
  'profile': 'workspace',
  /** The account itself. Owner-only: resetting it could erase every sibling workspace. */
  'account': 'owner_only',
  'profile.resolve': 'workspace',
  'config': 'workspace',
  /** CLI bearer tokens, CI access tokens, websocket tickets. Minting one is account takeover. */
  'auth_tokens': 'workspace',
  /** Whether a bearer that authenticated a socket on this workspace may still act; names no token, mints nothing. */
  'auth_tokens.socket': 'workspace',
  'codex_auth': 'workspace',
  /** Blueprints other accounts shared with this owner. Owner-only: forking is the owner's browser asking. */
  'shares': 'owner_only',
  /** The owner's Drive as the web UI manages it. Owner-only: workspaces already reach it via their `/shared` mount. */
  'drive': 'owner_only',
} as const satisfies Record<string, CapabilityFloor>;

export type WorkspaceCapability = keyof typeof WORKSPACE_CAPABILITY_TIERS;

/** `{ ownerToken }`: Worker code acting for an edge-verified owner, from `ownerCaller(env)`.
 *  `{ workspaceToken }`: a workspace DO presenting its minted secret. */
export type UserCaller = { readonly ownerToken: string } | { readonly workspaceToken: string };

export type ResolvedCaller =
  | { readonly kind: 'owner_session' }
  | { readonly kind: 'workspace'; readonly workspace: string };

/** Same root secret that seals the credential store, domain-separated by the label below. */
export interface OwnerCapabilityEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

const OWNER_CAPABILITY_LABEL = 'kinu.owner-capability.v1';

const ownerTokens = new Map<string, Promise<string>>();

/** Caller for Worker routes acting for the signed-in owner; env-bound because owner authority is a deployment secret. */
export async function ownerCaller(env: OwnerCapabilityEnv): Promise<UserCaller> {
  return { ownerToken: await ownerToken(env) };
}

/** The deployment holds no root secret; browser and CLI planes map it to a deliberate answer, not a 500. */
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

/** Thrown by `requireTier`; crosses the Worker→DO RPC boundary as its message. */
export class CapabilityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDeniedError';
  }
}

/** Closed denial reason for counting; the message names the workspace and is not a telemetry field. */
export type CapabilityDenialReason =
  | 'no_caller_identity'
  | 'unrecognized_owner'
  | 'no_workspace_identity'
  | 'unrecognized_workspace'
  | 'owner_only';

/** Refuses and counts a privileged call; every denial goes through here. `outcome` is explicit because the sink
 *  reads a plain `diagnostics.event` as success. Neither token nor message is logged. */
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
  // `token_hash` is the workspace's identity proof; the raw token lives only in that workspace's DO.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_capability_tokens (
      workspace_name TEXT PRIMARY KEY,
      token_hash     TEXT NOT NULL UNIQUE,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_capability_token_hash
              ON workspace_capability_tokens (token_hash)`);

  // A rotation whose subtree push missed a replica; not a second authority. Every reconcile retries the push until a full
  // push clears it, because the hash comparison alone passes when only the root agrees.
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

type CapabilityHashTable = 'workspace_capability_tokens' | 'workspace_capability_reconcile';

/** Table name is a literal of the pair above, never caller text. */
function registeredTokenHash(sql: SqlExec, table: CapabilityHashTable, workspaceName: string): string | null {
  const row = v.safeParse(v.object({ token_hash: v.string() }), sql.exec(
    `SELECT token_hash FROM ${table} WHERE workspace_name = ? LIMIT 1`, workspaceName,
  ).toArray()[0]);

  return row.success ? row.output.token_hash : null;
}

export function pendingCapabilityReconcile(sql: SqlExec, workspaceName: string): string | null {
  return registeredTokenHash(sql, 'workspace_capability_reconcile', workspaceName);
}

/** `attempts` rises on every retry so a stuck replica shows as a growing count. */
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

export function clearCapabilityReconcile(sql: SqlExec, workspaceName: string): void {
  sql.exec(`DELETE FROM workspace_capability_reconcile WHERE workspace_name = ?`, workspaceName);
}

/** Null when never issued. Any mismatch with the workspace's reported hash is repaired by re-minting. */
export function workspaceCapabilityHash(sql: SqlExec, workspaceName: string): string | null {
  return registeredTokenHash(sql, 'workspace_capability_tokens', workspaceName);
}

/** A fresh secret and hash, written nowhere: a DO interleaves across awaits, so the caller re-checks admission and
 *  writes in one synchronous turn via {@link commitWorkspaceCapability}. */
export async function freshWorkspaceCapability(): Promise<{ token: string; tokenHash: string }> {
  const token = `pwc_${nanoid(44)}`;

  return { token, tokenHash: await sha256Hex(token) };
}

/** Registers a freshly minted hash. Must stay synchronous: admission check and write form one turn,
 *  so a revoked workspace cannot be re-minted by an in-flight reconcile. */
export function commitWorkspaceCapability(sql: SqlExec, workspaceName: string, tokenHash: string): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_capability_tokens (workspace_name, token_hash, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
    workspaceName, tokenHash, now,
  );
}

/** Called on workspace deletion so a same-name recreate gets a fresh secret. */
export function revokeWorkspaceCapability(sql: SqlExec, workspaceName: string): void {
  sql.exec(`DELETE FROM workspace_capability_tokens WHERE workspace_name = ?`, workspaceName);
}

/** Fails closed: unknown shape, unknown token, or a token with no registry row is denied. */
const UserCallerSchema = v.union([
  v.object({ ownerToken: v.string() }),
  v.object({ workspaceToken: v.string() }),
]);

async function resolveCaller(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  presented: { caller: unknown },
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  const parsedCaller = v.safeParse(UserCallerSchema, presented.caller);

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

/** Called first in every privileged UserDO method; returns the principal for further scoping. */
export async function requireTier(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  presented: { caller: unknown },
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  const resolved = await resolveCaller(sql, env, presented, capability);

  if (resolved.kind === 'owner_session') return resolved;

  if (WORKSPACE_CAPABILITY_TIERS[capability] === 'owner_only') {
    denyCapability('owner_only', capability,
      `"${capability}" is an account authority and is reachable only by the signed-in owner. `
      + `Workspace "${resolved.workspace}" presented a workspace capability token, which never carries `
      + 'owner authority.');
  }

  return resolved;
}

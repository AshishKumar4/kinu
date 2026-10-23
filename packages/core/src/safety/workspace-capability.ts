/**
 * Workspace capability tokens: the UserDO's caller boundary. A Durable Object cannot learn which stub-holder
 * calls it, so both caller kinds are secrets; the owner capability does not defend against other DOs in this Worker.
 */

import { Data, Effect } from 'effect';
import * as v from 'valibot';
import { settle } from '../obs/effect';
import { diagnostics } from '../obs/log';
import type { SqlExec } from '../types/primitives';
import { hmacSha256Hex, timingSafeEqual } from '../utils/crypto';
import { nanoid } from '../utils/nanoid';
import { sha256Hex } from './argument-digest';

/** `workspace` admits the owner and any registered workspace token; `owner_only` admits no workspace
 *  (account authorities). Owner-only methods inside a workspace capability stay checked in the method. */
type CapabilityFloor = 'workspace' | 'owner_only';

/** The attenuation matrix; every privileged UserDO method names one entry. */
const WORKSPACE_CAPABILITY_TIERS = {
  /** Provider credentials for model inference and the model picker's view of them. */
  'credentials.model': 'workspace',
  /** The rest of the credential store (`github`, admin keys) and every write to it. */
  'credentials.other': 'workspace',
  /** The account's secrets: add, replace, delete, list, and grant them to workspaces. Owner-only: a workspace writing
   *  this would grant itself the owner's keys. */
  'secrets.manage': 'owner_only',
  /** Opening a secret for a request a workspace's egress intercepted. Owner-only: the egress holds the owner capability
   *  and names the workspace from its sealed props; the workspace itself never opens a placeholder. */
  'secrets.inject': 'owner_only',
  /** The calling workspace's own grants: names, hosts, placeholders, and the values its agents may read. */
  'secrets.read_self': 'workspace',
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
  /** Device registry and the daemon's challenge and ticket exchange. Owner-only: `registerDevice` registers a machine's key. */
  'device.manage': 'owner_only',
  /** The owner's workspace roster (leaks other workspace names). */
  'workspaces.read': 'workspace',
  /** Registry writes: create (the escape hatch out of confinement), delete, visit tracking. */
  'workspaces.write': 'workspace',
  /** Renaming the calling workspace only. */
  'workspaces.rename_self': 'workspace',
  /** The calling workspace's own tile only. */
  'workspaces.overview_self': 'workspace',
  /** Reading the owner's experience library published by other workspaces. */
  'experience.read': 'workspace',
  'experience.write': 'workspace',
  /** The owner's profile; notification and inbound email trust key on its verified email. */
  'profile': 'workspace',
  /** The account itself. Owner-only: resetting it could erase every sibling workspace. */
  'account': 'owner_only',
  /** The deployment's built-in accounts, passwords and passkeys. Owner-only: one write is any account's takeover. */
  'builtin_accounts': 'owner_only',
  'profile.resolve': 'workspace',
  'config': 'workspace',
  /** Verifying a CLI bearer, a CI access token or a socket ticket, and listing them: none is minted or ended here. */
  'auth_tokens': 'workspace',
  /** Minting a CLI bearer, a CI access token, a browser session or an agent-connect ticket. Owner-only: each carries the
   *  whole account's authority, so a workspace that could mint one would hold every sibling. */
  'auth_tokens.mint': 'owner_only',
  /** Revoking sessions and tokens, or raising the credential floor. Owner-only: a workspace could lock its owner out. */
  'auth_tokens.revoke': 'owner_only',
  /** Whether a bearer that authenticated a socket on this workspace may still act; names no token, mints nothing. */
  'auth_tokens.socket': 'workspace',
  /** Signing in to a subscription provider (ChatGPT, Claude). */
  'subscription_auth': 'workspace',
  /** Blueprints other accounts shared with this owner. Owner-only: forking is the owner's browser asking. */
  'shares': 'owner_only',
  /** The owner's Drive as the web UI manages it. Owner-only: workspaces already reach it via their `/shared` mount. */
  'drive': 'owner_only',
  /** The account's memory as every agent of it reads it, with the workspace's own. */
  'memory.account.read': 'workspace',
  /** Proposing an account fact or note, which waits for the owner; it writes nothing until accepted. */
  'memory.account.propose': 'workspace',
  /** Accepting, editing, promoting and forgetting the account's memory. Owner-only: an agent that could accept its own
   *  proposal would write what every workspace of the account reads. */
  'memory.account.manage': 'owner_only',
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
export function ownerCaller(env: OwnerCapabilityEnv): Promise<UserCaller> {
  return settle(Effect.map(ownerToken(env), (token) => ({ ownerToken: token })));
}

/** The deployment holds no root secret; browser and CLI planes map it to a deliberate answer, not a 500. */
export class OwnerCapabilityUnavailableError extends Data.TaggedError('OwnerCapabilityUnavailableError')<{ readonly message: string }> {
  constructor() {
    super({
      message: 'This deployment is not configured to serve signed-in users: CREDENTIAL_ENCRYPTION_KEY is not set. '
        + 'See docs/DEPLOYMENT.md.',
    });
  }
}

function ownerToken(env: OwnerCapabilityEnv): Effect.Effect<string> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();

  if (!secret) return Effect.die(new OwnerCapabilityUnavailableError());
  let pending = ownerTokens.get(secret);

  if (!pending) {
    pending = hmacSha256Hex(secret, OWNER_CAPABILITY_LABEL);
    ownerTokens.set(secret, pending);
  }

  const token = pending;

  return Effect.promise(() => token);
}

/** Thrown by `requireTier`; crosses the Worker→DO RPC boundary as its message. */
export class CapabilityDeniedError extends Data.TaggedError('CapabilityDeniedError')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

/** Closed denial reason for counting; the message names the workspace and is not a telemetry field. */
type CapabilityDenialReason =
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
): Effect.Effect<never> {
  return Effect.suspend(() => {
    diagnostics.event('capability.denied', {
      reason, capability, outcome: 'denied', source: 'workspace_capability',
    });

    return Effect.die(new CapabilityDeniedError(message));
  });
}

/** The account's registry row holds each workspace's `token_hash` (state/user-schema.ts); the raw token lives only in that
 *  workspace's DO. Null when never issued. Any mismatch with the workspace's reported hash is repaired by re-minting. */
export function workspaceCapabilityHash(sql: SqlExec, workspaceName: string): string | null {
  const row = v.safeParse(v.object({ token_hash: v.string() }), sql.exec(
    `SELECT token_hash FROM user_workspaces WHERE name = ? LIMIT 1`, workspaceName,
  ).toArray()[0]);

  return row.success ? row.output.token_hash : null;
}

/** A fresh secret and hash, written nowhere: a DO interleaves across awaits, so the caller re-checks admission and
 *  writes in one synchronous turn via {@link commitWorkspaceCapability}. */
export async function freshWorkspaceCapability(): Promise<{ token: string; tokenHash: string }> {
  const token = `pwc_${nanoid(44)}`;

  return { token, tokenHash: await sha256Hex(token) };
}

/** Registers a freshly minted hash on the workspace's registry row, a reserved one included, never one being torn down.
 *  Must stay synchronous: admission check and write form one turn, so a revoked workspace cannot be re-minted by an
 *  in-flight reconcile. False when no such row holds it, and the token must not be installed. */
export function commitWorkspaceCapability(sql: SqlExec, workspaceName: string, tokenHash: string): boolean {
  return sql.exec(
    `UPDATE user_workspaces SET token_hash = ? WHERE name = ? AND delete_pending = 0 RETURNING name`, tokenHash, workspaceName,
  ).toArray().length === 1;
}

/** Called as a teardown starts, before the workspace is destroyed, so a same-name recreate gets a fresh secret. */
export function revokeWorkspaceCapability(sql: SqlExec, workspaceName: string): void {
  sql.exec(`UPDATE user_workspaces SET token_hash = NULL WHERE name = ? AND token_hash IS NOT NULL`, workspaceName);
}

/** Fails closed: unknown shape, unknown token, or a token with no registry row is denied. */
const UserCallerSchema = v.union([
  v.object({ ownerToken: v.string() }),
  v.object({ workspaceToken: v.string() }),
]);

function resolveCaller(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  presented: { caller: unknown },
  capability: WorkspaceCapability,
): Effect.Effect<ResolvedCaller> {
  return Effect.gen(function* () {
    const parsedCaller = v.safeParse(UserCallerSchema, presented.caller);

    if (!parsedCaller.success) {
      return yield* denyCapability('no_caller_identity', capability,
        'This call carried no valid caller identity. Privileged user-level calls must present a capability token.');
    }

    if ('ownerToken' in parsedCaller.output) {
      const presentedOwner = parsedCaller.output.ownerToken;

      if (timingSafeEqual(presentedOwner, yield* ownerToken(env))) return { kind: 'owner_session' };

      return yield* denyCapability('unrecognized_owner', capability, 'Unrecognized owner capability.');
    }

    const token = parsedCaller.output.workspaceToken;

    if (token === '') {
      return yield* denyCapability('no_workspace_identity', capability,
        'This call carried no workspace identity. Privileged user-level calls must present a workspace capability token.');
    }

    const tokenHash = sha256Hex(token);

    const row = v.safeParse(v.object({ workspace_name: v.string() }), sql.exec(
      `SELECT name AS workspace_name FROM user_workspaces WHERE token_hash = ? LIMIT 1`, tokenHash,
    ).toArray()[0]);

    const workspace = row.success ? row.output.workspace_name : null;

    if (!workspace) {
      return yield* denyCapability('unrecognized_workspace', capability, 'Unrecognized workspace capability token.');
    }

    return { kind: 'workspace', workspace };
  });
}

/** Called first in every privileged UserDO method; returns the principal for further scoping. */
export function requireTier(
  sql: SqlExec,
  env: OwnerCapabilityEnv,
  presented: { caller: unknown },
  capability: WorkspaceCapability,
): Promise<ResolvedCaller> {
  return settle(Effect.gen(function* () {
    const resolved = yield* resolveCaller(sql, env, presented, capability);

    if (resolved.kind === 'owner_session') return resolved;

    if (WORKSPACE_CAPABILITY_TIERS[capability] === 'owner_only') {
      return yield* denyCapability('owner_only', capability,
        `"${capability}" is an account authority and is reachable only by the signed-in owner. `
        + `Workspace "${resolved.workspace}" presented a workspace capability token, which never carries `
        + 'owner authority.');
    }

    return resolved;
  }));
}

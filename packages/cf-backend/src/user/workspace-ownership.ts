/**
 * Whether a user owns a workspace, and the stub for it if they do.
 * Kept separate from `workspace-access.ts` so ownership callers don't import creation deps.
 */
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import type { WorkspaceAdmission } from './workspaces';
import { ERROR_STATUS, ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import { classifyDoCall, isRetryableDoCall } from '@nimbus-sh/platform/oom-classify.js';
import { logDoCallRetry } from '../obs/do-call-retry';
import type { ObjectNamespace } from '@kinu.run/core';
import { Effect, Result } from 'effect';
import { carriesCauseCode, diagnostics, KinuError, settle, toKinuError } from '@kinu.run/core/obs';

export type WorkspaceRegistry = Pick<UserDO, 'workspaceAdmission' | 'ensureWorkspaceCapability'>;

/** The workspace a request names, as its account's registry admitted it in the request's session check. */
export interface AdmittedWorkspace {
  readonly name: string;
  readonly admission: WorkspaceAdmission | null;
}

/** The two refusals read here across DO RPC, told apart by a code in their cause, which RPC keeps. */
const OWNED_BY_ANOTHER_ACCOUNT = 'owned_by_another_account';

const NOT_IN_REGISTRY = 'not_in_registry';

export function ownedByAnotherAccount(message: string): KinuError {
  return new KinuError('denied', message, { cause: { code: OWNED_BY_ANOTHER_ACCOUNT, message } });
}

export function notInRegistry(message: string): KinuError {
  return new KinuError('missing', message, { cause: { code: NOT_IN_REGISTRY, message } });
}

export function isOwnedByAnotherAccount(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, OWNED_BY_ANOTHER_ACCOUNT);
}

/** Generic below because the resolved stub is handed back to the caller. */
export type WorkspaceOwnerClaim = Pick<OrchestratorAgent, 'claimOwner'>;

/** Structural so the control plane can pass its own narrower env, not the generated `Env`. */
export interface WorkspaceOwnershipEnv<Id, Agent extends WorkspaceOwnerClaim> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, WorkspaceRegistry>;
  OrchestratorAgent: ObjectNamespace<Id, Agent>;
}

interface OwnershipRefusal { readonly status: number; readonly error: string }

export type OwnedWorkspaceResult<Agent> = Result.Result<Agent, OwnershipRefusal>;

const refused = <Agent>(status: number, error: string): OwnedWorkspaceResult<Agent> => Result.fail({ status, error });

/** 404 when not in the caller's registry (probes must not create workspaces); 403 for a
 * cross-user collision; otherwise the failure's class: 503 for a dropped or refused platform call. `admitted`: what the
 * request's session check already read of the registry, which saves asking it again. */
export function claimOwnedWorkspace<Id, Agent extends WorkspaceOwnerClaim>(
  env: WorkspaceOwnershipEnv<Id, Agent>,
  userId: string,
  workspaceName: string,
  admitted?: AdmittedWorkspace,
): Promise<OwnedWorkspaceResult<Agent>> {
  return settle(Effect.gen(function* () {
    const userObject = env.UserDO.idFromName(userId);
    // Every call below is idempotent, so platform-dropped connections are retried.
    const owner = yield* Effect.promise(() => ownerCaller(env));

    // Order is the security property: the registry must admit the name before claimOwner, or a crafted name wakes an
    // arbitrary OrchestratorAgent. Read fresh for every request, never kept, so a removal holds at once everywhere.
    const admission = admitted?.name === workspaceName ? admitted.admission : yield* Effect.promise(() => idempotent('workspaceAdmission',
      () => env.UserDO.get(userObject), (stub) => stub.workspaceAdmission(owner, workspaceName), { onRetry: logDoCallRetry }));

    if (admission === null) {
      return refused<Agent>(404, `Workspace ${workspaceName} not in your registry. Create it via POST /api/user/workspaces first.`);
    }

    const workspaceObject = env.OrchestratorAgent.idFromName(workspaceName);

    const claimed = yield* Effect.result(Effect.tryPromise({
      try: () => idempotent('claimOwner', () => env.OrchestratorAgent.get(workspaceObject),
        (stub) => stub.claimOwner(userId), { onRetry: logDoCallRetry }),
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(claimed)) {
      const e = claimed.failure.cause;

      if (isOwnedByAnotherAccount({ cause: e })) return refused<Agent>(403, `Workspace ${workspaceName} belongs to another account.`);

      const transient = classifyDoCall(e);

      const failure = toKinuError({
        doing: 'claiming workspace ownership', cause: e, otherwise: isRetryableDoCall(transient) || transient === 'overloaded' ? 'unavailable' : 'io',
      });

      diagnostics.failure('workspace.claim_owner_failed', failure, { workspace: workspaceName, transient });

      return refused<Agent>(ERROR_STATUS[failure.code], `Could not reach workspace ${workspaceName}; try again.`);
    }

    // Both sides hold the same capability: the reconcile would answer at once, so it is not asked.
    if (claimed.success.capabilityHash !== null && claimed.success.capabilityHash === admission.capabilityHash) {
      return Result.succeed(env.OrchestratorAgent.get(workspaceObject));
    }

    // The UserDO serializes this reconcile; a mismatch is repaired by minting anew.
    const provisioned = yield* Effect.result(Effect.tryPromise({
      // Replay replaces the single current hash and installed token; the prior token is no longer live.
      try: () => idempotent('ensureWorkspaceCapability', () => env.UserDO.get(userObject),
        (stub) => stub.ensureWorkspaceCapability(workspaceName, claimed.success.capabilityHash), { onRetry: logDoCallRetry }),
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(provisioned)) {
      const e = provisioned.failure.cause;

      // Removed since the admission was read.
      if (carriesCauseCode({ cause: e }, NOT_IN_REGISTRY)) return refused<Agent>(404, `Workspace ${workspaceName} is not in your registry.`);

      const transient = classifyDoCall(e);

      const failure = toKinuError({
        doing: "provisioning the workspace's capability token", cause: e, otherwise: isRetryableDoCall(transient) || transient === 'overloaded' ? 'unavailable' : 'io',
      });

      diagnostics.failure('workspace.capability_provisioning_failed', failure, { workspace: workspaceName, transient });

      return refused<Agent>(ERROR_STATUS[failure.code], 'Could not issue this workspace\'s capability token; try again.');
    }

    return Result.succeed(env.OrchestratorAgent.get(workspaceObject));
  }));
}

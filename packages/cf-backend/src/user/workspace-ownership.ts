/**
 * Whether a user owns a workspace, and the stub for it if they do.
 * Kept separate from `workspace-access.ts` so ownership callers don't import creation deps.
 */
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { ERROR_STATUS, ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { classifyTransientDO, retryTransientDO } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';
import { Effect, Result } from 'effect';
import { carriesCauseCode, diagnostics, KinuError, settle, toKinuError } from '@kinu.run/core/obs';

export type WorkspaceRegistry = Pick<UserDO, 'hasWorkspace' | 'ensureWorkspaceCapability'>;

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

export interface OwnershipRefusal { readonly status: number; readonly error: string }

export type OwnedWorkspaceResult<Agent> = Result.Result<Agent, OwnershipRefusal>;

const refused = <Agent>(status: number, error: string): OwnedWorkspaceResult<Agent> => Result.fail({ status, error });

/** Per-isolate proofs of registry membership; a proof skips only the registry read, never
 * claimOwner. Evicted when `ensureWorkspaceCapability`'s re-check contradicts it. */
const membershipProven = new Set<string>();

/** Memory bound on the proof set; overflow drops all proofs. Unrelated to
 * MAX_RATE_LIMIT_PER_MIN despite the same number. */
const MEMBERSHIP_PROOF_LIMIT = 10_000;

function forgetWorkspaceMembership(userId: string, workspaceName: string): void {
  membershipProven.delete(`${userId}\u0000${workspaceName}`);
}

/** 404 when not in the caller's registry (probes must not create workspaces); 403 for a
 * cross-user collision; otherwise the failure's class: 503 for a dropped or refused platform call. */
export function claimOwnedWorkspace<Id, Agent extends WorkspaceOwnerClaim>(
  env: WorkspaceOwnershipEnv<Id, Agent>,
  userId: string,
  workspaceName: string,
): Promise<OwnedWorkspaceResult<Agent>> {
  return settle(Effect.gen(function* () {
    const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
    // Every call below is idempotent, so platform-dropped connections are retried.
    const owner = yield* Effect.promise(() => ownerCaller(env));
    // Order is the security property: hasWorkspace must answer before claimOwner for anyone
    // unproven, or a crafted name wakes an arbitrary OrchestratorAgent.
    const membershipKey = `${userId}\u0000${workspaceName}`;

    if (!membershipProven.has(membershipKey)) {
      const member = yield* Effect.promise(() => retryTransientDO('hasWorkspace', () => userDO.hasWorkspace(owner, workspaceName)));

      if (!member) {
        // A fresh removal answer outranks a concurrent request's proof.
        membershipProven.delete(membershipKey);

        return refused<Agent>(404, `Workspace ${workspaceName} not in your registry. Create it via POST /api/user/workspaces first.`);
      }

      if (membershipProven.size >= MEMBERSHIP_PROOF_LIMIT) membershipProven.clear();
      membershipProven.add(membershipKey);
    }

    const agent = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));

    const claimed = yield* Effect.result(Effect.tryPromise({
      try: () => retryTransientDO('claimOwner', () => agent.claimOwner(userId)),
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(claimed)) {
      const e = claimed.failure.cause;

      if (isOwnedByAnotherAccount({ cause: e })) return refused<Agent>(403, `Workspace ${workspaceName} belongs to another account.`);

      const transient = classifyTransientDO({ cause: e });

      const failure = toKinuError({
        doing: 'claiming workspace ownership', cause: e, otherwise: transient === null ? 'io' : 'unavailable',
      });

      diagnostics.failure('workspace.claim_owner_failed', failure, { workspace: workspaceName, transient: transient ?? 'none' });

      return refused<Agent>(ERROR_STATUS[failure.code], `Could not reach workspace ${workspaceName}; try again.`);
    }

    // The UserDO serializes this reconcile; it returns immediately once both sides agree.
    const provisioned = yield* Effect.result(Effect.tryPromise({
      try: () => retryTransientDO('ensureWorkspaceCapability',
        () => userDO.ensureWorkspaceCapability(workspaceName, claimed.success.capabilityHash)),
      catch: (cause) => ({ cause }),
    }));

    if (Result.isFailure(provisioned)) {
      const e = provisioned.failure.cause;

      // Registry contradiction refutes a cached proof; evict so deletion sticks without
      // cross-isolate invalidation.
      if (carriesCauseCode({ cause: e }, NOT_IN_REGISTRY)) {
        forgetWorkspaceMembership(userId, workspaceName);

        return refused<Agent>(404, `Workspace ${workspaceName} is not in your registry.`);
      }

      const transient = classifyTransientDO({ cause: e });

      const failure = toKinuError({
        doing: "provisioning the workspace's capability token", cause: e, otherwise: transient === null ? 'io' : 'unavailable',
      });

      diagnostics.failure('workspace.capability_provisioning_failed', failure, { workspace: workspaceName, transient: transient ?? 'none' });

      return refused<Agent>(ERROR_STATUS[failure.code], 'Could not issue this workspace\'s capability token; try again.');
    }

    return Result.succeed(agent);
  }));
}

/**
 * Whether a user owns a workspace, and the stub for it if they do.
 * Kept separate from `workspace-access.ts` so ownership callers don't import creation deps.
 */
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { classifyTransientDO, retryTransientDO } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

export type WorkspaceRegistry = Pick<UserDO, 'hasWorkspace' | 'ensureWorkspaceCapability'>;

/** Generic below because the resolved stub is handed back to the caller. */
export type WorkspaceOwnerClaim = Pick<OrchestratorAgent, 'claimOwner'>;

/** Structural so the control plane can pass its own narrower env, not the generated `Env`. */
export interface WorkspaceOwnershipEnv<Id, Agent extends WorkspaceOwnerClaim> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, WorkspaceRegistry>;
  OrchestratorAgent: ObjectNamespace<Id, Agent>;
}

export type OwnedWorkspaceResult<Agent> =
  | { ok: true; agent: Agent }
  | { ok: false; status: number; error: string };

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
 * cross-user collision; 503 for a dropped platform call; anything else is a surfaced 500. */
export async function claimOwnedWorkspace<Id, Agent extends WorkspaceOwnerClaim>(
  env: WorkspaceOwnershipEnv<Id, Agent>,
  userId: string,
  workspaceName: string,
): Promise<OwnedWorkspaceResult<Agent>> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  // Every call below is idempotent, so platform-dropped connections are retried.
  const owner = await ownerCaller(env);
  // Order is the security property: hasWorkspace must answer before claimOwner for anyone
  // unproven, or a crafted name wakes an arbitrary OrchestratorAgent.
  const membershipKey = `${userId}\u0000${workspaceName}`;

  if (!membershipProven.has(membershipKey)) {
    const member = await retryTransientDO('hasWorkspace',
      () => userDO.hasWorkspace(owner, workspaceName));

    if (!member) {
      // A fresh removal answer outranks a concurrent request's proof.
      membershipProven.delete(membershipKey);

      return {
        ok: false,
        status: 404,
        error: `Workspace ${workspaceName} not in your registry. Create it via POST /api/user/workspaces first.`,
      };
    }

    if (membershipProven.size >= MEMBERSHIP_PROOF_LIMIT) membershipProven.clear();
    membershipProven.add(membershipKey);
  }

  const agent = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));
  let claim: { owner: string; capabilityHash: string | null };

  try {
    claim = await retryTransientDO('claimOwner', () => agent.claimOwner(userId));
  } catch (e) {
    const message = renderThrownChain({ cause: e });

    if (/owned by a different user/i.test(message)) return { ok: false, status: 403, error: message };

    const transient = classifyTransientDO({ cause: e });

    diagnostics.failure('workspace.claim_owner_failed', toKinuError({
      doing: 'claiming workspace ownership',
      cause: e,
      otherwise: 'unavailable',
    }), { workspace: workspaceName, transient: transient ?? 'none' });

    return { ok: false, status: transient === null ? 500 : 503, error: message };
  }

  // The UserDO serializes this reconcile; it returns immediately once both sides agree.
  try {
    await retryTransientDO('ensureWorkspaceCapability',
      () => userDO.ensureWorkspaceCapability(workspaceName, claim.capabilityHash));
  } catch (e) {
    const message = renderThrownChain({ cause: e });

    // Registry contradiction refutes a cached proof; evict so deletion sticks without
    // cross-isolate invalidation.
    if (/not in your registry/i.test(message)) {
      forgetWorkspaceMembership(userId, workspaceName);

      return { ok: false, status: 404, error: message };
    }

    const transient = classifyTransientDO({ cause: e });
    diagnostics.failure('workspace.capability_provisioning_failed', toKinuError({
      doing: "provisioning the workspace's capability token",
      cause: e,
      otherwise: 'unavailable',
    }), { workspace: workspaceName, transient: transient ?? 'none' });

    return {
      ok: false,
      status: transient !== null ? 503 : 500,
      error: `Could not issue this workspace's capability token: ${message}`,
    };
  }

  return { ok: true, agent };
}

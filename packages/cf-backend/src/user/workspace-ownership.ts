/**
 * Whether a user owns a workspace, and the stub for it if they do.
 *
 * ONE IMPLEMENTATION, and its own module for a reason that is structural rather
 * than tidy. Four surfaces ask this question — the browser API gate in
 * `server.ts`, the CLI gate in `cli/routes.ts`, the MCP transport, and the admin
 * control plane's action dispatcher — and only one of them has any business
 * reaching workspace CREATION. Leaving the claim inside `workspace-access.ts`
 * would drag `ai`, the provider registry and the model menu into every caller
 * that only wanted to know who owns a name.
 *
 * THE ORDER IN `claimOwnedWorkspace` IS THE SECURITY PROPERTY. `hasWorkspace`
 * must answer before `claimOwner` for anyone unproven, or a crafted workspace
 * name wakes an arbitrary OrchestratorAgent. And `claimOwner` must run even for
 * a proven member, because a registry row is a claim about a name while the
 * workspace's own identity row is the claim about the object — a roster row
 * naming somebody else's workspace passes the first check and is refused by the
 * second.
 */
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { ownerCaller, type OwnerCapabilityEnv } from './workspace-capability';
import { classifyTransientDO, retryTransientDO } from '../lib/do-rpc';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/** The bindings an ownership question needs, stated structurally so the control
 *  plane can ask it with its own narrower env rather than the generated `Env`. */
export interface WorkspaceOwnershipEnv extends OwnerCapabilityEnv {
  UserDO: DurableObjectNamespace<UserDO>;
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

export type OwnedWorkspaceResult =
  | { ok: true; agent: DurableObjectStub<OrchestratorAgent> }
  | { ok: false; status: number; error: string };
/** Positive registry-membership answers this Worker isolate has proven, keyed
 *  `${userId}\u0000${workspaceName}`. A proof is earned only by a real
 *  `hasWorkspace` answer, and `claimOwner` still verifies the caller IS the
 *  stored owner afterwards — a proof only ever skips the registry READ, never
 *  the identity check, and exists only for a pair that passed both. Removal
 *  happens in the UserDO, which this isolate learns only when
 *  `ensureWorkspaceCapability`'s own registry re-check contradicts the proof;
 *  that eviction is what keeps a deleted workspace deleted.
 */
const membershipProven = new Set<string>();

/** Bound the proof set: a long-lived isolate otherwise accumulates one small
 *  entry per (user, workspace) it ever saw. Overflow drops every proof, so
 *  each caller simply re-reads its registry once — the uncached path. The
 *  value is a memory bound on this set only; it does not tune
 *  MAX_RATE_LIMIT_PER_MIN (core events ingress), which shares the number by
 *  coincidence. */
const MEMBERSHIP_PROOF_LIMIT = 10_000;

/** Discard a membership proof; the next request re-reads the registry. */
function forgetWorkspaceMembership(userId: string, workspaceName: string): void {
  membershipProven.delete(`${userId}\u0000${workspaceName}`);
}

/** Verify `userId` owns `workspaceName` (registry membership + claimOwner on
 *  the orchestrator's own identity). 404 when the workspace isn't in the
 *  caller's registry — creation must go through the explicit create APIs so
 *  probes cannot register workspaces; 403 only for a genuine cross-user collision;
 *  503 when the platform dropped the call, so a client knows to try again; and
 *  anything else is a surfaced 500 so boot/schema issues stay diagnosable. */
export async function claimOwnedWorkspace(
  env: WorkspaceOwnershipEnv,
  userId: string,
  workspaceName: string,
): Promise<OwnedWorkspaceResult> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  // These calls run on every authenticated request for this workspace, and
  // every one is idempotent — a membership read (skipped when this isolate
  // still holds a positive proof), a claim that converges on the same owner,
  // and a reconcile that returns immediately once the two sides agree. A
  // connection the platform dropped between the Worker and either object is
  // not a statement about the request.
  const owner = await ownerCaller(env);
  // The wake-guard half of the gate, and its order IS the security property:
  // hasWorkspace must answer before claimOwner for anyone unproven, or a
  // crafted workspace name would wake an arbitrary OrchestratorAgent. A
  // proven member skips straight to the claim.
  const membershipKey = `${userId}\u0000${workspaceName}`;
  if (!membershipProven.has(membershipKey)) {
    const member = await retryTransientDO('hasWorkspace',
      () => userDO.hasWorkspace(owner, workspaceName));
    if (!member) {
      // A concurrent request may have proven membership moments ago; a fresh
      // removal answer outranks it.
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
    const transient = classifyTransientDO({ cause: e });
    const status = /owned by a different user/i.test(message) ? 403 : transient !== null ? 503 : 500;
    if (status !== 403) {
      diagnostics.failure('workspace.claim_owner_failed', toKinuError({
        doing: 'claiming workspace ownership',
        cause: e,
        otherwise: 'unavailable',
      }), { workspace: workspaceName, transient: transient ?? 'none' });
    }
    return { ok: false, status, error: message };
  }
  // Reconcile the workspace's identity with the registry on every touch. The
  // UserDO owns the whole decision (and serializes concurrent ones) because it
  // is the only place that can see both sides; it returns immediately when they
  // already agree, which is every request after the first.
  try {
    await retryTransientDO('ensureWorkspaceCapability',
      () => userDO.ensureWorkspaceCapability(workspaceName, claim.capabilityHash));
  } catch (e) {
    const message = renderThrownChain({ cause: e });
    // The UserDO re-checks the registry on every reconcile; its contradiction
    // is the authoritative refutation of a cached proof — the workspace was
    // removed after this isolate proved membership. Evict and report 404 so
    // deletion sticks with no cross-isolate invalidation channel.
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

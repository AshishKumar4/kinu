// Worker-side helpers for operating on a user's workspaces. One
// implementation of workspace creation and ownership-claiming shared by the web routes
// (user/routes.ts, server.ts), the CLI control plane (cli/routes.ts), and
// the MCP surface — so status mapping and ownership semantics cannot drift.
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { createCloudWorkspaceForUser } from './workspace-create';
import { err, json, safeJson } from '../lib/http';
import { ownerCaller } from './workspace-capability';
import { classifyTransientDO, retryTransientDO } from '../lib/do-rpc';
import { diagnostics, toProteusError } from '@proteus/core/obs';
import * as v from 'valibot';

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export async function handleCreateWorkspaceRequest(
  request: Request,
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await safeJson(request, v.object({
    name: v.optional(v.string()),
    displayName: v.optional(v.string()),
    purpose: v.optional(v.string()),
  }));
  if (!body) return err(400, 'Body must be JSON');
  if (!body.name?.trim() && !body.purpose?.trim()) return err(400, 'purpose required');
  try {
    const entry = await createCloudWorkspaceForUser(env, userId, userDO, await ownerCaller(env), body, {
      waitUntil: (promise) => ctx?.waitUntil(promise),
    });
    return json(entry, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // workspace-create.ts throws plain Errors; this is the single home for the
    // provider-not-connected → 409 mapping.
    const status = message.startsWith('Cloudflare Workers AI is not connected') ? 409 : 400;
    return err(status, message);
  }
}

/** Fan a credential-change notification out to the user's active workspaces so
 *  each drops its cached provider/model state (onCredentialsChanged) —
 *  otherwise a disconnected provider stays "available" until the next
 *  claimOwner/setModel. Fire-and-forget; runs via waitUntil when available. */
export function notifyWorkspacesCredentialsChanged(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): void {
  const task = (async () => {
    const workspaces = await userDO.listWorkspaces(await ownerCaller(env));
    await Promise.allSettled(workspaces
      .filter((a) => a.archivedAt === null)
      .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onCredentialsChanged()));
  })().catch((e) => {
    diagnostics.failure('workspace.credential_fanout_failed', toProteusError({
      doing: 'notifying the user\'s workspaces of a credential change',
      cause: e,
      otherwise: 'unavailable',
    }));
  });
  ctx?.waitUntil(task);
}

export type OwnedWorkspaceResult =
  | { ok: true; agent: DurableObjectStub<OrchestratorAgent> }
  | { ok: false; status: number; error: string };

/** Verify `userId` owns `workspaceName` (registry membership + claimOwner on
 *  the orchestrator's own identity). 404 when the workspace isn't in the
 *  caller's registry — creation must go through the explicit create APIs so
 *  probes cannot register workspaces; 403 only for a genuine cross-user collision;
 *  503 when the platform dropped the call, so a client knows to try again; and
 *  anything else is a surfaced 500 so boot/schema issues stay diagnosable. */
export async function claimOwnedWorkspace(
  env: Env,
  userId: string,
  workspaceName: string,
): Promise<OwnedWorkspaceResult> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  // Every one of the three calls below runs on EVERY authenticated request for
  // this workspace, and every one is idempotent — a membership read, a claim
  // that converges on the same owner, and a reconcile that returns immediately
  // once the two sides agree. A connection the platform dropped between the
  // Worker and either object is not a statement about the request.
  const owner = await ownerCaller(env);
  const member = await retryTransientDO('hasWorkspace',
    () => userDO.hasWorkspace(owner, workspaceName));
  if (!member) {
    return {
      ok: false,
      status: 404,
      error: `Workspace ${workspaceName} not in your registry. Create it via POST /api/user/workspaces first.`,
    };
  }
  const agent = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));
  let claim: { owner: string; capabilityHash: string | null };
  try {
    claim = await retryTransientDO('claimOwner', () => agent.claimOwner(userId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const transient = classifyTransientDO({ cause: e });
    const status = /owned by a different user/i.test(message) ? 403 : transient !== null ? 503 : 500;
    if (status !== 403) {
      diagnostics.failure('workspace.claim_owner_failed', toProteusError({
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
    const message = e instanceof Error ? e.message : String(e);
    const transient = classifyTransientDO({ cause: e });
    diagnostics.failure('workspace.capability_provisioning_failed', toProteusError({
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

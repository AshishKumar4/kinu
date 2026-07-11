// Worker-side helpers for operating on a user's workspaces. One
// implementation of workspace creation and ownership-claiming shared by the web routes
// (user/routes.ts, server.ts), the CLI control plane (cli/routes.ts), and
// the MCP surface — so status mapping and ownership semantics cannot drift.
import type { OrchestratorAgent } from '../orchestrator.js';
import type { UserDO } from './user-do.js';
import { createCloudWorkspaceForUser } from './workspace-create.js';
import { err, json, safeJson } from '../lib/http.js';

/** POST /workspaces body → created WorkspaceEntry (201) | mapped error response. */
export async function handleCreateWorkspaceRequest(
  request: Request,
  env: Env,
  userId: string,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await safeJson<{ name?: string; displayName?: string; purpose?: string }>(request);
  if (!body) return err(400, 'Body must be JSON');
  if (!body.name?.trim() && !body.purpose?.trim()) return err(400, 'purpose required');
  try {
    const entry = await createCloudWorkspaceForUser(env, userId, userDO, body, {
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
    const workspaces = await userDO.listWorkspaces();
    await Promise.allSettled(workspaces
      .filter((a) => a.archivedAt === null)
      .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onCredentialsChanged()));
  })().catch((e: unknown) => {
    console.warn('[workspace-access] credential-change fanout failed:', e instanceof Error ? e.message : e);
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
 *  anything else is a surfaced 500 so boot/schema issues stay diagnosable. */
export async function claimOwnedWorkspace(
  env: Env,
  userId: string,
  workspaceName: string,
): Promise<OwnedWorkspaceResult> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  if (!(await userDO.hasWorkspace(workspaceName))) {
    return {
      ok: false,
      status: 404,
      error: `Workspace ${workspaceName} not in your registry. Create it via POST /api/user/workspaces first.`,
    };
  }
  const agent = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));
  try {
    await agent.claimOwner(userId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /owned by a different user/i.test(message) ? 403 : 500;
    if (status === 500) console.error(`[workspace-access] claimOwner(${workspaceName}) failed:`, message);
    return { ok: false, status, error: message };
  }
  return { ok: true, agent };
}

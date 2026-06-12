// Worker-side helpers for operating on a user's agents. One implementation
// of agent creation and ownership-claiming shared by the web routes
// (user/routes.ts, server.ts), the CLI control plane (cli/routes.ts), and
// the MCP surface — so status mapping and ownership semantics cannot drift.
import type { OrchestratorAgent } from '../orchestrator.js';
import type { UserDO } from './user-do.js';
import { createCloudAgentForUser } from './agent-create.js';
import { err, json, safeJson } from '../lib/http.js';

/** POST /agents body → created AgentEntry (201) | mapped error response. */
export async function handleCreateAgentRequest(
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
    const entry = await createCloudAgentForUser(env, userId, userDO, body, {
      waitUntil: (promise) => ctx?.waitUntil(promise),
    });
    return json(entry, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // agent-create.ts throws plain Errors; this is the single home for the
    // provider-not-connected → 409 mapping.
    const status = message.startsWith('Cloudflare Workers AI is not connected') ? 409 : 400;
    return err(status, message);
  }
}

/** Fan a credential-change notification out to the user's active agents so
 *  each drops its cached provider/model state (onCredentialsChanged) —
 *  otherwise a disconnected provider stays "available" until the next
 *  claimOwner/setModel. Fire-and-forget; runs via waitUntil when available. */
export function notifyAgentsCredentialsChanged(
  env: Env,
  userDO: DurableObjectStub<UserDO>,
  ctx?: ExecutionContext,
): void {
  const task = (async () => {
    const agents = await userDO.listAgents();
    await Promise.allSettled(agents
      .filter((a) => a.archivedAt === null)
      .map((a) => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(a.name)).onCredentialsChanged()));
  })().catch((e: unknown) => {
    console.warn('[agent-access] credential-change fanout failed:', e instanceof Error ? e.message : e);
  });
  ctx?.waitUntil(task);
}

export type OwnedAgentResult =
  | { ok: true; agent: DurableObjectStub<OrchestratorAgent> }
  | { ok: false; status: number; error: string };

/** Verify `userId` owns `agentName` (registry membership + claimOwner on the
 *  orchestrator's own identity). 404 when the agent isn't in the caller's
 *  registry — creation must go through the explicit create APIs so probes
 *  cannot register agents; 403 only for a genuine cross-user collision;
 *  anything else is a surfaced 500 so boot/schema issues stay diagnosable. */
export async function claimOwnedAgent(
  env: Env,
  userId: string,
  agentName: string,
): Promise<OwnedAgentResult> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  if (!(await userDO.hasAgent(agentName))) {
    return {
      ok: false,
      status: 404,
      error: `Agent ${agentName} not in your registry. Create it via POST /api/user/agents first.`,
    };
  }
  const agent = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(agentName));
  try {
    await agent.claimOwner(userId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /owned by a different user/i.test(message) ? 403 : 500;
    if (status === 500) console.error(`[agent-access] claimOwner(${agentName}) failed:`, message);
    return { ok: false, status, error: message };
  }
  return { ok: true, agent };
}

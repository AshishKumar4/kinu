/**
 * Mission Inbox — the Worker `email()` entry point. Cloudflare Email Routing
 * (catch-all rule → this Worker) delivers each inbound message here; the
 * routing seam (route.ts) resolves the receiving agent from the recipient
 * address and hands the parsed delivery to the agent DO, where the trust
 * gate + publish run atomically (`acceptEmailDelivery`).
 */

import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import { routeInboundEmail } from './route';
import { diagnostics } from '@proteus/core/obs';

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const result = await routeInboundEmail(
    message,
    env.EMAIL_DOMAIN,
    async (name) => await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name),
  );
  if (result.outcome === 'dropped') {
    diagnostics.event('email.delivery_dropped', {
      from: message.from,
      reason: result.reason ?? 'unknown',
    });
  }
}

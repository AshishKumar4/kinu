/**
 * Worker `email()` entry: Cloudflare Email Routing (catch-all → this Worker) delivers here; the agent DO
 * runs trust gate + publish atomically (`acceptEmailDelivery`).
 */

import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import { routeInboundEmail } from './route';
import { diagnostics } from '@kinu.run/core/obs';

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

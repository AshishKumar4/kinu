/**
 * Worker `email()` entry: Email Routing's catch-all on EMAIL_DOMAIN delivers here, and `routeInboundMail` files each
 * message in its account's Mailbox. This binds the router to the objects, and hands a woken arrival to its workspace.
 */
import { getAgentByName } from 'agents';
import { Effect } from 'effect';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import type { OrchestratorAgent } from '../orchestrator';
import { routeInboundMail } from './router';

export async function handleInboundMail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  return settle(attempt({ doing: 'routing an inbound email', otherwise: 'io' }, async () => await routeInboundMail(message, {
    domain: env.EMAIL_DOMAIN,
    name: (label) => env.MAILNAME.get(env.MAILNAME.idFromName(label)),
    mailbox: (userId) => env.MAILBOX.get(env.MAILBOX.idFromName(userId)),
    wake: async (arrival) => {
      const workspace = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, arrival.wake.workspace);

      await workspace.mailArrived({
        woke: arrival.woke ?? 'input', from: arrival.from.address, to: message.to, subject: arrival.subject, instruction: arrival.instruction,
        message_id: arrival.headerId === null ? null : `<${arrival.headerId}>`, references: arrival.references,
        attachments: [...arrival.attachments], mail: { box: arrival.box, thread: arrival.threadId, message: arrival.messageId }, now: Date.now(),
      }, arrival.wake.actorId);
    },
  })).pipe(
    Effect.tapError((failure) => Effect.sync(() => { diagnostics.failure('email.delivery_failed', failure); })),
    Effect.map((routed) => {
      if (routed.outcome === 'refused') diagnostics.event('email.delivery_refused', { reason: routed.reason });
    }),
  ));
}

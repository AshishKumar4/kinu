import { Effect } from 'effect';
import { DeliveryInbox, handBackCarried, type AgentOrchestratorDeps, type BackendHost, type Delivery, type DeliveryAnswer, type EventLog } from '@kinu.run/core';
import { attemptInItsWords, renderThrownChain, settle } from '@kinu.run/core/obs';

/**
 * An agent's deliveries for a fixture whose chat is its host: each delivery is handed to `host.enqueueTurn` as the chat's
 * `admitDelivery` queues it (a programmatic turn under the delivery's id), with nothing owed in between. Words and runs
 * are a chat's and its host's, which a fixture over a bare host does not have. An enqueue that fails is the agent's
 * refusal, as an isolate answers its own admission's failure. Given the agent's `eventLog`, what a delivery the host
 * refused or yielded carried is handed back as production hands it back (core `handBackCarried`).
 */
export function hostDeliveries(host: Pick<BackendHost, 'enqueueTurn' | 'broadcast'>, eventLog?: EventLog): AgentOrchestratorDeps['deliveries'] {
  const deliver = async (delivery: Delivery): Promise<DeliveryAnswer> => {
    const { input } = delivery;

    if (input.kind !== 'turn') return { refused: { code: 'unsupported', message: `a fixture's host takes no ${input.kind} delivery` } };

    const enqueued = attemptInItsWords('unavailable', () => host.enqueueTurn({
      text: input.text, idempotencyKey: delivery.id, authorship: delivery.authorship,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
    }));

    return await settle(enqueued.pipe(
      Effect.map((queued): DeliveryAnswer => {
        if (queued.status === 'yielded') return 'yielded';

        return queued.status === 'failed' || queued.status === 'skipped' ? { refused: { code: 'unavailable', message: queued.reason ?? queued.status } } : 'taken';
      }),
      Effect.catch((refusal) => Effect.succeed<DeliveryAnswer>({ refused: { code: refusal.code, message: renderThrownChain({ cause: refusal }) } })),
    ));
  };

  return {
    signals: new DeliveryInbox({ deliver, broadcast: (event) => { host.broadcast(event); } }),
    commit: async (bind) => {
      const delivery = bind();

      if (delivery === null) return;
      const answer = await deliver(delivery);

      if (eventLog !== undefined && answer !== 'taken' && answer !== 'duplicate') handBackCarried(eventLog, delivery, answer);
    },
  };
}

/** A fixture's orchestration deps with {@link hostDeliveries} over their own host. */
export function withHostDeliveries(deps: Omit<AgentOrchestratorDeps, 'deliveries'>): AgentOrchestratorDeps {
  return { ...deps, deliveries: hostDeliveries(deps.host, deps.eventLog) };
}

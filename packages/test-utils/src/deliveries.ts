import { DeliveryInbox, type AgentOrchestratorDeps, type BackendHost, type Delivery, type DeliveryAnswer } from '@kinu.run/core';

/**
 * An agent's deliveries for a fixture whose chat is its host: each delivery is handed to `host.enqueueTurn` as the chat's
 * `admitDelivery` queues it (a programmatic turn under the delivery's id), with nothing owed in between. Words and runs
 * are a chat's and its host's, which a fixture over a bare host does not have.
 */
export function hostDeliveries(host: Pick<BackendHost, 'enqueueTurn' | 'broadcast'>): AgentOrchestratorDeps['deliveries'] {
  const deliver = async (delivery: Delivery): Promise<DeliveryAnswer> => {
    const { input } = delivery;

    if (input.kind !== 'turn') return { refused: { code: 'unsupported', message: `a fixture's host takes no ${input.kind} delivery` } };

    const queued = await host.enqueueTurn({
      text: input.text, idempotencyKey: delivery.id, authorship: delivery.authorship,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
    });

    if (queued.status === 'yielded') return 'yielded';

    return queued.status === 'failed' || queued.status === 'skipped' ? { refused: { code: 'unavailable', message: queued.reason ?? queued.status } } : 'taken';
  };

  return {
    signals: new DeliveryInbox({ deliver, broadcast: (event) => { host.broadcast(event); } }),
    commit: async (bind) => {
      const delivery = bind();

      if (delivery !== null) await deliver(delivery);
    },
  };
}

/** A fixture's orchestration deps with {@link hostDeliveries} over their own host. */
export function withHostDeliveries(deps: Omit<AgentOrchestratorDeps, 'deliveries'>): AgentOrchestratorDeps {
  return { ...deps, deliveries: hostDeliveries(deps.host) };
}

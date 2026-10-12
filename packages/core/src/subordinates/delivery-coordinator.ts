/**
 * One path for every producer's deliveries to its agents, on every host (design v2 §1, v3 A): what each producer commits,
 * crossed to the agent in the order producers committed them, answered, refused or cancelled.
 */
import { Cause, Exit } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';
import { attemptInItsWords, CODE_IS_REFUSAL, diagnostics, hold, KinuError, toKinuError } from '../obs/index';
import type { EventLog } from '../events/hub/log';
import type { BroadcastEvent } from '../types/backend-host';
import type { SqlExecutor } from '../types/primitives';
import type { AgentInbox } from '../types/signals';
import {
  AgentDeliveries, DeliveryInbox, handBackCarried,
  type Delivery, type DeliveryAnswer, type DeliveryPort, type OwedAdmission, type OwedDelivery,
} from './deliveries';

/** Where a delivery stands once its producer is done with it: answered by the agent, or owed still (`failure`). */
export type CrossedDelivery = { readonly admitted: Exclude<DeliveryAnswer, { readonly refused: unknown }> } | { readonly failure: KinuError };

/** What a Stop cancelled of an agent's deliveries, and the newest of their sequences, which nothing at or below crosses. */
export interface StopCutoff {
  readonly cancelled: readonly OwedDelivery[];
  readonly cutoff: number | null;
}

/** What a {@link DeliveryCoordinator} asks of the host it runs in. */
export interface DeliveryHost {
  readonly sql: SqlExecutor;
  readonly transaction: <A>(body: () => A) => A;
  /** The agent's wake, armed from its owed rows after their commit: an owed row is the durable intent, its alarm the
   *  projection, so a host that dies between the two finds the row at its next start and arms the wake then. */
  readonly armWake: (actorId: string) => Promise<void>;
  /** One crossing into the agent's own store. */
  readonly admit: (actorId: string, delivery: OwedDelivery) => Promise<DeliveryAnswer>;
  readonly eventLog: (actorId: string) => EventLog;
  /** Whether the agent can still take input; a retired one is owed nothing. */
  readonly live: (actorId: string) => boolean;
  /** A refused delivery's sender is told; true when it was (an assignment's hirer hears its agent could not run it),
   *  false for one whose carried events wait for the drain something else starts. */
  readonly refused?: (actorId: string, delivery: Delivery, failure: KinuError) => Promise<boolean>;
}

/**
 * Every producer's deliveries to its agents, one path for every host (design v2 §1, v3 A): committed with the producer's
 * own fact, then crossed in the order producers committed them. A crossing joins the agent's one lane, which crosses the
 * oldest owed delivery first and stops at one that does not reach the agent, so nothing committed later overtakes it.
 * The agent's answer retires a row; a refusal is an answer, retired and told; a Stop cancels what is owed at its cutoff.
 */
export class DeliveryCoordinator {
  private readonly lanes = new Map<string, ReturnType<typeof serialQueue>>();
  /** The answers producers wait on, by delivery id: set by the lane pass that crossed it. */
  private readonly awaited = new Map<string, CrossedDelivery | null>();

  constructor(private readonly host: DeliveryHost) {}

  private get rows(): AgentDeliveries {
    return new AgentDeliveries(this.host.sql);
  }

  /** In the producer's commit: `source` and the delivery as one. False when the delivery was owed already. */
  commit(actorId: string, delivery: Delivery, source?: () => void): boolean {
    return this.host.transaction(() => {
      source?.();

      return this.rows.add(actorId, delivery);
    });
  }

  /** What `admit` writes and the delivery it owes the agent, as one commit; the agent's next {@link drain} crosses it. */
  record<A>(actorId: string, admit: () => OwedAdmission<A>): A {
    return this.recorded(actorId, admit).value;
  }

  private recorded<A>(actorId: string, admit: () => OwedAdmission<A>): OwedAdmission<A> {
    return this.host.transaction(() => {
      const admitted = admit();

      if (admitted.delivery !== null) this.rows.add(actorId, admitted.delivery);

      return admitted;
    });
  }

  /** Committed, its wake armed, then crossed behind everything owed before it. Answers where it stands. */
  async deliver(actorId: string, delivery: Delivery, source?: () => void): Promise<CrossedDelivery> {
    this.commit(actorId, delivery, source);

    return await this.crossed(actorId, delivery.id);
  }

  /** As {@link deliver}, for a delivery whose id names one intent: one already owed under that id has its own caller, who
   *  hears its answer, so this one crosses nothing and is answered null. */
  async deliverNew(actorId: string, delivery: Delivery): Promise<CrossedDelivery | null> {
    if (!this.commit(actorId, delivery)) return null;

    return await this.crossed(actorId, delivery.id);
  }

  /** As {@link record}, then crossed as {@link deliver} crosses. */
  async owe<A>(actorId: string, admit: () => OwedAdmission<A>): Promise<A> {
    const { value, delivery } = this.recorded(actorId, admit);

    if (delivery !== null) await this.crossed(actorId, delivery.id);

    return value;
  }

  /** Its wake armed at once, and the agent's lane drained: neither waits behind the other. */
  private async crossed(actorId: string, id: string): Promise<CrossedDelivery> {
    this.awaited.set(id, null);
    await Promise.all([this.host.armWake(actorId), this.drain(actorId)]);
    const answer = this.awaited.get(id) ?? null;

    this.awaited.delete(id);

    return answer ?? { failure: new KinuError('unavailable', 'The agent did not take it yet; it is owed to its next wake.') };
  }

  /** Everything the agent is owed, oldest first, up to a crossing that does not reach it. */
  async drain(actorId: string): Promise<readonly OwedDelivery[]> {
    const lane = this.lanes.get(actorId) ?? serialQueue();

    this.lanes.set(actorId, lane);

    return await lane(async () => {
      const taken: OwedDelivery[] = [];

      for (const delivery of this.rows.unpaid(actorId)) {
        const crossed = await this.cross(actorId, delivery);

        if (this.awaited.has(delivery.id)) this.awaited.set(delivery.id, crossed);

        if ('admitted' in crossed) {
          if (crossed.admitted === 'taken') taken.push(delivery);
        } else if (this.rows.unpaid(actorId).some((owed) => owed.id === delivery.id)) break;
      }

      return taken;
    });
  }

  /** A Stop's or a retirement's cutoff, inside the caller's commit: what the agent is owed is cancelled, and the newest
   *  cancelled sequence is the cutoff its isolate refuses anything at or below. What the rows carried is the caller's. */
  cancel(actorId: string): StopCutoff {
    const cancelled = this.rows.cancel(actorId);

    return { cancelled, cutoff: cancelled.reduce<number | null>((newest, delivery) => Math.max(newest ?? 0, delivery.seq), null) };
  }

  private async cross(actorId: string, delivery: OwedDelivery): Promise<CrossedDelivery> {
    if (!this.host.live(actorId)) {
      this.host.transaction(() => this.cancel(actorId));

      return { failure: new KinuError('missing', `${actorId} was retired; what it was owed is cancelled.`) };
    }

    // In the agent's own words: its refusal reaches the sender as it said it.
    const crossed = await hold(attemptInItsWords('unavailable', () => this.host.admit(actorId, delivery)));

    if (Exit.isFailure(crossed)) {
      const failure = toKinuError({ doing: 'handing the agent what it is owed', cause: Cause.squash(crossed.cause), otherwise: 'unavailable' });

      // Refused where it would be on every crossing: an answer, as the agent's own.
      if (CODE_IS_REFUSAL[failure.code]) return await this.refused(actorId, delivery, failure);
      diagnostics.failure('agent.delivery_crossing_failed', failure, { actorId, deliveryId: delivery.id });

      return { failure };
    }

    const answer = crossed.value;

    if (typeof answer === 'object' && 'refused' in answer) return await this.refused(actorId, delivery, new KinuError(answer.refused.code, answer.refused.message));
    this.rows.paid(actorId, delivery.id);

    if (answer === 'yielded' || answer === 'cancelled') handBackCarried(this.host.eventLog(actorId), delivery, answer);

    return { admitted: answer };
  }

  private async refused(actorId: string, delivery: Delivery, failure: KinuError): Promise<CrossedDelivery> {
    this.rows.paid(actorId, delivery.id);
    diagnostics.failure('agent.delivery_refused', failure, { actorId, deliveryId: delivery.id });

    if (await this.host.refused?.(actorId, delivery, failure) !== true) {
      handBackCarried(this.host.eventLog(actorId), delivery, { refused: { code: failure.code, message: failure.message } });
    }

    return { failure };
  }

  /** One agent's deliveries, as the port its orchestrator sends signals and commits through. */
  port(actorId: string, broadcast: (event: BroadcastEvent) => void): DeliveryPort {
    return {
      signals: new DeliveryInbox({
        deliver: async (delivery) => {
          const crossed = await this.deliver(actorId, delivery);

          return 'admitted' in crossed ? crossed.admitted : null;
        },
        broadcast,
      }),
      commit: async (bind) => { await this.owe(actorId, () => ({ value: undefined, delivery: bind() })); },
    };
  }
}

/**
 * An agent's deliveries where its chat runs in this process (the CLI): the coordinator's path, for one agent, whose
 * wake is the process itself. One a death left unpaid crosses again at the agent's next {@link crossOwed}.
 */
export class InProcessDeliveries implements DeliveryPort {
  readonly signals: AgentInbox;
  readonly commit: DeliveryPort['commit'];
  private readonly coordinator: DeliveryCoordinator;
  private readonly taken: string[] = [];

  constructor(private readonly deps: {
    readonly actorId: string;
    readonly sql: SqlExecutor;
    readonly transaction: <A>(body: () => A) => A;
    readonly eventLog: EventLog;
    readonly admit: (delivery: OwedDelivery) => Promise<DeliveryAnswer>;
    readonly broadcast: (event: BroadcastEvent) => void;
  }) {
    this.coordinator = new DeliveryCoordinator({
      sql: deps.sql, transaction: deps.transaction, armWake: async () => {},
      admit: async (_actorId, delivery) => {
        const answer = await deps.admit(delivery);

        if (answer === 'taken') this.taken.push(delivery.id);

        return answer;
      },
      eventLog: () => deps.eventLog, live: () => true,
    });
    const port = this.coordinator.port(deps.actorId, deps.broadcast);

    this.signals = port.signals;
    this.commit = port.commit;
  }

  /** The deliveries taken since it was last asked, by id: a pass that handed them over runs their turns before it ends,
   *  outside the crossing (a crossing made from a turn's own close never waits on the turn queued behind it). */
  takenSince(): readonly string[] {
    return this.taken.splice(0);
  }

  /** What `admit` writes and the delivery it owes the agent, as one commit; then the agent's lane drained. */
  async owe<A>(admit: () => OwedAdmission<A>): Promise<A> {
    return await this.coordinator.owe(this.deps.actorId, admit);
  }

  /** What `admit` writes and the delivery it owes the agent, as one commit; the agent's next {@link crossOwed} crosses it. */
  record<A>(admit: () => OwedAdmission<A>): A {
    return this.coordinator.record(this.deps.actorId, admit);
  }

  /** A Stop's cutoff (design v3 C): what the agent was owed and had not taken is cancelled, and the work it carried
   *  parked; answers the newest cancelled sequence, at or below which its chat takes nothing after. */
  cancel(): number | null {
    const { cancelled, cutoff } = this.deps.transaction(() => this.coordinator.cancel(this.deps.actorId));

    for (const delivery of cancelled) handBackCarried(this.deps.eventLog, delivery, 'cancelled');

    return cutoff;
  }

  /** What the agent was owed and a death kept from it, in commit order, up to a crossing that fails; answers what its chat
   *  took in this sweep. */
  async crossOwed(): Promise<readonly Delivery[]> {
    return await this.coordinator.drain(this.deps.actorId);
  }
}

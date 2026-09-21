/**
 * The vendor half of eviction durability, executed for real: a durable fiber
 * carried across an activation the object never chose to end, and recovered
 * with NO CLIENT.
 *
 * WHY THIS FILE HAS TO EXIST. `ActorAgent`'s recovery is a decision per lane
 * over `FiberRecoveryContext`, and the bun suite runs those decisions for real.
 * What bun cannot host is the two platform facts the decisions stand on: that a
 * `cf_agents_runs` row survives an isolate reset while the promise behind it does
 * not, and that with nothing connected the persisted keepAlive alarm fires on its
 * own and drives the interrupted-fiber scan. Neither exists outside workerd — the
 * bun stand-in reproduces the SQL by hand precisely because there is no alarm and
 * no reset there — so a green bun suite says nothing about whether recovery ever
 * STARTS in production.
 *
 * The probe extends Agent, the same platform lifecycle ActorAgent uses.
 * Chat recovery belongs to Kinu's ChatSession and is exercised through the
 * production orchestrator by the two-turn probe.
 *
 * THE OBSERVATION IS OUTSIDE THE PROBE, and that is the whole design. Reading
 * anything off this object is a REQUEST, and a request runs `onStart`, which runs
 * the recovery scan eagerly — so a test that concluded "recovery happened" from
 * reading the probe would have caused the thing it measured. Every recovery here
 * reports to a second Durable Object instead, and the test polls only that one.
 * Until the witness answers, nothing has touched the probe since the reset.
 */
import { DurableObject } from 'cloudflare:workers';
import { Agent } from 'agents';

/**
 * Where the probe reports work it completed with nobody watching.
 *
 * A separate object, so the test can ask "did the recovery run" without issuing
 * the request that would make it run.
 */
export class WitnessDO extends DurableObject<Cloudflare.Env> {
  async record(note: string): Promise<void> {
    const seen = (await this.ctx.storage.get<string[]>('seen')) ?? [];
    seen.push(note);
    await this.ctx.storage.put('seen', seen);
  }

  async seen(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('seen')) ?? [];
  }
}

export class EvictionProbeDO extends Agent<Cloudflare.Env> {
  /**
   * A one-second heartbeat instead of the default thirty.
   *
   * The knob is the SDK's own (`AgentStaticOptions.keepAliveIntervalMs`), and it
   * is what makes the no-client path OBSERVABLE rather than merely believed:
   * after a reset, the alarm the previous activation persisted is the only thing
   * that can start recovery, and at the default interval a test would have to
   * wait half a minute for it. Shortening the interval changes when the alarm
   * fires, not what fires it.
   */
  static override options = { keepAliveIntervalMs: 1_000 };

  /** This probe's own witness, keyed to its name so two tests sharing the
   *  process cannot read each other's notes and call it a recovery. */
  private witness(): DurableObjectStub<WitnessDO> {
    return this.env.WITNESS.get(this.env.WITNESS.idFromName(this.name));
  }

  /**
   * A durable fiber whose body never settles.
   *
   * `startFiber` accepts the independent job before returning. Its execution
   * writes the `cf_agents_runs` row before running the body and takes a
   * `keepAlive` for the duration, so the reset below leaves exactly the pair
   * production leaves: the row, and no promise.
   */
  async startLostFiber(name: string): Promise<void> {
    await this.startFiber(name, async (ctx) => {
      ctx.stash({ lane: name, phase: 'running' });
      await new Promise<void>(() => undefined);
    });
    // The durable run is registered before `startFiber` resolves; returning
    // here means the caller's next read sees it.
  }

  /** Report the recovery to the witness and terminalize, which is the shape
   *  `ActorAgent.onFiberRecovered` returns for every lane it recognises. */
  override async onFiberRecovered(ctx: {
    id: string; name: string; snapshot: unknown; createdAt: number;
  }): Promise<{ status: 'completed'; snapshot: unknown }> {
    await this.witness().record(`fiber:${ctx.name}`);

    return { status: 'completed', snapshot: { lane: ctx.name, recovered: true } };
  }

  /** Durable fiber rows still awaiting recovery. */
  async openFiberRows(): Promise<{ id: string; name: string }[]> {
    return this.sql<{ id: string; name: string }>`SELECT id, name FROM cf_agents_runs ORDER BY created_at`;
  }
}

/**
 * The vendor half of eviction durability in workerd: a `cf_agents_runs` row survives an isolate reset, and
 * with no client the persisted keepAlive alarm drives the interrupted-fiber scan (bun cannot host either).
 * Observation goes to a separate witness DO, since any request to the probe runs `onStart` and the scan.
 */
import { DurableObject } from 'cloudflare:workers';
import { Agent } from 'agents';

/** Separate, so the test can ask "did recovery run" without the request that would make it run. */
export class WitnessDO extends DurableObject<Cloudflare.Env> {
  /** Callers of {@link until}, by the note each waits for; memory only, since they wait in this instance. */
  private readonly waiting = new Map<string, ((seen: string[]) => void)[]>();

  async record(note: string): Promise<void> {
    const seen = await this.seen();
    seen.push(note);
    await this.ctx.storage.put('seen', seen);

    for (const resolve of this.waiting.get(note) ?? []) resolve(seen);
    this.waiting.delete(note);
  }

  async seen(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('seen')) ?? [];
  }

  /** Answers once `note` is recorded: the wait ends on the record, never on a clock. */
  async until(note: string): Promise<string[]> {
    const seen = await this.seen();

    if (seen.includes(note)) return seen;

    return new Promise((resolve) => {
      this.waiting.set(note, [...(this.waiting.get(note) ?? []), resolve]);
    });
  }
}

export class EvictionProbeDO extends Agent<Cloudflare.Env> {
  /**
   * Shortened heartbeat (`AgentStaticOptions.keepAliveIntervalMs`): after a reset the persisted alarm alone
   * starts recovery; this changes when it fires, not what fires it.
   */
  static override options = { keepAliveIntervalMs: 1_000 };

  /** Keyed to its name so two tests sharing the process cannot read each other's notes. */
  private witness(): DurableObjectStub<WitnessDO> {
    return this.env.WITNESS.get(this.env.WITNESS.idFromName(this.name));
  }

  /**
   * A durable fiber whose body never settles: the reset leaves exactly what production leaves, the
   * `cf_agents_runs` row and no promise.
   */
  async startLostFiber(name: string): Promise<void> {
    await this.startFiber(name, async (ctx) => {
      ctx.stash({ lane: name, phase: 'running' });
      await new Promise<void>(() => undefined);
    });
  }

  /** The shape `ActorAgent.onFiberRecovered` returns for every lane it recognises. */
  override async onFiberRecovered(ctx: {
    id: string; name: string; snapshot: unknown; createdAt: number;
  }): Promise<{ status: 'completed'; snapshot: unknown }> {
    await this.witness().record(`fiber:${ctx.name}`);

    return { status: 'completed', snapshot: { lane: ctx.name, recovered: true } };
  }

  async openFiberRows(): Promise<{ id: string; name: string }[]> {
    return this.sql<{ id: string; name: string }>`SELECT id, name FROM cf_agents_runs ORDER BY created_at`;
  }
}

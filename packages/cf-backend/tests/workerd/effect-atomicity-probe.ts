import { DurableObject } from 'cloudflare:workers';
import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';

/** Counts the events a Durable Object admits while one long effect runs inside another. */
export class EffectAtomicityProbeDO extends DurableObject<Cloudflare.Env> {
  private delivered = 0;

  async ping(): Promise<number> {
    this.delivered += 1;

    return this.delivered;
  }

  /** Events admitted while `steps` synchronous steps ran, under `settle` or Effect's default runner. */
  async interleaved(runner: 'settle' | 'default', steps: number): Promise<number> {
    const before = this.delivered;

    const program = Effect.gen(function* () {
      for (let step = 0; step < steps; step += 1) yield* Effect.sync(() => step);
    });

    if (runner === 'settle') await settle(program);
    else await Effect.runPromise(program);

    return this.delivered - before;
  }
}

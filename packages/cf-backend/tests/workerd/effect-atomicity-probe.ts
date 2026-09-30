import { DurableObject } from 'cloudflare:workers';
import { Effect } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';
import { DevboxError, settle as settleDevbox } from '../../../devbox/src/errors';

/** Counts the events a Durable Object admits while one long effect runs inside another. */
export class EffectAtomicityProbeDO extends DurableObject<Cloudflare.Env> {
  private delivered = 0;

  refusal(): Promise<never> {
    return settle(Effect.fail(new KinuError('unavailable', 'upstream refused', { cause: new TypeError('socket closed') })));
  }

  devboxRefusal(): Promise<never> {
    return settleDevbox(Effect.fail(new DevboxError('file', 'native file unavailable', {
      cause: { kind: 'devbox.file', code: 'ENOENT', path: '/workspace/missing', operation: 'readFile' },
    })));
  }

  async ping(): Promise<number> {
    this.delivered += 1;

    return this.delivered;
  }

  /**
   * Pings originate inside the event. The default runner must yield until all arrive; a fixed step
   * budget would race RPC delivery. The settle run is finite because it must admit none.
   */
  async interleaved(runner: 'settle' | 'devbox' | 'default', steps: number, pings: number): Promise<number> {
    const self = this.env.EFFECT_ATOMICITY_PROBE.get(this.ctx.id);
    const before = this.delivered;
    const sent = Array.from({ length: pings }, () => self.ping());
    const pending = () => this.delivered - before < pings;

    const program = Effect.gen(function* () {
      for (let step = 0; pending() && (runner === 'default' || step < steps); step += 1) yield* Effect.sync(() => step);
    });

    if (runner === 'settle') await settle(program);
    else if (runner === 'devbox') await settleDevbox(program);
    else await Effect.runPromise(program);
    const admitted = this.delivered - before;
    await Promise.all(sent);

    return admitted;
  }
}

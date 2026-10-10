/**
 * The product worker's entry in `scripts/worker-heap.ts`: the built bundle's own exports, with its workspace class
 * widened by one RPC that hosts exploration heads through the bundle's own actor host, as a swarm does, so the
 * heap after they leave is read on the code the deploy ships.
 */
import { OrchestratorAgent as Product } from 'kinu:product';

export * from 'kinu:product';

export { default } from 'kinu:product';

export class OrchestratorAgent extends Product {
  constructor(...args: ConstructorParameters<typeof Product>) {
    super(...args);
    // The product sealed its RPC surface with an own property over every unlisted name; these are the probe's.
    Reflect.deleteProperty(this, 'hostHeads');
    Reflect.deleteProperty(this, 'delegatedRunners');
    Reflect.deleteProperty(this, 'quiesce');
  }

  /** Its sleep-time lane off, and what it has detached or still closing joined: a later phase's measurement in this
   *  isolate reads no compression pass of this workspace's in flight. */
  async quiesce(): Promise<void> {
    this.config.setSleepTimeComputeEnabled(false);
    await this.settleBackgroundTasks();
    await this.terminal.idle();
  }

  /** Hired agents with a delegated turn runner: one ends only after its turn's release has run. */
  async delegatedRunners(): Promise<number> {
    return this.delegatedTurns.actorRunners.size;
  }

  /** Registers and acquires `count` heads, then releases each: what a swarm's settled nodes leave behind. */
  async hostHeads(tag: string, count: number): Promise<void> {
    const seams = this.hostedSeams();
    const references = [];

    for (let at = 0; at < count; at++) {
      const reference = await seams.register({ creationId: `${tag}-${String(at)}` });
      await seams.host.acquire(reference, { kind: 'node' });
      references.push(reference);
    }

    for (const reference of references) seams.host.release(reference);
  }
}

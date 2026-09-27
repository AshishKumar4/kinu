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
    // The product sealed its RPC surface with an own property over every unlisted name; this one is the probe's.
    Reflect.deleteProperty(this, 'hostHeads');
  }

  /** Registers and acquires `count` heads, then releases each: what a swarm's settled nodes leave behind. */
  async hostHeads(tag: string, count: number): Promise<void> {
    const seams = this.hostedSeams();
    const references = [];

    for (let at = 0; at < count; at++) {
      const reference = await seams.register({ creationId: `${tag}-${String(at)}`, toolProfile: 'full' });
      await seams.host.acquire(reference);
      references.push(reference);
    }

    for (const reference of references) seams.host.release(reference);
  }
}

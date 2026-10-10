/**
 * Main's isolate as `scripts/worker-heap.ts` loads it: the shipped facet, and a buffer the gate plants in it to prove
 * it reads this isolate's heap, not another's.
 */
import { AgentFacet as Shipped } from '../../src/agent-facet/agent-facet';

/** Held for the isolate's life, as a leak would be. */
const planted: Uint8Array[] = [];

export class AgentFacet extends Shipped {
  async plant(bytes: number): Promise<void> {
    planted.push(new Uint8Array(bytes).fill(7));
  }
}

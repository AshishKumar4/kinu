/**
 * An agent's isolate as the facet loop gate loads it (`scripts/worker-heap/loop-turns.ts`): the heap gate's, with each
 * zero-delay timer made to wait 2 ms. Work sliced by such a timer resumes too soon for a CPU profiler sampling every
 * millisecond to see the loop wait, so its slices read as one stretch: on 2026-10-23 a chat's seed in four-message
 * slices read 127 ms as one, and fell below its isolate's next-longest stretch (79 ms) with the slices 2 ms apart. A turn
 * that ends at I/O is untouched.
 */
export { AgentFacet } from './heap-plant-agent';

const timer = globalThis.setTimeout;

Object.assign(globalThis, {
  setTimeout: (handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => timer(handler, delay === undefined || delay <= 0 ? 2 : delay, ...args),
});

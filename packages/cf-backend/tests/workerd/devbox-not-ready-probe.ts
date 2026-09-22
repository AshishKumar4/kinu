/**
 * Does a devbox readiness refusal survive Workers RPC to its caller? A thrown refusal arrives as `Error`,
 * which is why the refusal is a returned `RestoreReadiness` value.
 */
import { DurableObject } from 'cloudflare:workers';

const NOT_READY_TEXT =
  'this devbox is not ready: a restoration has been running in the request for 120 ms. '
  + 'Nothing has been classified as a failure; a startup is armed, so ask again.';

class StillRestoring extends Error {
  override name = 'StillRestoring';
}

export class DevboxNotReadyProbeDO extends DurableObject<Cloudflare.Env> {
  /** The pending half of `RestoreReadiness` verbatim. */
  async resolveReadiness(): Promise<{ kind: 'pending'; reason: string }> {
    return { kind: 'pending', reason: NOT_READY_TEXT };
  }

  async restoredReadiness(): Promise<{ kind: 'restored' }> {
    return { kind: 'restored' };
  }

  /**
     *  Normalization control: the caller's isolate reads `Error` whatever the class name. Synchronous by
     *  necessity: an async rejection is `Uncaught (in promise)` in the callee and fails the pool run. */
  namedRefusal(): string {
    throw new StillRestoring(NOT_READY_TEXT);
  }

  localRefusalName(): string {
    return new StillRestoring(NOT_READY_TEXT).name;
  }

  /** Dispatch sentinel: runs only if a caller-side gate lets a pending box through. */
  async exec(): Promise<{ stdout: string; exitCode: number }> {
    throw new Error('the probe exec ran — readiness was skipped');
  }
}

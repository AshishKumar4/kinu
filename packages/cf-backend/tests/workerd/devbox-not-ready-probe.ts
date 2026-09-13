/**
 * Does a devbox's readiness refusal reach its caller intact?
 *
 * THE SEAM UNDER TEST. The sandbox object a cf-backend executor commands
 * lives in its own isolate, so `handle.resolveReadiness()` on a
 * `DurableObjectStub<KinuSandbox>` reads through Workers RPC
 * serialisation. This file measures that transport, and stops there:
 * what the adapter does with the answer is the OTHER half's seam, proven
 * bun-side. A THROWN refusal is normalised by the transport — the class
 * name reads `StillRestoring` inside the callee isolate
 * (`localRefusalName` reads it before the throw ever crosses) and
 * `Error` by the time the rejection reaches the caller — which is why
 * the refusal is a RETURNED value: `RestoreReadiness` serialises by
 * value and loses nothing.
 *
 * A method rather than `fetch`, because that is the call shape
 * `handle.resolveReadiness()` actually is: Workers RPC over the stub, the
 * same serialisation the production path uses.
 */
import { DurableObject } from 'cloudflare:workers';

const NOT_READY_TEXT =
  'this devbox is not ready: a restoration has been running in the request for 120 ms. '
  + 'Nothing has been classified as a failure; a startup is armed, so ask again.';

class StillRestoring extends Error {
  override name = 'StillRestoring';
}

export class DevboxNotReadyProbeDO extends DurableObject<Cloudflare.Env> {
  /** The pending half of `RestoreReadiness` verbatim — the answer a box with
   *  an armed-but-unsettled restore gives the readiness gate's data path. */
  async resolveReadiness(): Promise<{ kind: 'pending'; reason: string }> {
    return { kind: 'pending', reason: NOT_READY_TEXT };
  }

  /** The admitting half, so the contract's two arms are both exercised. */
  async restoredReadiness(): Promise<{ kind: 'restored' }> {
    return { kind: 'restored' };
  }

  /** The normalization control, and the whole reason the contract is a
   *  return type: whatever name the throwing class set, the caller's isolate
   *  reads `Error` — so no classification may ride a thrown refusal.
   *
   *  Synchronous BY NECESSITY, not style: an `async` method's rejection
   *  surfaces in the callee isolate as `Uncaught (in promise)`, which the
   *  pool reports as an unhandled error and exits non-zero with every
   *  assertion green. A synchronous throw crosses the same serialization —
   *  the property under test — as a plain call failure. */
  namedRefusal(): string {
    throw new StillRestoring(NOT_READY_TEXT);
  }

  /** Observe the custom name before RPC serialization. */
  localRefusalName(): string {
    return new StillRestoring(NOT_READY_TEXT).name;
  }

  /** The dispatch sentinel: if a caller-side gate ever lets this run on a
   *  pending box, the failure it answers names the hole itself. */
  async exec(): Promise<{ stdout: string; exitCode: number }> {
    throw new Error('the probe exec ran — readiness was skipped');
  }
}

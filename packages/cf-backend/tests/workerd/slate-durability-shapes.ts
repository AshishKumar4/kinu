/**
 * The slate-durability probe's wire shapes.
 *
 * Lives apart from `slate-durability-probe.ts` on purpose: the probe entry
 * imports production `src`, so the workerd typecheck project excludes it (see
 * the `//exclude` note in this directory's tsconfig — importing it here would
 * drag the whole worker into a project whose globals lack the ambient `Env`).
 * This module imports nothing, so the test, the probe, and `env.d.ts` can all
 * name the same shapes without pulling `src` along.
 */

/** One stored port reservation, as Nimbus keeps it in the object's storage:
 *  the port, its owner, and the capability the URL was minted from. */
export interface DurabilityReservation {
  readonly port: number;
  readonly owner: string | null;
  readonly capability: string | null;
}

/** What `serveSlate` hands the test: the durable URL the preview op minted,
 *  the reserved port it rides, the capability under it, and the reservation
 *  rows the object held at that instant. */
export interface ServedSlate {
  readonly url: string;
  readonly port: number;
  readonly capability: string;
  readonly reservations: readonly DurabilityReservation[];
}

/** An HTTP answer driven through the preview host route. */
export interface PreviewAnswer {
  readonly status: number;
  readonly body: string;
}

/** One authored method called through the durable URL's `/__rpc` socket. */
export interface RpcAnswer {
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
}

/** What `removeSlate` observed of the slate's removal. */
export interface RemovedSlate {
  readonly ok: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly port?: number | null;
}

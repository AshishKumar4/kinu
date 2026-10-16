/** Kept apart from `slate-durability-probe.ts`, which imports `src` and is excluded from the workerd typecheck project;
 *  this module imports nothing so the test, probe and `env.d.ts` share shapes. */

/** One stored port reservation as Nimbus keeps it in the object's storage. */
export interface DurabilityReservation {
  readonly port: number;
  readonly owner: string | null;
  readonly capability: string | null;
}

export interface ServedSlate {
  readonly url: string;
  readonly port: number;
  readonly capability: string;
  readonly reservations: readonly DurabilityReservation[];
}

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

export interface RemovedSlate {
  readonly ok: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly port?: number | null;
}

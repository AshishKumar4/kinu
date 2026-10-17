import * as v from 'valibot';
import { ContractOwnerSchema, type ContractOwner } from './ledger';

/**
 * The staging eval identity's contract fixture: one Worker, and the Durable Object namespace and container application
 * its first deploy made, which each run deploys again. Everything else is the run's own and goes with it: its bucket,
 * boxes, snapshots and containers. A namespace new to the platform answers some calls `internal error; reference = …`
 * without running the object, for up to 45 s after `wrangler deploy` returns, and nothing says when it is ready; a
 * deploy of an existing one, the path the product's own deploys take, showed none (docs/DEPLOYMENT.md, 2026-10-16).
 * It is created by the first run that finds it absent, which is the one run that meets that window.
 */
export const FIXTURE_WORKER = 'kinu-devbox-contracts-staging';

/** A run's names: the lasting Worker and the application wrangler names after it and its class, and the run's bucket. */
export function fixtureNames(run: string) {
  return { worker: FIXTURE_WORKER, app: `${FIXTURE_WORKER}-contractbox`, bucket: `kinu-${run}` };
}

/** Which run deploys the fixture: one at a time, as each binds the Worker to its own bucket and clears the golden box. */
export const LeaseSchema = v.object({ schema: v.literal('devbox-contracts/lease@1'), worker: v.string(), run: v.string(), owner: ContractOwnerSchema });

export type Lease = v.InferOutput<typeof LeaseSchema>;

/** Where the lease is kept: a write lands only where none is held (`version` null) or the held one is still `version`. */
export interface LeaseStore {
  read(): Promise<{ readonly lease: unknown; readonly version: string } | null>;
  write(lease: Lease, version: string | null): Promise<boolean>;
  remove(): Promise<void>;
}

const holderOf = (lease: Lease) => `run ${lease.run} (armada job ${lease.owner.job}, task ${String(lease.owner.index)}, attempt ${String(lease.owner.attempt)})`;

/**
 * Takes the fixture for `lease`'s run, or refuses naming the run that holds it. A holder whose armada task has ended
 * (`ended`, armada's own record of it) is taken over: its teardown is the ledger's to replay.
 */
export async function takeLease(store: LeaseStore, lease: Lease, ended: (owner: ContractOwner) => Promise<boolean>): Promise<void> {
  if (await store.write(lease, null)) return;
  const held = await store.read();

  if (held === null) {
    if (await store.write(lease, null)) return;

    throw new Error(`${lease.worker} was taken by another run as this one took it`);
  }

  const holder = v.parse(LeaseSchema, held.lease);

  if (!await ended(holder.owner)) throw new Error(`${lease.worker} is held by ${holderOf(holder)}, which is still running: one run at a time deploys it`);

  if (!await store.write(lease, held.version)) throw new Error(`${lease.worker} was taken by another run as this one took it over from ${holderOf(holder)}`);
}

/** Gives the fixture up. No other run takes it over while its holder runs, so the lease read here is still the one removed. */
export async function dropLease(store: LeaseStore, run: string): Promise<void> {
  const held = await store.read();

  if (held === null) return;
  const holder = v.parse(LeaseSchema, held.lease);

  if (holder.run !== run) throw new Error(`the lease on ${holder.worker} is ${holderOf(holder)}'s, not run ${run}'s`);
  await store.remove();
}

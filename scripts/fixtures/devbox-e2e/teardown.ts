import { describeThrown } from '../../ephemeral-deployment';

export type TeardownHealth = { readonly status: number | null } | { readonly failure: string };

/** What a run made, which goes with it; the lasting fixture's Worker and application stay (`fixture.ts`). */
interface TeardownWork {
  readonly health: () => Promise<number | null>;
  /** Each of the run's boxes emptied, its container stopped and its snapshots deleted, or a rejection naming each that was not. */
  readonly boxes: (health: TeardownHealth) => Promise<void>;
  /** Every snapshot the application holds: only the run that holds the fixture makes any. */
  readonly snapshots: () => Promise<void>;
  readonly bucket: () => Promise<void>;
}

/**
 * Every step runs whatever an earlier one did, but the bucket: a box's clear reads its store, so a bucket deleted under a
 * box that was not emptied leaves a box no replay can clear. It is kept for the ledger's replay instead.
 */
export async function completeTeardown(work: TeardownWork): Promise<{ readonly health: TeardownHealth; readonly errors: string[] }> {
  const [reading] = await Promise.allSettled([Promise.resolve().then(work.health)]);

  const health: TeardownHealth = reading?.status === 'fulfilled'
    ? { status: reading.value } : { failure: describeThrown({ cause: reading?.reason }) };

  const errors: string[] = [];

  const settled = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    const [outcome] = await Promise.allSettled([Promise.resolve().then(run)]);

    if (outcome?.status === 'rejected') errors.push(`${name}: ${describeThrown({ cause: outcome.reason })}`);

    return outcome?.status === 'fulfilled';
  };

  const emptied = await settled('boxes', () => work.boxes(health));

  await settled('application snapshots', work.snapshots);

  if (emptied) await settled('bucket deletion', work.bucket);
  else errors.push('bucket deletion: retained for the replay, as a box was not emptied');

  return { health, errors };
}

import { describeThrown } from '../r2-bench/deploy-substrate';

export type TeardownHealth = { readonly status: number | null } | { readonly failure: string };

interface TeardownWork {
  readonly health: () => Promise<number | null>;
  readonly beforeDelete: (health: TeardownHealth) => Promise<void>;
  readonly worker: () => Promise<void>;
  readonly application: () => Promise<void>;
  readonly bucket: () => Promise<void>;
}

export async function completeTeardown(work: TeardownWork): Promise<{ readonly health: TeardownHealth; readonly errors: string[] }> {
  const [reading] = await Promise.allSettled([Promise.resolve().then(work.health)]);

  const health: TeardownHealth = reading?.status === 'fulfilled'
    ? { status: reading.value } : { failure: describeThrown({ cause: reading?.reason }) };

  const errors: string[] = [];

  const operations = [
    ['before deletion', () => work.beforeDelete(health)],
    ['Worker deletion', work.worker], ['application deletion', work.application], ['bucket deletion', work.bucket],
  ] as const;

  for (const [name, run] of operations) {
    const [outcome] = await Promise.allSettled([Promise.resolve().then(run)]);

    if (outcome?.status === 'rejected') errors.push(`${name}: ${describeThrown({ cause: outcome.reason })}`);
  }

  return { health, errors };
}

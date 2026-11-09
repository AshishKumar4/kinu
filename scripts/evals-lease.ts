// Kinu's armada, which runs every eval trial, and the eval keys' usage windows each run reads before and after it. The
// trial accounts a run acts as are its by its lease (evals/src/lease.ts), never by its job's label.
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { connect, type Armada } from 'armada';
import { LimitCache, limitLines } from '@kinu.run/core';
import { EVAL_PROVIDER_KEYS, keysIn } from './eval-provider-keys';
import { claimOf, type SlotClaim } from '../evals/src/slot';

/** Kinu's armada deployment, which runs every eval trial. */
export const KINU_ARMADA = join(homedir(), '.config', 'armada', 'armada-kinu.json');

const JobsPageSchema = v.object({
  jobs: v.array(v.looseObject({ id: v.string(), label: v.string(), phase: v.string() })),
});

/** A block a live job's label claims, and that job. */
export type HeldClaim = SlotClaim & { readonly job: string };

/** Kinu's armada, whatever ARMADA_CONNECTION the caller's environment names. */
export function kinuArmada(): Armada {
  const named = process.env['ARMADA_CONNECTION'];

  process.env['ARMADA_CONNECTION'] = KINU_ARMADA;

  try {
    return connect();
  } finally {
    if (named === undefined) delete process.env['ARMADA_CONNECTION'];
    else process.env['ARMADA_CONNECTION'] = named;
  }
}

/**
 * Every block a live job's label claims, read through all the jobs the deployment keeps, a page of 100 at a time. A job
 * outlives the run that drives it (armada keeps one about three minutes after its follower is gone), so a block is free
 * only when no run's lease holds it and no live job claims it (evals/src/lease.ts `leaseBlock`).
 */
export async function liveClaims(armada: Pick<Armada, 'call'>): Promise<HeldClaim[]> {
  const held: HeldClaim[] = [];
  let before: string | undefined;

  for (;;) {
    const page = v.parse(JobsPageSchema, await (await armada.call(`/jobs?limit=100${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`)).json());

    for (const job of page.jobs) {
      const claim = job.phase === 'done' ? null : claimOf(job.label);

      if (claim !== null) held.push({ ...claim, job: job.id });
    }

    before = page.jobs.at(-1)?.id;

    if (page.jobs.length < 100) return held;
  }
}

/**
 * What each eval provider key has left, said before a run starts, and the run refused while any of its usage windows is
 * spent: every trial's model calls would be refused until it resets. Every trial of every run, a release's included,
 * draws on these same keys (scripts/eval-provider-keys.ts), so a long comparison can spend the window a release needs;
 * this is where that shows. A window the provider does not report is said, not guessed.
 */
export async function keysWindows(say: (line: string) => void, seams: { readonly keysPath?: string; readonly fetch?: typeof fetch; readonly now?: number; readonly refuseSpent?: boolean } = {}): Promise<void> {
  const now = seams.now ?? Date.now();
  const file = keysIn(seams.keysPath ?? EVAL_PROVIDER_KEYS);

  if ('why' in file) throw new Error(`evals: no eval provider keys: ${file.why}`);
  const sources = Object.entries(file.keys).map(([key, token]) => ({ key, headers: async () => ({ Authorization: `Bearer ${token}` }) }));
  const { limits, limitsUnread } = await new LimitCache(() => now).read(sources, seams.fetch === undefined ? {} : { fetch: seams.fetch });

  for (const line of limitLines(limits, limitsUnread, now)) say(`evals: eval keys: ${line}`);
  const spent = limits.flatMap((report) => report.windows.filter((window) => (window.usedPercent ?? 0) >= 100).map((window) => ({ report, window })));

  if (spent.length > 0 && seams.refuseSpent !== false) {
    throw new Error(`evals: ${spent.map(({ report, window }) => `${report.provider}'s ${window.name} window is spent${window.resetsAt === undefined ? '' : ` until ${new Date(window.resetsAt).toISOString()}`}`).join('; ')}: `
      + 'every trial\'s model calls would be refused; start once it resets');
  }
}

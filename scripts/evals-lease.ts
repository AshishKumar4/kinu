// The trial accounts eval runs hold, read from the one place every run is: armada's open jobs. Each run's job names the
// block it holds in its label (`claimLabel`, evals/src/slot.ts), so a deploy's runs and an operator's take disjoint
// blocks, or the later one waits; before this, each chose alone, and only a trial's own guard (prepareTrialAccount)
// stood between two runs on one account.
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { connect, type Armada } from 'armada';
import { LimitCache, limitLines } from '@kinu.run/core';
import { claimOf, freeBlock, type SlotClaim } from '../evals/src/slot';
import { EVAL_PROVIDER_KEYS, keysIn } from './eval-provider-keys';

/** Kinu's armada deployment, which runs every eval trial. */
export const KINU_ARMADA = join(homedir(), '.config', 'armada', 'armada-kinu.json');

/** How long a run waits between reads of the open runs while every block it could take is held. */
const WAIT_MS = 60_000;

const JobsPageSchema = v.object({
  jobs: v.array(v.looseObject({ id: v.string(), label: v.string(), phase: v.string(), createdAt: v.number() })),
});

/** A claim, and the job that holds it: the earlier job keeps a block two runs took at once. */
export type HeldClaim = SlotClaim & { readonly job: string; readonly createdAt: number };

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

/** Every block an open job claims, read through all the jobs the deployment keeps, a page of 100 at a time. */
export async function openClaims(armada: Armada): Promise<HeldClaim[]> {
  const held: HeldClaim[] = [];
  let before: string | undefined;

  for (;;) {
    const page = v.parse(JobsPageSchema, await (await armada.call(`/jobs?limit=100${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`)).json());

    for (const job of page.jobs) {
      const claim = job.phase === 'done' ? null : claimOf(job.label);

      if (claim !== null) held.push({ ...claim, job: job.id, createdAt: job.createdAt });
    }

    before = page.jobs.at(-1)?.id;

    if (page.jobs.length < 100) return held;
  }
}

/** The first account of a free block of `size` on `hosts`, waiting while every block of the run's half (`pass`) is held. */
export async function leaseBlock(armada: Armada, { size, pass, hosts }: { readonly size: number; readonly pass: boolean; readonly hosts: readonly string[] }, say: (line: string) => void): Promise<number> {
  for (;;) {
    const held = await openClaims(armada);
    const first = freeBlock(size, pass, hosts, held);

    if (first !== null) return first;
    say(`evals: waiting for ${String(size)} trial accounts on ${hosts.join(', ')}: held by ${held.map((claim) => `${claim.job} (${String(claim.first)}-${String(claim.last)})`).join(', ')}`);
    await Bun.sleep(WAIT_MS);
  }
}

/** Whether a job that started before `job` holds part of `claim`: two runs read the same free block and both took it,
 *  and the later one gives it up. */
export async function outranked(armada: Armada, job: string, claim: SlotClaim): Promise<boolean> {
  const held = await openClaims(armada);
  const own = held.find((each) => each.job === job);

  return held.some((other) => other.job !== job && other.first <= claim.last && other.last >= claim.first
    && other.hosts.some((host) => claim.hosts.includes(host))
    && (own === undefined || other.createdAt < own.createdAt || (other.createdAt === own.createdAt && other.job < job)));
}

/**
 * What each eval provider key has left, said before a run starts, and the run refused while any of its usage windows is
 * spent: every trial's model calls would be refused until it resets. Every trial of every run, a release's included,
 * draws on these same keys (scripts/eval-provider-keys.ts), so a long comparison can spend the window a release needs;
 * this is where that shows. A window the provider does not report is said, not guessed.
 */
export async function keysWindows(say: (line: string) => void, seams: { readonly keysPath?: string; readonly fetch?: typeof fetch; readonly now?: number } = {}): Promise<void> {
  const now = seams.now ?? Date.now();
  const file = keysIn(seams.keysPath ?? EVAL_PROVIDER_KEYS);

  if ('why' in file) throw new Error(`evals: no eval provider keys: ${file.why}`);
  const sources = Object.entries(file.keys).map(([key, token]) => ({ key, headers: async () => ({ Authorization: `Bearer ${token}` }) }));
  const { limits, limitsUnread } = await new LimitCache(() => now).read(sources, seams.fetch === undefined ? {} : { fetch: seams.fetch });

  for (const line of limitLines(limits, limitsUnread, now)) say(`evals: eval keys: ${line}`);
  const spent = limits.flatMap((report) => report.windows.filter((window) => (window.usedPercent ?? 0) >= 100).map((window) => ({ report, window })));

  if (spent.length > 0) {
    throw new Error(`evals: ${spent.map(({ report, window }) => `${report.provider}'s ${window.name} window is spent${window.resetsAt === undefined ? '' : ` until ${new Date(window.resetsAt).toISOString()}`}`).join('; ')}: `
      + 'every trial\'s model calls would be refused; start once it resets');
  }
}

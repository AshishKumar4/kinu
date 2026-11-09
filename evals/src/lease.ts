// The one lease on a block of a deployment's trial accounts (evals/src/slot.ts): every run that acts as trial accounts
// takes its block here before anything touches them (provisioning, trials, renewals) and holds it until its teardown has
// deleted every one. A block is free only on two facts at once: no run's lock holds it, and no live armada job's label
// claims it (a job outlives a run that died, about three minutes, its trials still on the block). The lock is a kernel
// lock (flock) on one file per account and deployment, held by a small holder process the run owns: the OS lets go of
// it when that process ends, however the run ended. Every taker runs on the operator's machine, where these files are.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EVAL_TRIAL_ACCOUNTS } from '@kinu.run/core';
import type { SlotClaim } from './slot';

/** Where the lock files are kept: one per deployment's host and trial account. */
export const TRIAL_LEASES = join(homedir(), '.local', 'state', 'kinu', 'trial-leases');

/** The holder: each file opened and locked without waiting, then held until its stdin closes, its run's end. */
const HOLDER = `set -u
for file in "$@"; do
  exec {fd}>>"$file" || exit 2
  flock -n "$fd" || exit 1
done
echo held
exec cat >/dev/null`;

/** A run's lease on trial-`first` to trial-`last` on each of its hosts. */
export interface TrialLease {
  readonly first: number;
  readonly last: number;
  readonly hosts: readonly string[];
  /** Lets the block go: only once the run's teardown has answered for every account. */
  release(): Promise<void>;
}

/** The lock files of `first` to `last` on each of `hosts`. */
function lockFiles(dir: string, hosts: readonly string[], first: number, last: number): string[] {
  return hosts.flatMap((host) => {
    mkdirSync(join(dir, host), { recursive: true });

    return Array.from({ length: last - first + 1 }, (_, at) => join(dir, host, `trial-${String(first + at)}.lock`));
  });
}

/** The holder's first line: it keeps its output open while it holds, so nothing reads it to its end. */
async function firstLine(output: ReadableStream<Uint8Array>): Promise<string> {
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let said = '';

  while (!said.includes('\n')) {
    const { value, done } = await reader.read();

    if (done) break;
    said += decoder.decode(value, { stream: true });
  }

  reader.releaseLock();

  return said;
}

/** The block `first` to `last` on `hosts`, locked by a holder now, or null where any of it is another run's. */
async function tryLease(dir: string, hosts: readonly string[], first: number, last: number): Promise<TrialLease | null> {
  const holder = Bun.spawn(['bash', '-c', HOLDER, 'trial-lease', ...lockFiles(dir, hosts, first, last)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const said = await firstLine(holder.stdout);

  // The holder answers `held` and keeps holding, or exits: a lock another run holds, or a file it could not open.
  if (!said.startsWith('held')) {
    const exit = await holder.exited;

    if (exit === 1) return null;

    throw new Error(`the trial lease's holder could not lock trial-${String(first)} to trial-${String(last)} (exit ${String(exit)}): ${await new Response(holder.stderr).text()}`);
  }

  return {
    first, last, hosts,
    release: async () => {
      await holder.stdin.end();
      await holder.exited;
    },
  };
}

/** The accounts a run's half of a deployment holds: a deploy's one-trial pass the upper half, every other run the lower. */
export function halfOf(pass: boolean): readonly [number, number] {
  const half = EVAL_TRIAL_ACCOUNTS / 2;

  return pass ? [half + 1, EVAL_TRIAL_ACCOUNTS] : [1, half];
}

/**
 * The lowest block of `size` accounts in the run's half (`pass`) no other run holds on any of `hosts`, leased now. A run
 * that finds none fails, naming why: every block of its half is another run's.
 */
export async function leaseBlock(input: {
  readonly size: number; readonly pass: boolean; readonly hosts: readonly string[];
  /** The blocks live armada jobs claim now (scripts/evals-lease.ts `liveClaims`), read once the lock is held. */
  readonly liveClaims: () => Promise<readonly SlotClaim[]>;
  readonly dir?: string;
}): Promise<TrialLease> {
  const [low, high] = halfOf(input.pass);
  const dir = input.dir ?? TRIAL_LEASES;

  if (input.size < 1 || low - 1 + input.size > high) {
    throw new Error(`a run needs ${String(input.size)} trial accounts, and its half of a deployment's has trial-${String(low)} to trial-${String(high)}`);
  }

  for (let first = low; first - 1 + input.size <= high; first += input.size) {
    const last = first - 1 + input.size;
    const lease = await tryLease(dir, input.hosts, first, last);

    if (lease === null) continue;
    // Locked first, then read: a job claiming it after the read is a run that holds this lock, which no other can.
    const claimed = (await input.liveClaims()).some((claim) => claim.first <= last && claim.last >= first && claim.hosts.some((host) => input.hosts.includes(host)));

    if (!claimed) return lease;
    await lease.release();
  }

  throw new Error(`no block of ${String(input.size)} trial accounts from trial-${String(low)} to trial-${String(high)} is free on ${input.hosts.join(', ')}: `
    + `other runs hold them, by their locks (${dir}) or their live armada jobs`);
}

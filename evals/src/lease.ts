// The one lease on a block of a deployment's trial accounts (evals/src/slot.ts): every run that acts as trial accounts
// takes its block here before anything touches them (provisioning, trials, renewals) and holds it until its teardown has
// deleted every one. A block is free only on two facts at once: no run's lock holds it, and no live armada job's label
// claims it (a job outlives a run that died, about three minutes, its trials still on the block). The lock is a kernel
// lock (flock) on one file per account and deployment, held by a small holder process the run owns: the OS lets go of
// it when that process ends, however the run ended. Every taker runs on the operator's machine, where these files are.
// The lock goes with its run, but an account's deletion is finished later by the deployment's own jobs: a run's teardown
// marks each account it deletes as owed beside its lock, and clears the mark only once it reads the account deleted. A
// marked account keeps its block from every run until a read finds no deletion under way; no clock decides that.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { EVAL_TRIAL_ACCOUNTS, parseEvalAccount, type EvalAccount } from '@kinu.run/core';
import type { SlotClaim } from './slot';

/** Where the lock files are kept: one per deployment's host and trial account. */
export const TRIAL_LEASES = join(homedir(), '.local', 'state', 'kinu', 'trial-leases');

/**
 * The holder: each file opened and locked without waiting, then held until its stdin closes, its run's end. It ignores
 * the signals a terminal's Ctrl-C or a service stop sends the run's whole process group, which ignored stay ignored
 * across its exec: the run lives on to delete its block, so the lock must too.
 */
const HOLDER = `set -u
trap '' INT TERM HUP
for file in "$@"; do
  exec {fd}>>"$file" || exit 2
  flock -n "$fd" || exit 1
done
echo held
exec cat >/dev/null`;

/** An account of a block at one deployment, whose deletion a run's teardown asked for. */
export interface OwedAccount {
  readonly origin: string;
  readonly account: EvalAccount;
}

/** An owed account as its teardown names it, and its mark holds it. */
const OwedMarkSchema = v.object({ origin: v.string(), account: v.string() });

type OwedMark = v.InferOutput<typeof OwedMarkSchema>;

/** A run's lease on trial-`first` to trial-`last` on each of its hosts. */
export interface TrialLease {
  readonly first: number;
  readonly last: number;
  readonly hosts: readonly string[];
  /** Marks an account as owed before its deletion is asked: no run leases its block until a read finds it settled. */
  owe(owed: OwedMark): void;
  /** Clears the mark once the teardown read the account deleted. */
  settle(owed: OwedMark): void;
  /** Lets the block go: only once the run's teardown has answered for every account. */
  release(): Promise<void>;
}

/** The accounts `first` to `last` on each of `hosts`, each with its lock file and the mark beside it. */
function blockFiles(dir: string, hosts: readonly string[], first: number, last: number): { lock: string; owed: string }[] {
  return hosts.flatMap((host) => {
    mkdirSync(join(dir, host), { recursive: true });

    return Array.from({ length: last - first + 1 }, (_, at) => {
      const file = join(dir, host, `trial-${String(first + at)}`);

      return { lock: `${file}.lock`, owed: `${file}.owed` };
    });
  });
}

/** The mark of `owed`'s account, beside its lock. */
function owedFile(dir: string, owed: OwedMark): string {
  return join(dir, new URL(owed.origin).host, `${owed.account}.owed`);
}

/** The account a mark names, read back. */
function readOwed(file: string): OwedAccount {
  const mark = v.parse(OwedMarkSchema, JSON.parse(readFileSync(file, 'utf8')));
  const account = parseEvalAccount(mark.account);

  if (account === null) throw new Error(`${file} names no eval account`);

  return { origin: mark.origin, account };
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
  const files = blockFiles(dir, hosts, first, last).map(({ lock }) => lock);
  const holder = Bun.spawn(['bash', '-c', HOLDER, 'trial-lease', ...files], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const said = await firstLine(holder.stdout);

  // The holder answers `held` and keeps holding, or exits: a lock another run holds, or a file it could not open.
  if (!said.startsWith('held')) {
    const exit = await holder.exited;

    if (exit === 1) return null;

    throw new Error(`the trial lease's holder could not lock trial-${String(first)} to trial-${String(last)} (exit ${String(exit)}): ${await new Response(holder.stderr).text()}`);
  }

  return {
    first, last, hosts,
    owe: (owed) => {
      const file = owedFile(dir, owed);

      // Whole or absent: a run killed mid-write leaves no torn mark for every later lease to choke on.
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.writing`, `${JSON.stringify(owed)}\n`);
      renameSync(`${file}.writing`, file);
    },
    settle: (owed) => { rmSync(owedFile(dir, owed), { force: true }); },
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
 * Whether each owed account of the lease's block has settled, its mark cleared where it has: every mark is read under the
 * lock, so no teardown writes one meanwhile. A read that fails leaves its mark.
 */
async function owedSettled(lease: TrialLease, dir: string, settled: (owed: OwedAccount) => Promise<boolean>): Promise<boolean> {
  const marks = blockFiles(dir, lease.hosts, lease.first, lease.last).flatMap(({ owed }) => (existsSync(owed) ? [readOwed(owed)] : []));

  const reads = await Promise.allSettled(marks.map(async (owed) => {
    if (await settled(owed)) lease.settle(owed);
    else throw new Error(`${owed.account} at ${owed.origin} is still owed its deletion`);
  }));

  return reads.every((read) => read.status === 'fulfilled');
}

/**
 * The lowest block of `size` accounts in the run's half (`pass`) no other run holds on any of `hosts`, and none of whose
 * accounts is still owed a deletion, leased now. A run that finds none fails, naming why: every block of its half is
 * another run's, or still being deleted.
 */
export async function leaseBlock(input: {
  readonly size: number; readonly pass: boolean; readonly hosts: readonly string[];
  /** The blocks live armada jobs claim now (scripts/evals-lease.ts `liveClaims`), read once the lock is held. */
  readonly liveClaims: () => Promise<readonly SlotClaim[]>;
  /** Whether an owed account has no deletion under way (slot.ts `teardownSettled`): the caller holds its identity. */
  readonly settled: (owed: OwedAccount) => Promise<boolean>;
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
    let free = false;

    // Locked first, then read: a job claiming it after the read is a run that holds this lock, which no other can. A read
    // that throws lets the lock go with it.
    try {
      const claimed = (await input.liveClaims()).some((claim) => claim.first <= last && claim.last >= first && claim.hosts.some((host) => input.hosts.includes(host)));

      free = !claimed && await owedSettled(lease, dir, input.settled);
    } finally {
      if (!free) await lease.release();
    }

    if (free) return lease;
  }

  throw new Error(`no block of ${String(input.size)} trial accounts from trial-${String(low)} to trial-${String(high)} is free on ${input.hosts.join(', ')}: `
    + `other runs hold them, by their locks (${dir}) or their live armada jobs, or their accounts' deletions have not finished (*.owed)`);
}

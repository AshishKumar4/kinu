// A block of trial accounts is one run's, from its lease to its teardown's end: free only where no run's lock holds it
// and no live armada job's label claims it. Real locks (flock, in a scratch directory) and a fake armada's live jobs.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { leaseBlock } from './lease';
import { DEV_IDENTITY_ACCOUNT_HEADER, parseEvalAccount } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { claimLabel, claimOf, onTrialBlock, type SlotClaim } from './slot';

const STAGING = 'staging.kinu.run';

/** No account of any block is owed a deletion. */
const free = async (): Promise<boolean> => true;

describe('a lease on trial accounts', () => {
  test('a block another run holds is skipped, its own half kept apart, and free again once its lease goes', async () => {
    const dir = scratchDir('trial-leases');
    const none = async (): Promise<SlotClaim[]> => [];
    const first = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });
    const second = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });
    const elsewhere = await leaseBlock({ size: 4, pass: false, hosts: ['kinu.run'], liveClaims: none, settled: free, dir });
    const pass = await leaseBlock({ size: 1, pass: true, hosts: [STAGING], liveClaims: none, settled: free, dir });

    expect([first.first, second.first, elsewhere.first, pass.first]).toEqual([1, 5, 1, 257]);
    await first.release();
    const again = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });

    expect(again.first).toBe(1);
    await Promise.all([second, elsewhere, pass, again].map(async (lease) => lease.release()));
  });

  // Main, 2026-11-09: armada keeps a job about three minutes after the map following it is gone, its trials still acting
  // as the block. A run that died lets its lock go with it; its job's label still claims the block until the job ends.
  test("a dead run's block stays out of reach while its job lives, and nothing of it is deleted until the job has ended", async () => {
    const dir = scratchDir('trial-leases');
    const jobs = new Map<string, string>();
    const live = async (): Promise<SlotClaim[]> => [...jobs.values()].map((label) => claimOf(label)).filter((claim) => claim !== null);
    const deletes: string[] = [];

    // The first run leases trial-1 to trial-4, its job claims them, then the run dies: its lock goes, its job lives on.
    const dead = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, settled: free, dir });

    jobs.set('j1', claimLabel('5c522f12d44f', { first: dead.first, last: dead.last, hosts: [STAGING] }));
    await dead.release();

    const next = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, settled: free, dir });

    expect([dead.first, next.first]).toEqual([1, 5]);

    // The second run ends: its teardown deletes its own block, and none of the dead run's, whose job still acts as it.
    const deployment = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) ?? '';

        if (request.method === 'DELETE' && new URL(request.url).pathname === '/api/user/account') deletes.push(account);

        return new URL(request.url).pathname === '/api/user/credentials' ? Response.json([]) : Response.json({ email: `${account}@kinu.run` });
      },
    });

    try {
      const targets = [5, 6, 7, 8].map((n) => parseEvalAccount(`trial-${String(n)}`)).filter((account) => account !== null)
        .map((account) => ({ origin: deployment.url.origin, identity: { kind: 'secret' as const, secret: 's', account } }));

      await onTrialBlock(next, { targets }, async () => {}, { say: () => {} });
    } finally {
      await deployment.stop(true);
    }

    // Once the dead run's job has ended, its block is free again.
    const meanwhile = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, settled: free, dir });

    jobs.delete('j1');
    const after = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, settled: free, dir });

    expect({ deletes: deletes.sort(), meanwhile: meanwhile.first, after: after.first }).toEqual({ deletes: ['trial-5', 'trial-6', 'trial-7', 'trial-8'], meanwhile: 5, after: 1 });
    await Promise.all([meanwhile.release(), after.release()]);
  });

  // Review of 9412c5d98: Ctrl-C reaches the run's whole process group, the lock's holder too, while the run lives on to
  // delete its block; the lock is the run's until the run itself ends.
  test("a signal to the run's process group leaves its lock held, and the run's own end lets it go", async () => {
    const dir = scratchDir('trial-leases');
    const none = async (): Promise<SlotClaim[]> => [];

    const run = spawn(process.execPath, ['-e', `
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => { console.log('signalled'); });
      const { leaseBlock } = await import(${JSON.stringify(join(import.meta.dir, 'lease.ts'))});
      const lease = await leaseBlock({ size: 4, pass: false, hosts: ['${STAGING}'], liveClaims: async () => [], settled: async () => true, dir: ${JSON.stringify(dir)} });
      console.log('leased ' + lease.first);
      await new Promise(() => {});
    `], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env } });

    const said = (line: string) => new Promise<void>((heard) => { run.stdout.on('data', (out: Buffer) => { if (out.toString().includes(line)) heard(); }); });

    await said('leased');
    // The group's signals reach every member as they are sent; the run's own handler saying so means its holder has them.
    const signalled = said('signalled');

    process.kill(-(run.pid ?? 0), 'SIGINT');
    process.kill(-(run.pid ?? 0), 'SIGTERM');
    await signalled;
    const during = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });

    run.kill('SIGKILL');
    await new Promise((ended) => { run.on('exit', ended); });

    // The holder ends once it reads its closed stdin: the first block is the next lease's then, whichever attempt that is.
    let after = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });

    for (let attempt = 0; after.first !== 1 && attempt < 500; attempt += 1) {
      await after.release();
      after = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, settled: free, dir });
    }

    expect([during.first, after.first]).toEqual([5, 1]);
    await Promise.all([during.release(), after.release()]);
  });

  test('a run that finds no block free fails at once, naming both holders', async () => {
    const dir = scratchDir('trial-leases');
    const all = async (): Promise<SlotClaim[]> => [{ first: 1, last: 256, hosts: [STAGING] }];

    await expect(leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: all, settled: free, dir })).rejects.toThrow('their locks');
  });
});

// The two-process race leg lives in `agent-host.test.ts` and `packages/cli/tests/driver-lease-surfaces.test.ts`.
// No test waits: the lease carries no timestamp, and that is the property under test.
import { workspaceDatabase } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { join } from 'node:path';
import {
  DriverLeaseHold,
  type DriverKind,
  type LeaseProcess,
  type SqlExecutor,
  type SqlValue,
} from '@kinu.run/core';
import { makeExecRaw, makeSql } from '../src/runtime';
import { osLeaseProcess } from '../src/agent-host/lease-process';
import { leaseHolder } from './driver-lease-probe';

function workspace() {
  const dir = scratchDir('lease');
  const db = workspaceDatabase(join(dir, 'agent.db'));

  return { db, dir };
}

/** One process-shaped driver over a shared database; `alive` scripts which holders still run, the only OS fact the
 *  lease reads. */
function driver(db: Database, pid: number, alive: Set<number>, kind: DriverKind): DriverLeaseHold {
  const proc: LeaseProcess = { pid, generation: '', isAlive: (holder) => alive.has(holder.pid) };

  return new DriverLeaseHold({ sql: makeSql(db), execRaw: makeExecRaw(db), proc }, kind);
}

describe('the local driver lease', () => {
  test('an uncontended driver takes it, and the row names that process', () => {
    const { db } = workspace();

    try {
      const daemon = driver(db, 101, new Set([101]), 'daemon');
      expect(daemon.acquire()).toBeNull();
      expect(leaseHolder(db)).toEqual({ pid: 101, kind: 'daemon' });
      expect(daemon.held()).toBe(true);
    } finally {
      db.close();
    }
  });

  test('a daemon does NOT interrupt a live interactive owner, and the refusal names it', () => {
    const { db } = workspace();

    try {
      const alive = new Set([201, 202]);
      const owner = driver(db, 201, alive, 'interactive');
      expect(owner.acquire()).toBeNull();

      const refusal = driver(db, 202, alive, 'daemon').acquire();

      if (!refusal) throw new Error('a daemon must not preempt a live interactive owner');
      expect(refusal.holder).toEqual({ pid: 201, kind: 'interactive' });
      expect(refusal.refused.reason).toBe('unavailable');

      expect(owner.held()).toBe(true);
    } finally {
      db.close();
    }
  });

  test('an interactive process DOES take it from a live daemon', () => {
    const { db } = workspace();

    try {
      const alive = new Set([301, 302]);
      const daemon = driver(db, 301, alive, 'daemon');
      expect(daemon.acquire()).toBeNull();

      const user = driver(db, 302, alive, 'interactive');
      expect(user.acquire()).toBeNull();
      expect(leaseHolder(db)).toEqual({ pid: 302, kind: 'interactive' });
      expect(daemon.held()).toBe(false);
    } finally {
      db.close();
    }
  });

  test('an interactive driver takes it even when the daemon releases or re-takes it between its read and its write', () => {
    // A daemon releases and re-takes after every pass; a user's claim raced that.
    for (const move of ['released', 'retaken'] as const) {
      const { db } = workspace();

      try {
        const alive = new Set([311, 312]);
        const daemon = driver(db, 311, alive, 'daemon');
        expect(daemon.acquire()).toBeNull();
        const base = makeSql(db);
        let interleaved = false;

        const sql: SqlExecutor = <T,>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
          const rows = base<T>(strings, ...values);

          if (!interleaved && strings.join('?').startsWith('SELECT pid, generation, token, kind FROM driver_lease')) {
            interleaved = true;
            daemon.release();

            if (move === 'retaken') expect(daemon.acquire()).toBeNull();
          }

          return rows;
        };

        const user = new DriverLeaseHold({ sql, execRaw: makeExecRaw(db), proc: { pid: 312, generation: '', isAlive: (holder) => alive.has(holder.pid) } }, 'interactive');

        expect(user.acquire()).toBeNull();
        expect(leaseHolder(db)).toEqual({ pid: 312, kind: 'interactive' });
        expect(daemon.held()).toBe(false);
      } finally {
        db.close();
      }
    }
  });

  test('a dead holder yields to anyone, with no clock involved', () => {
    const { db } = workspace();

    try {
      const alive = new Set([401, 402]);
      const crashed = driver(db, 401, alive, 'interactive');
      expect(crashed.acquire()).toBeNull();

      const daemon = driver(db, 402, alive, 'daemon');
      expect(daemon.acquire()).not.toBeNull();

      // Nothing expired: the only change is that the pid no longer exists.
      alive.delete(401);
      const retry = daemon.acquire();

      if (retry) throw new Error(`a dead holder must yield: ${retry.refused.error}`);
      expect(leaseHolder(db)).toEqual({ pid: 402, kind: 'daemon' });
    } finally {
      db.close();
    }
  });

  test('release only matches its own token, so a preempted holder cannot evict its successor', () => {
    const { db } = workspace();

    try {
      const alive = new Set([501, 502]);
      const first = driver(db, 501, alive, 'daemon');
      expect(first.acquire()).toBeNull();
      const second = driver(db, 502, alive, 'interactive');
      expect(second.acquire()).toBeNull();

      // The stale token releases nothing; without the guard it would delete the live claim mid-turn.
      first.release();
      expect(leaseHolder(db)).toEqual({ pid: 502, kind: 'interactive' });
      expect(second.held()).toBe(true);

      second.release();
      expect(leaseHolder(db)).toBeNull();

      expect(driver(db, 501, alive, 'daemon').acquire()).toBeNull();
    } finally {
      db.close();
    }
  });

  test('re-acquiring in the same process keeps one claim rather than racing itself', () => {
    const { db } = workspace();

    try {
      const alive = new Set([601]);
      const me = driver(db, 601, alive, 'interactive');
      expect(me.acquire()).toBeNull();
      expect(me.acquire()).toBeNull();

      // Same-pid arm of the preemption rule: a driver meeting its own row never waits for itself.
      const again = driver(db, 601, alive, 'interactive');
      expect(again.acquire()).toBeNull();
      expect(again.held()).toBe(true);
      expect(leaseHolder(db)).toEqual({ pid: 601, kind: 'interactive' });
    } finally {
      db.close();
    }
  });

  test('two concurrent claimants over one database leave exactly one holder', () => {
    const { db } = workspace();

    try {
      const alive = new Set([701, 702]);
      // Both read an empty lease before either writes; the primary key and a re-read tell the loser it lost.
      const a = driver(db, 701, alive, 'daemon');
      const b = driver(db, 702, alive, 'daemon');
      const refusals = [a.acquire(), b.acquire()].filter((refusal) => refusal !== null);

      expect(refusals).toHaveLength(1);
      expect(a.held()).not.toBe(b.held());
      expect(leaseHolder(db)).toEqual(
        a.held() ? { pid: 701, kind: 'daemon' } : { pid: 702, kind: 'daemon' },
      );
    } finally {
      db.close();
    }
  });
});

describe('the lease asks the operating system whether its holder still runs', () => {
  /** A live process the test owns, standing for the holder's pid after the holder ended and the pid was reused. */
  async function withSleeper(body: (pid: number) => void): Promise<void> {
    const sleeper = Bun.spawn({ cmd: ['sleep', '120'], stdout: 'ignore', stderr: 'ignore' });

    try {
      body(sleeper.pid);
    } finally {
      sleeper.kill();
      await sleeper.exited;
    }
  }

  /** The lease taken in the name of `holder`, as the process it names took it. */
  function heldBy(db: Database, holder: LeaseProcess): void {
    expect(new DriverLeaseHold({ sql: makeSql(db), execRaw: makeExecRaw(db), proc: holder }, 'interactive').acquire()).toBeNull();
  }

  test('a holder whose pid a later process now runs holds nothing: the pid was reused', async () => {
    const { db } = workspace();

    try {
      await withSleeper((pid) => {
        heldBy(db, { ...osLeaseProcess(pid), generation: 'an-earlier-run' });

        expect(new DriverLeaseHold({ sql: makeSql(db), execRaw: makeExecRaw(db), proc: osLeaseProcess(process.pid) }, 'daemon').acquire())
          .toBeNull();
        expect(leaseHolder(db)).toEqual({ pid: process.pid, kind: 'daemon' });
      });
    } finally {
      db.close();
    }
  });

  test('a holder still running the generation it recorded keeps the lease', async () => {
    const { db } = workspace();

    try {
      await withSleeper((pid) => {
        heldBy(db, osLeaseProcess(pid));

        const refusal = new DriverLeaseHold({ sql: makeSql(db), execRaw: makeExecRaw(db), proc: osLeaseProcess(process.pid) }, 'daemon')
          .acquire();

        expect(refusal?.holder).toEqual({ pid, kind: 'interactive' });
      });
    } finally {
      db.close();
    }
  });
});

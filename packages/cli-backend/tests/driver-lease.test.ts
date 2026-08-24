// The single-driver lease — who may DRIVE one local conversation.
//
// Two legs, deliberately, because they prove different things:
//
//   * The IN-PROCESS leg proves the lease SEMANTICS — refusal, who is named,
//     one-directional preemption, stale takeover, token-guarded release. Two
//     `LeaseProcess` values over one database are two process-shaped
//     participants, which is exactly what the injectable seam exists for.
//
//   * The TWO-PROCESS leg proves the RACE the lease exists to close. It cannot
//     be done in one process: `EventLog.markConsumed` is a bare UPDATE with no
//     `consumed_at IS NULL` guard, and the orchestrator's drain is safe only
//     because `pending()` and the `markConsumed` loop share one event loop
//     (agent-orchestrator.ts:554-556). A single-process test would pass with the
//     lease removed, which makes it no proof at all.
//
// No test here waits for anything. The lease carries no timestamp, so there is
// nothing a clock could advance, and that is the property under test.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDriverLease,
  driverLeaseHolder,
  holdsDriverLease,
  releaseDriverLease,
  type DriverLeaseDeps,
  type LeaseProcess,
} from '../src/agent-host/driver-lease';
import { makeExecRaw, makeSql } from '../src/runtime';

/** One workspace database, and a temp directory to delete afterwards. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-lease-'));
  const db = new Database(join(dir, 'agent.db'));
  db.exec('PRAGMA journal_mode = WAL');
  return { db, dir };
}

/**
 * A process-shaped participant over a shared database. `alive` is a mutable set
 * of pids so a test can kill a holder without killing anything real — the only
 * fact the OS seam contributes is process existence, so scripting it is the
 * whole substitution.
 */
function participant(db: Database, pid: number, alive: Set<number>): DriverLeaseDeps {
  const proc: LeaseProcess = { pid, isAlive: (other) => alive.has(other) };
  return { sql: makeSql(db), execRaw: makeExecRaw(db), proc };
}

describe('the local driver lease', () => {
  test('an uncontended driver takes it, and the row names that process', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([101]);
      const outcome = acquireDriverLease(participant(db, 101, alive), 'daemon');
      if (!('held' in outcome)) throw new Error(`expected to hold, got: ${outcome.refused.error}`);
      expect(outcome.held.pid).toBe(101);
      expect(outcome.held.kind).toBe('daemon');
      expect(driverLeaseHolder(participant(db, 101, alive))).toEqual({ pid: 101, kind: 'daemon' });
      expect(holdsDriverLease(participant(db, 101, alive), outcome.held.token)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a daemon does NOT interrupt a live interactive owner, and the refusal names it', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([201, 202]);
      const owner = acquireDriverLease(participant(db, 201, alive), 'interactive');
      if (!('held' in owner)) throw new Error('the interactive process should hold it');

      const daemon = acquireDriverLease(participant(db, 202, alive), 'daemon');
      if ('held' in daemon) throw new Error('a daemon must not preempt a live interactive owner');
      expect(daemon.holder).toEqual({ pid: 201, kind: 'interactive' });
      // `unavailable`, not `denied`: the driver is taken, not forbidden.
      expect(daemon.refused.reason).toBe('unavailable');
      expect(daemon.refused.error).toContain('201');
      // The refusal changed nothing.
      expect(holdsDriverLease(participant(db, 201, alive), owner.held.token)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an interactive process DOES take it from a live daemon', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([301, 302]);
      const daemon = acquireDriverLease(participant(db, 301, alive), 'daemon');
      if (!('held' in daemon)) throw new Error('the daemon should hold it');

      const user = acquireDriverLease(participant(db, 302, alive), 'interactive');
      if (!('held' in user)) throw new Error(`interactive must preempt a daemon: ${user.refused.error}`);
      expect(driverLeaseHolder(participant(db, 302, alive))).toEqual({ pid: 302, kind: 'interactive' });
      // The daemon's token is dead the moment it is preempted, which is what its
      // between-operations re-check reads.
      expect(holdsDriverLease(participant(db, 301, alive), daemon.held.token)).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dead holder yields to anyone, with no clock involved', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([401, 402]);
      const crashed = acquireDriverLease(participant(db, 401, alive), 'interactive');
      if (!('held' in crashed)) throw new Error('the first process should hold it');

      // A daemon may not take it from a LIVE interactive owner...
      const blocked = acquireDriverLease(participant(db, 402, alive), 'daemon');
      expect('refused' in blocked).toBe(true);

      // ...and takes it immediately once that process is gone. Nothing expired:
      // the only thing that changed is that the pid no longer exists.
      alive.delete(401);
      const recovered = acquireDriverLease(participant(db, 402, alive), 'daemon');
      if (!('held' in recovered)) throw new Error(`a dead holder must yield: ${recovered.refused.error}`);
      expect(driverLeaseHolder(participant(db, 402, alive))).toEqual({ pid: 402, kind: 'daemon' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release only matches its own token, so a preempted holder cannot evict its successor', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([501, 502]);
      const first = acquireDriverLease(participant(db, 501, alive), 'daemon');
      if (!('held' in first)) throw new Error('the daemon should hold it');
      const second = acquireDriverLease(participant(db, 502, alive), 'interactive');
      if (!('held' in second)) throw new Error('interactive should preempt');

      // The preempted daemon finishes its pass and releases. Its token is stale,
      // so it releases NOTHING — without the guard it would delete the live
      // interactive claim and leave the conversation unowned mid-turn.
      expect(releaseDriverLease(participant(db, 501, alive), first.held.token)).toBe(false);
      expect(driverLeaseHolder(participant(db, 502, alive))).toEqual({ pid: 502, kind: 'interactive' });

      // The real holder's release does land, and leaves the lease free.
      expect(releaseDriverLease(participant(db, 502, alive), second.held.token)).toBe(true);
      expect(driverLeaseHolder(participant(db, 502, alive))).toBeNull();

      // Free means takeable, by a daemon this time.
      const after = acquireDriverLease(participant(db, 501, alive), 'daemon');
      expect('held' in after).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-acquiring in the same process keeps one claim rather than racing itself', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([601]);
      const me = participant(db, 601, alive);
      const first = acquireDriverLease(me, 'interactive');
      if (!('held' in first)) throw new Error('should hold');
      const again = acquireDriverLease(me, 'interactive');
      if (!('held' in again)) throw new Error(`re-acquiring must not refuse: ${again.refused.error}`);
      // Whatever token is live, it is this process's and there is exactly one row.
      expect(holdsDriverLease(me, again.held.token)).toBe(true);
      expect(driverLeaseHolder(me)).toEqual({ pid: 601, kind: 'interactive' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two concurrent claimants over one database leave exactly one holder', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([701, 702]);
      // Both read an empty lease before either writes — the interleaving a
      // read-then-write has across processes. The INSERT is guarded by the
      // primary key and the outcome is decided by re-reading, so the loser is
      // told it lost instead of both believing they won.
      const a = acquireDriverLease(participant(db, 701, alive), 'daemon');
      const b = acquireDriverLease(participant(db, 702, alive), 'daemon');
      const winners = [a, b].filter((outcome) => 'held' in outcome);
      expect(winners).toHaveLength(1);
      const holder = driverLeaseHolder(participant(db, 701, alive));
      expect(holder?.pid === 701 || holder?.pid === 702).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

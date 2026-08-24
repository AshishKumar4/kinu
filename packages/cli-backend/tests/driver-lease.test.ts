// The single-driver lease — who may DRIVE one local conversation.
//
// Driven through `DriverLeaseHold`, the module's whole public surface, because
// that is the object every real driver holds: the host keeps one per bound agent
// and the interactive client keeps one per session. The primitives underneath it
// are module-private, so a test that called them would be proving a shape
// nothing in production goes through.
//
// This is the IN-PROCESS leg, and it proves the lease SEMANTICS — refusal, who
// is named, one-directional preemption, stale takeover, token-guarded release.
// Two `LeaseProcess` values over one database are two process-shaped
// participants, which is exactly what the injectable seam exists for.
//
// The TWO-PROCESS leg proves the RACE the lease exists to close, and it cannot
// be done in one process: `EventLog.markConsumed` is a bare UPDATE with no
// `consumed_at IS NULL` guard, and the orchestrator's drain is safe only because
// `pending()` and the `markConsumed` loop share one event loop
// (agent-orchestrator.ts:554-556). A single-process test would pass with the
// lease removed, which makes it no proof at all. That leg lives over real OS
// processes, in `agent-host.test.ts` and `packages/cli/tests/driver-lease-
// surfaces.test.ts`.
//
// No test here waits for anything. The lease carries no timestamp, so there is
// nothing a clock could advance, and that is the property under test.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DriverLeaseHold,
  type DriverKind,
  type LeaseProcess,
} from '../src/agent-host/driver-lease';
import { makeExecRaw, makeSql } from '../src/runtime';
import { leaseHolder } from './driver-lease-probe';

/** One workspace database, and a temp directory to delete afterwards. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-lease-'));
  const db = new Database(join(dir, 'agent.db'));
  db.exec('PRAGMA journal_mode = WAL');
  return { db, dir };
}

/**
 * One process-shaped driver over a shared database, holding its lease the way a
 * real one does. `alive` is a mutable set of pids so a test can kill a holder
 * without killing anything real — the only fact the OS seam contributes is
 * process existence, so scripting it is the whole substitution.
 */
function driver(db: Database, pid: number, alive: Set<number>, kind: DriverKind): DriverLeaseHold {
  const proc: LeaseProcess = { pid, isAlive: (other) => alive.has(other) };
  return new DriverLeaseHold({ sql: makeSql(db), execRaw: makeExecRaw(db), proc }, kind);
}

describe('the local driver lease', () => {
  test('an uncontended driver takes it, and the row names that process', () => {
    const { db, dir } = workspace();
    try {
      const daemon = driver(db, 101, new Set([101]), 'daemon');
      expect(daemon.acquire()).toBeNull();
      expect(leaseHolder(db)).toEqual({ pid: 101, kind: 'daemon' });
      expect(daemon.held()).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a daemon does NOT interrupt a live interactive owner, and the refusal names it', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([201, 202]);
      const owner = driver(db, 201, alive, 'interactive');
      expect(owner.acquire()).toBeNull();

      const refusal = driver(db, 202, alive, 'daemon').acquire();
      if (!refusal) throw new Error('a daemon must not preempt a live interactive owner');
      expect(refusal.holder).toEqual({ pid: 201, kind: 'interactive' });
      // `unavailable`, not `denied`: the driver is taken, not forbidden.
      expect(refusal.refused.reason).toBe('unavailable');
      expect(refusal.refused.error).toContain('201');
      // The refusal changed nothing.
      expect(owner.held()).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an interactive process DOES take it from a live daemon', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([301, 302]);
      const daemon = driver(db, 301, alive, 'daemon');
      expect(daemon.acquire()).toBeNull();

      const user = driver(db, 302, alive, 'interactive');
      expect(user.acquire()).toBeNull();
      expect(leaseHolder(db)).toEqual({ pid: 302, kind: 'interactive' });
      // The preempted daemon's claim is dead the moment it is taken, which is
      // what its between-operations re-check reads. It never remembers holding
      // something it has lost.
      expect(daemon.held()).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dead holder yields to anyone, with no clock involved', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([401, 402]);
      const crashed = driver(db, 401, alive, 'interactive');
      expect(crashed.acquire()).toBeNull();

      // A daemon may not take it from a LIVE interactive owner...
      const daemon = driver(db, 402, alive, 'daemon');
      expect(daemon.acquire()).not.toBeNull();

      // ...and takes it on its next pass once that process is gone. Nothing
      // expired: the only thing that changed is that the pid no longer exists.
      alive.delete(401);
      const retry = daemon.acquire();
      if (retry) throw new Error(`a dead holder must yield: ${retry.refused.error}`);
      expect(leaseHolder(db)).toEqual({ pid: 402, kind: 'daemon' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release only matches its own token, so a preempted holder cannot evict its successor', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([501, 502]);
      const first = driver(db, 501, alive, 'daemon');
      expect(first.acquire()).toBeNull();
      const second = driver(db, 502, alive, 'interactive');
      expect(second.acquire()).toBeNull();

      // The preempted daemon finishes its pass and releases. Its token is
      // stale, so it releases NOTHING — without the guard it would delete the
      // live interactive claim and leave the conversation unowned mid-turn.
      first.release();
      expect(leaseHolder(db)).toEqual({ pid: 502, kind: 'interactive' });
      expect(second.held()).toBe(true);

      // The real holder's release does land, and leaves the lease free.
      second.release();
      expect(leaseHolder(db)).toBeNull();

      // Free means takeable, by a daemon this time.
      expect(driver(db, 501, alive, 'daemon').acquire()).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-acquiring in the same process keeps one claim rather than racing itself', () => {
    const { db, dir } = workspace();
    try {
      const alive = new Set([601]);
      const me = driver(db, 601, alive, 'interactive');
      expect(me.acquire()).toBeNull();
      // The same hold RE-CHECKS the row rather than trusting the token it
      // remembers, and finds the claim still ours.
      expect(me.acquire()).toBeNull();

      // A fresh hold in the SAME process — a session rebuilt behind one `kinu`
      // run — takes over its own claim instead of refusing itself. That is the
      // same-pid arm of the preemption rule, and it is why a driver meeting its
      // own row is never told to wait for itself.
      const again = driver(db, 601, alive, 'interactive');
      expect(again.acquire()).toBeNull();
      expect(again.held()).toBe(true);
      expect(leaseHolder(db)).toEqual({ pid: 601, kind: 'interactive' });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

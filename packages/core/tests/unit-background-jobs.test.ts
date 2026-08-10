// BackgroundJobStore + withBackgroundThreshold — the #173 background/async core.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackgroundJobStore, initBackgroundJobsTable, withBackgroundThreshold, isBackgroundHandle, serializeJobResult, BACKGROUND_POLICY } from '../src/jobs/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

function newStore() {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
  return new BackgroundJobStore(makeSql(db));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BackgroundJobStore', () => {
  test('create → running, settle → completed (idempotent)', () => {
    const s = newStore();
    s.create({ id: 'j1', kind: 'think', label: 'heads', now: 1 });
    expect(s.get('j1')?.status).toBe('running');
    expect(s.get('j1')?.epoch).toBe(0);
    s.settle('j1', 0, 'the result', 2);
    const j = s.get('j1');
    expect(j?.status).toBe('completed');
    expect(j?.result).toBe('the result');
    // A duplicate completion wake must NOT overwrite.
    s.settle('j1', 0, 'DIFFERENT', 3);
    expect(s.get('j1')?.result).toBe('the result');
    s.fail('j1', 0, 'late error', 4);
    expect(s.get('j1')?.status).toBe('completed');
  });

  test('fail marks failed; list reflects state', () => {
    const s = newStore();
    s.create({ id: 'a', kind: 'run', now: 1 });
    s.create({ id: 'b', kind: 'think', now: 2 });
    s.fail('a', 0, 'boom', 3);
    expect(s.get('a')?.status).toBe('failed');
    expect(s.get('a')?.error).toBe('boom');
    expect(s.list().length).toBe(2);
    expect(s.list().filter((j) => j.status === 'running').map((j) => j.id)).toEqual(['b']);
  });

  test('listRunning returns only in-flight jobs, newest first, capped', () => {
    // The dynamic-context roster reads this: `list` would let a settled backlog
    // crowd the still-running work out of the block entirely.
    const s = newStore();
    for (let i = 0; i < 5; i++) s.create({ id: `j${i}`, kind: 'run', now: i });
    s.settle('j1', 0, 'ok', 9);
    s.fail('j3', 0, 'boom', 9);
    expect(s.listRunning().map((j) => j.id)).toEqual(['j4', 'j2', 'j0']);
    expect(s.listRunning(2).map((j) => j.id)).toEqual(['j4', 'j2']);
  });

  test('cancel marks a running job cancelled; no-op once settled', () => {
    const s = newStore();
    s.create({ id: 'c', kind: 'think', now: 1 });
    s.cancel('c', 0, 2);
    expect(s.get('c')?.status).toBe('cancelled');
    expect(s.get('c')?.error).toMatch(/cancelled/i);
    // A settle after cancel must NOT revive it.
    s.settle('c', 0, 'late', 3);
    expect(s.get('c')?.status).toBe('cancelled');
  });

  test('lease-epoch fencing: a stale-epoch completion write is rejected, monotonic', () => {
    const s = newStore();
    s.create({ id: 'e', kind: 'think', now: 1 });
    expect(s.epochOf('e')).toBe(0);

    // Evict + recover: reclaim bumps the epoch (fences the dead executor) + attempts.
    const claim = s.reclaim('e');
    expect(claim).toEqual({ epoch: 1, attempts: 1 });
    expect(s.epochOf('e')).toBe(1);

    // The zombie executor from the dead process still holds epoch 0 → its settle is
    // a no-op: the job stays running under the new lease.
    s.settle('e', 0, 'zombie result', 3);
    expect(s.get('e')?.status).toBe('running');

    // The reclaiming executor writes under the current epoch → accepted.
    s.settle('e', 1, 'live result', 4);
    expect(s.get('e')?.status).toBe('completed');
    expect(s.get('e')?.result).toBe('live result');

    // Monotonic: a second reclaim would only ever raise the epoch — but a settled
    // job is no longer running, so reclaim declines it.
    expect(s.reclaim('e')).toBeNull();
  });

  test('reclaim bumps epoch + attempts monotonically across repeated eviction', () => {
    const s = newStore();
    s.create({ id: 'r', kind: 'think', now: 1 });
    expect(s.reclaim('r')).toEqual({ epoch: 1, attempts: 1 });
    expect(s.reclaim('r')).toEqual({ epoch: 2, attempts: 2 });
    expect(s.reclaim('r')).toEqual({ epoch: 3, attempts: 3 });
    expect(s.get('r')?.epoch).toBe(3);
    expect(s.get('r')?.resumeAttempts).toBe(3);
    expect(s.reclaim('missing')).toBeNull();
  });

  test('create stores input_json; getInput round-trips it for retry', () => {
    const s = newStore();
    s.create({ id: 'd', kind: 'execute_tools', input: '{"code":"1+1"}', now: 1 });
    expect(s.getInput('d')).toBe('{"code":"1+1"}');
    expect(s.getInput('missing')).toBeNull();
  });

  test('dismiss removes only settled jobs; clearSettled keeps running ones', () => {
    const s = newStore();
    s.create({ id: 'run1', kind: 'run', now: 1 });
    s.create({ id: 'done1', kind: 'think', now: 2 });
    s.settle('done1', 0, 'ok', 3);
    // Can't dismiss a running job.
    s.dismiss('run1');
    expect(s.get('run1')).not.toBeNull();
    s.dismiss('done1');
    expect(s.get('done1')).toBeNull();
    // clearSettled drops settled, keeps running.
    s.create({ id: 'done2', kind: 'think', now: 4 }); s.fail('done2', 0, 'x', 5);
    s.clearSettled();
    expect(s.get('done2')).toBeNull();
    expect(s.get('run1')?.status).toBe('running');
  });
});

describe('serializeJobResult', () => {
  test('serializes plain values to JSON', () => {
    expect(serializeJobResult({ ok: true, n: 3 })).toBe('{"ok":true,"n":3}');
    expect(serializeJobResult('hi')).toBe('"hi"');
    expect(serializeJobResult(null)).toBe('null');
    expect(serializeJobResult(undefined)).toBe('null');
  });

  test('non-serializable success (BigInt) is String()-coerced, never thrown', () => {
    // A backgrounded execute_tools can resolve a BigInt — JSON.stringify throws
    // on it; the helper must degrade to a string so settle() still records it.
    expect(serializeJobResult(10n)).toBe('10');
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(typeof serializeJobResult(circular)).toBe('string');
  });

  test('truncates oversized results with a marker', () => {
    const big = 'x'.repeat(40_000);
    const out = serializeJobResult(big, 16_000);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[truncated');
  });
});

describe('withBackgroundThreshold', () => {
  test('fast work returns its result inline — no job created', async () => {
    let crossings = 0;
    const out = await withBackgroundThreshold('think', async () => 'fast-result', {
      thresholdMs: 1000,
      onThreshold: () => { crossings++; return { detached: true, jobId: 'jX' }; },
    });
    expect(out).toBe('fast-result');
    expect(crossings).toBe(0);
  });

  test('slow work returns a BackgroundHandle + detaches the live promise', async () => {
    let detachedPromise: Promise<unknown> | null = null;
    const out = await withBackgroundThreshold('heads', async () => { await delay(80); return 'slow-result'; }, {
      thresholdMs: 20,
      onThreshold: (_kind, p) => { detachedPromise = p; return { detached: true, jobId: 'job-7' }; },
    });
    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) { expect(out.jobId).toBe('job-7'); expect(out.kind).toBe('heads'); }
    // The detached promise is the SAME live work and still resolves.
    await expect(detachedPromise).resolves.toBe('slow-result');
  });

  test('a refused detach returns the refusal to the model, not a handle', async () => {
    const out = await withBackgroundThreshold('run', async () => { await delay(80); return 'never read'; }, {
      thresholdMs: 20,
      onThreshold: () => ({ detached: false, reason: 'too many jobs already running' }),
    });
    expect(isBackgroundHandle(out)).toBe(false);
    expect(out).toEqual({ background: false, kind: 'run', message: 'too many jobs already running' });
  });

  test('fast rejection propagates inline (no background)', async () => {
    await expect(withBackgroundThreshold('run', async () => { throw new Error('quick fail'); }, {
      thresholdMs: 1000,
      onThreshold: () => { throw new Error('should not detach'); },
    })).rejects.toThrow('quick fail');
  });

  test('the default threshold is the interactive policy', async () => {
    // No thresholdMs: a caller that does not state a surface gets the one a
    // human is waiting on, never an unbounded inline wait.
    expect(BACKGROUND_POLICY.interactive.detachAfterMs).toBe(30_000);
    const out = await withBackgroundThreshold('run', async () => 'inline', {
      onThreshold: () => { throw new Error('should not detach'); },
    });
    expect(out).toBe('inline');
  });
});

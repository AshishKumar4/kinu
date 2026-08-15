// BackgroundJobStore + withBackgroundThreshold — the #173 background/async core.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BackgroundJobStore, initBackgroundJobsTable, withBackgroundThreshold, withSpawnDetach,
  isBackgroundHandle, serializeJobResult, BACKGROUND_POLICY, readSpawnStarted, SPAWN_STARTED_OPTION,
} from '../src/jobs/index.js';
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
    s.create({ id: 'j1', kind: 'think', workMode: 'build', label: 'heads', now: 1 });
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
    s.create({ id: 'a', kind: 'run', workMode: 'build', now: 1 });
    s.create({ id: 'b', kind: 'think', workMode: 'build', now: 2 });
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
    for (let i = 0; i < 5; i++) s.create({ id: `j${i}`, kind: 'run', workMode: 'build', now: i });
    s.settle('j1', 0, 'ok', 9);
    s.fail('j3', 0, 'boom', 9);
    expect(s.listRunning().map((j) => j.id)).toEqual(['j4', 'j2', 'j0']);
    expect(s.listRunning(2).map((j) => j.id)).toEqual(['j4', 'j2']);
  });

  test('cancel marks a running job cancelled; no-op once settled', () => {
    const s = newStore();
    s.create({ id: 'c', kind: 'think', workMode: 'build', now: 1 });
    s.cancel('c', 0, 2);
    expect(s.get('c')?.status).toBe('cancelled');
    expect(s.get('c')?.error).toMatch(/cancelled/i);
    // A settle after cancel must NOT revive it.
    s.settle('c', 0, 'late', 3);
    expect(s.get('c')?.status).toBe('cancelled');
  });

  test('lease-epoch fencing: a stale-epoch completion write is rejected, monotonic', () => {
    const s = newStore();
    s.create({ id: 'e', kind: 'think', workMode: 'build', now: 1 });
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
    s.create({ id: 'r', kind: 'think', workMode: 'build', now: 1 });
    expect(s.reclaim('r')).toEqual({ epoch: 1, attempts: 1 });
    expect(s.reclaim('r')).toEqual({ epoch: 2, attempts: 2 });
    expect(s.reclaim('r')).toEqual({ epoch: 3, attempts: 3 });
    expect(s.get('r')?.epoch).toBe(3);
    expect(s.get('r')?.resumeAttempts).toBe(3);
    expect(s.reclaim('missing')).toBeNull();
  });

  test('create stores input_json; getInput round-trips it for retry', () => {
    const s = newStore();
    s.create({ id: 'd', kind: 'execute_tools', workMode: 'build', input: '{"code":"1+1"}', now: 1 });
    expect(s.getInput('d')).toBe('{"code":"1+1"}');
    expect(s.getInput('missing')).toBeNull();
  });

  test('dismiss removes only settled jobs; clearSettled keeps running ones', () => {
    const s = newStore();
    s.create({ id: 'run1', kind: 'run', workMode: 'build', now: 1 });
    s.create({ id: 'done1', kind: 'think', workMode: 'build', now: 2 });
    s.settle('done1', 0, 'ok', 3);
    // Can't dismiss a running job.
    s.dismiss('run1');
    expect(s.get('run1')).not.toBeNull();
    s.dismiss('done1');
    expect(s.get('done1')).toBeNull();
    // clearSettled drops settled, keeps running.
    s.create({ id: 'done2', kind: 'think', workMode: 'build', now: 4 }); s.fail('done2', 0, 'x', 5);
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
    interface CircularValue { self?: CircularValue }
    const circular: CircularValue = {};
    circular.self = circular;
    expect(serializeJobResult(circular)).toBe('[object Object]');
  });

  test('an oversize result is stored whole — the wake message promises the full result', () => {
    const big = 'x'.repeat(40_000);
    expect(serializeJobResult(big)).toBe(JSON.stringify(big));
  });

  test('an oversize input survives a JSON.parse round-trip — resume depends on it', () => {
    const input = { code: 'y'.repeat(20_000) };
    expect(JSON.parse(serializeJobResult(input))).toEqual(input);
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
    const detached: Array<Promise<unknown>> = [];
    const out = await withBackgroundThreshold('heads', async () => { await delay(80); return 'slow-result'; }, {
      thresholdMs: 20,
      onThreshold: (_kind, p) => { detached.push(p); return { detached: true, jobId: 'job-7' }; },
    });
    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) { expect(out.jobId).toBe('job-7'); expect(out.kind).toBe('heads'); }
    // The detached promise is the SAME live work and still resolves.
    await expect(detached[0]).resolves.toBe('slow-result');
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

describe('withSpawnDetach — defect A: spawn-shaped work detaches on start, never on a timer', () => {
  test('a fork whose spawn is confirmed detaches immediately, well under the 30s interactive threshold — the exploration itself takes far longer and never blocks the caller', async () => {
    const started = performance.now();
    const detached: Array<Promise<unknown>> = [];
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      // The spawn is validated fast; the actual exploration is what's slow.
      // Structured so the announce fires promptly, well inside a real 30s
      // interactive threshold, and the exploration itself runs long after.
      spawnStarted();
      await delay(80);
      return 'merged fork answer';
    }, {
      onThreshold: (_kind, p) => { detached.push(p); return { detached: true, jobId: 'job-fork-1' }; },
    });
    const elapsedMs = performance.now() - started;

    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) {
      expect(out.jobId).toBe('job-fork-1');
      expect(out.kind).toBe('agents');
      // The old behaviour rode the fixed 30s interactive threshold; the fix
      // detaches the instant the spawn confirms — no dead-air wait in chat.
      expect(elapsedMs).toBeLessThan(1000);
    }
    // The detached promise is the SAME live exploration and still resolves.
    await expect(detached[0]).resolves.toBe('merged fork answer');
  });

  test('a call that settles WITHOUT ever announcing a spawn returns inline — a validation error never detaches', async () => {
    let crossings = 0;
    const out = await withSpawnDetach('agents', async () => 'fast validation error', {
      onThreshold: () => { crossings++; return { detached: true, jobId: 'unused' }; },
    });
    expect(out).toBe('fast validation error');
    expect(crossings).toBe(0);
  });

  test('a rejection before the spawn announces propagates inline, not as a background failure', async () => {
    await expect(withSpawnDetach('agents', async () => { throw new Error('bad fork input'); }, {
      onThreshold: () => { throw new Error('should not detach'); },
    })).rejects.toThrow('bad fork input');
  });

  test('a refused detach (concurrency cap) returns the refusal, not a handle', async () => {
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      spawnStarted();
      await delay(50);
      return 'never read';
    }, {
      onThreshold: () => ({ detached: false, reason: 'too many jobs already running' }),
    });
    expect(isBackgroundHandle(out)).toBe(false);
    expect(out).toEqual({ background: false, kind: 'agents', message: 'too many jobs already running' });
  });

  test('the detach message promises a wake and tells the model not to poll or re-spawn', async () => {
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      spawnStarted();
      await delay(20);
      return 'x';
    }, {
      onThreshold: () => ({ detached: true, jobId: 'job-9' }),
    });
    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) {
      expect(out.message).toContain('job-9');
      expect(out.message).toMatch(/woken/i);
      expect(out.message).toMatch(/do not (check|spawn)/i);
    }
  });
});

describe('readSpawnStarted — the announce callback the background wrapper arms', () => {
  test('reads the callback off the options bag when present', () => {
    let fired = false;
    const announce = () => { fired = true; };
    const fn = readSpawnStarted({ [SPAWN_STARTED_OPTION]: announce });
    expect(fn).toBe(announce);
    fn?.();
    expect(fired).toBe(true);
  });

  test('is undefined on an inline surface that armed nothing — codemode, resume, eval', () => {
    expect(readSpawnStarted(undefined)).toBeUndefined();
    expect(readSpawnStarted({})).toBeUndefined();
    expect(readSpawnStarted({ toolCallId: 'call-1', messages: [] })).toBeUndefined();
    expect(readSpawnStarted(null)).toBeUndefined();
  });
});

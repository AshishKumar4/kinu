// BackgroundJobStore + withBackgroundThreshold — the #173 background/async core.
import { describe, test, expect } from 'bun:test';
import { DELEGATION_RUNGS } from '../src/tools/registry';
import { Database } from 'bun:sqlite';
import {
  BackgroundJobStore, initBackgroundJobsTable, withBackgroundThreshold, withSpawnDetach,
  isBackgroundHandle, serializeJobResult, BACKGROUND_POLICY, readSpawnStarted, SPAWN_STARTED_OPTION,
} from '../src/jobs/index';
import { makeSql, makeExecRaw } from './helpers';

function newStore() {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
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
    expect(s.listRunning().items.map((j) => j.id)).toEqual(['j4', 'j2', 'j0']);
    expect(s.listRunning().total).toBe(3);
    // The bound cuts the PAGE, never the count: the renderer's elision line
    // is computed from `total`, so it stays honest past the cap.
    const capped = s.listRunning(2);
    expect(capped.items.map((j) => j.id)).toEqual(['j4', 'j2']);
    expect(capped.total).toBe(3);
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

  test('the armed next attempt is a column: written, read back, and cleared by the claim that serves it', () => {
    const s = newStore();
    s.create({ id: 'w', kind: 'agents', workMode: 'build', now: 1 });
    expect(s.get('w')?.resumeAfter).toBeNull();
    expect(s.nextResumeAt()).toBeNull();

    s.deferResume('w', 5_000);
    expect(s.get('w')?.resumeAfter).toBe(5_000);
    expect(s.nextResumeAt()).toBe(5_000);
    expect(s.listRunning().items[0]?.resumeAfter).toBe(5_000);
    expect(s.list()[0]?.resumeAfter).toBe(5_000);

    // The claim SERVES the wait, so it clears it — and arms nothing by itself.
    expect(s.reclaim('w', 6_000)).toEqual({ epoch: 1, attempts: 1 });
    expect(s.get('w')?.resumeAfter).toBeNull();
    expect(s.nextResumeAt()).toBeNull();
  });

  test('a wait is only ever owed by a RUNNING job', () => {
    const s = newStore();
    s.create({ id: 'settled', kind: 'agents', workMode: 'build', now: 1 });
    s.settle('settled', 0, '"done"', 2);
    // A settled row must not become work the next sweep thinks is still coming.
    s.deferResume('settled', 9_000);
    expect(s.get('settled')?.resumeAfter).toBeNull();
    expect(s.nextResumeAt()).toBeNull();
  });

  test('resumeOwedIds names only the jobs whose next attempt is still in the future', () => {
    const s = newStore();
    for (const id of ['due', 'waiting', 'never']) {
      s.create({ id, kind: 'agents', workMode: 'build', now: 1 });
    }
    s.deferResume('due', 1_000);
    s.deferResume('waiting', 10_000);

    expect(s.resumeOwedIds(5_000)).toEqual(['waiting']);
    expect(s.resumeOwedIds(50_000)).toEqual([]);
    // The soonest instant is what a caller arms its one wake for.
    expect(s.nextResumeAt()).toBe(1_000);
  });

  test('create stores input_json; getInput round-trips it for retry', () => {
    const s = newStore();
    s.create({ id: 'd', kind: 'execute_tools', workMode: 'build', input: '{"code":"1+1"}', now: 1 });
    expect(s.getInput('d')).toBe('{"code":"1+1"}');
    expect(s.getInput('missing')).toBeNull();
  });

  test('replacement creation and retry lineage are one durable write', () => {
    const s = newStore();
    s.create({ id: 'failed', kind: 'run', workMode: 'build', input: '{}', now: 1 });
    s.fail('failed', 0, 'boom', 2);
    expect(s.createRetry({
      sourceId: 'failed', id: 'replacement-1', kind: 'run',
      workMode: 'build', input: '{}', now: 3,
    })).toBe(true);
    expect(s.createRetry({
      sourceId: 'failed', id: 'replacement-2', kind: 'run',
      workMode: 'build', input: '{}', now: 4,
    })).toBe(false);
    expect(s.get('failed')?.retriedBy).toBe('replacement-1');
    expect(s.get('replacement-1')?.status).toBe('running');
    expect(s.get('replacement-2')).toBeNull();
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

  test('non-serializable success (BigInt) degrades to a named reason, never thrown', () => {
    // A backgrounded execute_tools can resolve a BigInt — JSON.stringify throws
    // on it; the helper must degrade to a string that says so and carries the
    // thrown reason, so settle() still records it.
    expect(serializeJobResult(10n)).toMatch(/^unserializable job result: /);
    interface CircularValue { self?: CircularValue }
    const circular: CircularValue = {};
    circular.self = circular;
    expect(serializeJobResult(circular)).toMatch(/^unserializable job result: /);
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

  test('a refused detach keeps the same live work foreground-owned through completion', async () => {
    const out = await withBackgroundThreshold('run', async () => {
      await delay(80);
      return 'completed after the capacity refusal';
    }, {
      thresholdMs: 20,
      onThreshold: () => ({ detached: false, reason: 'too many jobs already running' }),
    });
    expect(out).toBe('completed after the capacity refusal');
  });

  test('a refused detach preserves a later tool failure', async () => {
    await expect(withBackgroundThreshold('run', async () => {
      await delay(40);
      throw new Error('failed after the capacity refusal');
    }, {
      thresholdMs: 20,
      onThreshold: () => ({ detached: false, reason: 'too many jobs already running' }),
    })).rejects.toThrow('failed after the capacity refusal');
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
    const detached: Array<Promise<unknown>> = [];
    let explored = false;
    let exploringAtDetach: boolean | undefined;
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      // The spawn is validated fast; the actual exploration is what's slow.
      spawnStarted();
      await delay(80);
      explored = true;
      return 'merged fork answer';
    }, {
      onThreshold: (_kind, p) => {
        exploringAtDetach = !explored;
        detached.push(p);
        return { detached: true, jobId: 'job-fork-1' };
      },
    });

    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) {
      expect(out.jobId).toBe('job-fork-1');
      expect(out.kind).toBe('agents');
    }
    // The detach came from the spawn announce while the exploration was still
    // running; the old behaviour rode the 30 s interactive threshold, long after
    // it had settled. An ordering, not a wall-clock bound, so scheduler latency
    // under load cannot fail it.
    expect(exploringAtDetach).toBe(true);
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

  test('a refused detach keeps the spawned work foreground-owned through completion', async () => {
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      spawnStarted();
      await delay(50);
      return 'completed after the capacity refusal';
    }, {
      onThreshold: () => ({ detached: false, reason: 'too many jobs already running' }),
    });
    expect(out).toBe('completed after the capacity refusal');
  });

  // The wake promise lives in the runtime message; the never-poll doctrine
  // lives ONCE, in the agents docstring the model reads at every step. The
  // old assertion pinned ~70 tokens of that doctrine repeated per spawn.
  test('the detach message is terse and promises the wake; the docstring carries the doctrine', async () => {
    const out = await withSpawnDetach('agents', async (spawnStarted) => {
      spawnStarted();
      await delay(20);
      return 'x';
    }, {
      onThreshold: () => ({ detached: true, jobId: 'job-9' }),
    });
    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) {
      expect(out.jobId).toBe('job-9');
      expect(out.message).toMatch(/wake/i);
      expect(out.message.length).toBeLessThan(80);
    }
    const rung = Object.values(DELEGATION_RUNGS).join(' ');
    expect(rung).toContain('never poll a backgrounded job or spawn it twice');
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

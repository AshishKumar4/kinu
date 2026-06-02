// BackgroundJobStore + withBackgroundThreshold — the #173 background/async core.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackgroundJobStore, initBackgroundJobsTable, withBackgroundThreshold, isBackgroundHandle } from '../src/jobs/index.js';
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
    s.settle('j1', 'the result', 2);
    const j = s.get('j1');
    expect(j?.status).toBe('completed');
    expect(j?.result).toBe('the result');
    // A duplicate completion wake must NOT overwrite.
    s.settle('j1', 'DIFFERENT', 3);
    expect(s.get('j1')?.result).toBe('the result');
    s.fail('j1', 'late error', 4);
    expect(s.get('j1')?.status).toBe('completed');
  });

  test('fail marks failed; list + running reflect state', () => {
    const s = newStore();
    s.create({ id: 'a', kind: 'run', now: 1 });
    s.create({ id: 'b', kind: 'think', now: 2 });
    s.fail('a', 'boom', 3);
    expect(s.get('a')?.status).toBe('failed');
    expect(s.get('a')?.error).toBe('boom');
    expect(s.list().length).toBe(2);
    expect(s.running().map((j) => j.id)).toEqual(['b']); // only the unsettled one
  });
});

describe('withBackgroundThreshold', () => {
  test('fast work returns its result inline — no job created', async () => {
    let created = 0;
    const out = await withBackgroundThreshold('think', async () => 'fast-result', {
      thresholdMs: 1000,
      createJob: () => { created++; return 'jX'; },
      detach: () => { throw new Error('should not detach'); },
    });
    expect(out).toBe('fast-result');
    expect(created).toBe(0);
  });

  test('slow work returns a BackgroundHandle + detaches the live promise', async () => {
    let detachedJob: string | null = null;
    let detachedPromise: Promise<unknown> | null = null;
    const out = await withBackgroundThreshold('heads', async () => { await delay(80); return 'slow-result'; }, {
      thresholdMs: 20,
      createJob: () => 'job-7',
      detach: (id, p) => { detachedJob = id; detachedPromise = p; },
    });
    expect(isBackgroundHandle(out)).toBe(true);
    if (isBackgroundHandle(out)) { expect(out.jobId).toBe('job-7'); expect(out.kind).toBe('heads'); }
    expect(detachedJob).toBe('job-7');
    // The detached promise is the SAME live work and still resolves.
    await expect(detachedPromise).resolves.toBe('slow-result');
  });

  test('fast rejection propagates inline (no background)', async () => {
    await expect(withBackgroundThreshold('run', async () => { throw new Error('quick fail'); }, {
      thresholdMs: 1000,
      createJob: () => 'jZ',
      detach: () => { throw new Error('should not detach'); },
    })).rejects.toThrow('quick fail');
  });
});

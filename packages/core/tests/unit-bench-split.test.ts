import { describe, test, expect } from 'bun:test';
import {
  SEAL_SALT, DEFAULT_SEALED_FRACTION, splitOf, taskHash, manifestHash,
  partitionCorpus, promptLeaksFix, SealedSplit, validateWithRetries,
} from '../src/index.ts';
import type { BenchTask } from '../src/index.ts';

function task(id: string, overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    id,
    title: `title ${id}`,
    prompt: `fix ${id}`,
    editable: ['src/a.ts'],
    guarded: ['tests'],
    checks: [{ id: 'c', command: ['true'] }],
    ...overrides,
  };
}

describe('splitOf', () => {
  test('is deterministic and depends on the salt', () => {
    expect(splitOf('alpha')).toBe(splitOf('alpha'));
    const withOtherSalt = Array.from({ length: 40 }, (_, i) => splitOf(`t${i}`, 'other-salt'));
    const withDefault = Array.from({ length: 40 }, (_, i) => splitOf(`t${i}`, SEAL_SALT));
    expect(withOtherSalt).not.toEqual(withDefault);
  });

  test('a 0 or 1 fraction is honoured exactly', () => {
    for (let i = 0; i < 25; i++) {
      expect(splitOf(`t${i}`, SEAL_SALT, 0)).toBe('dev');
      expect(splitOf(`t${i}`, SEAL_SALT, 1)).toBe('sealed');
    }
  });

  test('lands near the requested fraction over many ids', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `task-${i}`);
    const sealed = ids.filter((id) => splitOf(id) === 'sealed').length;
    expect(Math.abs(sealed / ids.length - DEFAULT_SEALED_FRACTION)).toBeLessThan(0.05);
  });
});

describe('partitionCorpus', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(`task-${i}`));

  test('dev and sealed are disjoint and together cover the corpus', () => {
    const corpus = partitionCorpus(tasks);
    expect(corpus.dev.length + corpus.sealed.size).toBe(tasks.length);
    const devHashes = new Set(corpus.dev.map(taskHash));
    for (const fp of corpus.sealed.fingerprints()) expect(devHashes.has(fp)).toBe(false);
  });

  test('the dev split provably contains no sealed task', () => {
    const corpus = partitionCorpus(tasks);
    for (const t of corpus.dev) expect(splitOf(t.id)).toBe('dev');
  });

  test('duplicate ids are refused — a corpus with two of the same task is not a corpus', () => {
    expect(() => partitionCorpus([task('dup'), task('dup')])).toThrow(/duplicate/);
  });
});

describe('SealedSplit', () => {
  const sealedTasks = [task('s1'), task('s2'), task('s3'), task('s4'), task('s5'), task('s6')];

  test('evaluate returns aggregates and no per-task information', async () => {
    const split = new SealedSplit(sealedTasks);
    const card = await split.evaluate(async () => ({ a: [false], b: [true] }), { seed: 1, iterations: 500 });
    expect(card.tasks).toBe(6);
    expect(card.stats.onlyB).toBe(6);
    // The whole point: nothing task-identifying escapes.
    const serialized = JSON.stringify(card);
    for (const t of sealedTasks) {
      expect(serialized).not.toContain(t.id);
      expect(serialized).not.toContain(t.prompt);
    }
    expect(Object.keys(card).sort()).toEqual(['manifestHash', 'stats', 'tasks']);
  });

  test('tasks are not reachable from the instance', () => {
    const split = new SealedSplit(sealedTasks);
    expect(JSON.stringify(split)).not.toContain('s1');
    expect(Object.keys(split)).not.toContain('tasks');
  });

  test('evaluate carries every repeat through to pass^k', async () => {
    const split = new SealedSplit(sealedTasks);
    const card = await split.evaluate(
      async (t) => (t.id === 's1'
        ? { a: [false, false, false], b: [true, false, true] }
        : { a: [false, false, false], b: [true, true, true] }),
      { seed: 1, iterations: 500 },
    );
    expect(card.stats.repeats).toBe(3);
    expect(card.stats.passAtOneB).toBeCloseTo((2 / 3 + 5) / 6, 10);
    expect(card.stats.passAllB).toBeCloseTo(5 / 6, 10);
    // Instability is reported as a count, never as an id — the seal's rule.
    expect(card.stats.flakyB).toBe(1);
    expect(JSON.stringify(card)).not.toContain('s1');
  });

  test('a task that fails every attempt is BAD, not merely unlucky', async () => {
    let calls = 0;
    const result = await validateWithRetries(2, async () => {
      calls++;
      return { ok: false, detail: 'defect→PASS (breaks nothing)' };
    });
    expect(calls).toBe(3);
    expect(result).toEqual({
      ok: false, attempts: 3, passedOnAttempt: null,
      detail: 'failed all 3 attempt(s): defect→PASS (breaks nothing)',
    });
  });

  test('a task that fails once then passes is FLAKY — valid, and said so', async () => {
    const result = await validateWithRetries(2, async (attempt) => (attempt === 1
      ? { ok: false, detail: 'oracle→FAIL sandbox symlink' }
      : { ok: true, detail: 'defect trips core-tests, oracle restores it' }));
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.passedOnAttempt).toBe(2);
    // The operator learns BOTH that it validated and that it needed a retry.
    expect(result.detail).toContain('FLAKY');
    expect(result.detail).toContain('oracle→FAIL sandbox symlink');
  });

  test('a task that passes first time costs one attempt and reads as plain ok', async () => {
    let calls = 0;
    const result = await validateWithRetries(2, async () => {
      calls++;
      return { ok: true, detail: 'defect trips core-tests, oracle restores it' };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: true, attempts: 1, passedOnAttempt: 1,
      detail: 'defect trips core-tests, oracle restores it',
    });
  });

  test('zero retries is the old single-shot behaviour, and the budget is bounded', async () => {
    let calls = 0;
    const result = await validateWithRetries(0, async () => {
      calls++;
      return { ok: false, detail: 'nope' };
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(validateWithRetries(-1, async () => ({ ok: true, detail: '' })))
      .rejects.toThrow(/non-negative integer/);
  });

  test('validate reports which tasks are malformed and which are merely unstable', async () => {
    const split = new SealedSplit(sealedTasks);
    const result = await split.validate(async (t) => ({
      ok: t.id !== 's3',
      attempts: t.id === 's5' ? 2 : 1,
      passedOnAttempt: t.id === 's3' ? null : t.id === 's5' ? 2 : 1,
      detail: '',
    }));
    expect(result.checked).toBe(6);
    expect(result.invalid).toEqual(['s3']);
    // s5 validated, but only on a retry: valid corpus, unreliable task.
    expect(result.flaky).toEqual(['s5']);
  });
});

describe('manifest hashing', () => {
  test('is order-independent but content-sensitive', () => {
    const a = [task('x'), task('y')];
    const b = [task('y'), task('x')];
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(manifestHash([task('x'), task('y', { prompt: 'different' })])).not.toBe(manifestHash(a));
  });

  test('editing a held-out task changes the published hash', () => {
    const before = manifestHash([task('x'), task('y')]);
    const after = manifestHash([task('x'), task('y', { checks: [{ id: 'c', command: ['false'] }] })]);
    expect(after).not.toBe(before);
  });
});

describe('promptLeaksFix', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '-  return (1 - alpha) * oldScore + alpha * newObs;',
    '+  return alpha * oldScore + (1 - alpha) * newObs;',
  ].join('\n');

  test('catches a prompt that quotes the removed (correct) line', () => {
    expect(promptLeaksFix('just write return (1 - alpha) * oldScore + alpha * newObs; there', patch))
      .toBe('return (1 - alpha) * oldScore + alpha * newObs;');
  });

  test('is whitespace-insensitive', () => {
    expect(promptLeaksFix('return (1 - alpha)   *   oldScore + alpha * newObs;', patch)).not.toBeNull();
  });

  test('passes a prompt that only describes the symptom', () => {
    expect(promptLeaksFix('The EMA test fails; the update leans the wrong way.', patch)).toBeNull();
  });

  test('ignores the --- header and short lines', () => {
    const shortPatch = ['--- a/src/a.ts', '-  x = 1;'].join('\n');
    expect(promptLeaksFix('a/src/a.ts x = 1;', shortPatch)).toBeNull();
  });
});

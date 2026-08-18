/**
 * The classifier's patterns are only as good as the errors they were measured against, so this
 * suite re-provokes each failure from the engine that raises it — SQLite via bun:sqlite (the same
 * SQLite that backs Durable Object storage) and Node's fs/process — rather than asserting against
 * a hardcoded message. A SQLite or Node upgrade that reworded an error fails here, which is the
 * only way a pinned pattern stays honest.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

import { classify, tolerate, tolerateAsync, type ExpectedFailure } from '../src/obs/expected-failure';

/**
 * Runs `provoke` and returns the Error it raised. Every engine below raises an Error subclass, so
 * the helper narrows here rather than handing `unknown` back to each assertion.
 */
function thrown(provoke: () => void): Error {
  try {
    provoke();
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error(`expected an Error, got ${String(caught)}`, { cause: caught });
  }
  throw new Error('the operation did not fail, so there is nothing to classify');
}

describe('classify — provoked, not asserted from memory', () => {
  test('SQLite reports a missing table for both a read and an ALTER', () => {
    const db = new Database(':memory:');
    const read = thrown(() => db.query('SELECT token FROM workspace_capability LIMIT 1').all());
    const alter = thrown(() => db.run('ALTER TABLE workspace_capability ADD COLUMN token TEXT'));
    expect(classify({ cause: read })).toBe('sqlite-missing-table');
    expect(classify({ cause: alter })).toBe('sqlite-missing-table');
  });

  test('SQLite reports a duplicate column distinctly from a missing table', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT)');
    const duplicate = thrown(() => db.run('ALTER TABLE t ADD COLUMN a TEXT'));
    expect(classify({ cause: duplicate })).toBe('sqlite-duplicate-column');
  });

  test('RENAME TO onto an existing name is its own signature, not a duplicate column', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id TEXT)');
    db.run('CREATE TABLE u (id TEXT)');
    const collision = thrown(() => db.run('ALTER TABLE u RENAME TO t'));
    expect(classify({ cause: collision })).toBe('sqlite-table-exists');
  });

  test('a constraint violation is NOT tolerable and classifies as nothing', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.run(`INSERT INTO t (id) VALUES ('x')`);
    const violation = thrown(() => db.run(`INSERT INTO t (id) VALUES ('x')`));
    expect(classify({ cause: violation })).toBeNull();
  });

  test('Node reports an absent file and an absent process', () => {
    const absentFile = thrown(() => readFileSync('/proc/self/definitely-not-here-91827364'));
    expect(classify({ cause: absentFile })).toBe('enoent');
    const absentProcess = thrown(() => process.kill(0x7fffffff, 0));
    expect(classify({ cause: absentProcess })).toBe('esrch');
  });

  test('malformed untrusted input — bad JSON and a bad URL', () => {
    expect(classify({ cause: thrown(() => JSON.parse('{oops')) })).toBe('malformed-input');
    expect(classify({ cause: thrown(() => new URL('notaurl')) })).toBe('malformed-input');
  });

  test('a plain failure, a non-Error throw and a missing cause classify as nothing', () => {
    expect(classify({ cause: new Error('the disk is full') })).toBeNull();
    expect(classify({ cause: 'a string nobody should have thrown' })).toBeNull();
    expect(classify({ cause: undefined })).toBeNull();
  });
});

describe('tolerate', () => {
  test('returns the value when nothing fails', () => {
    expect(tolerate(() => 41 + 1, 'enoent')).toBe(42);
  });

  test('absorbs exactly the declared failure', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT)');
    expect(
      tolerate(() => db.run('ALTER TABLE t ADD COLUMN a TEXT'), 'sqlite-duplicate-column'),
    ).toBeUndefined();
  });

  test('propagates a failure of a DIFFERENT recognised kind — the workspace_capability defect', () => {
    const db = new Database(':memory:');
    // The read that hid `workspace_capability`: tolerating "the workspace holds no token" must not
    // also absorb "the table was never created", or the two become the same observation again.
    expect(() =>
      tolerate(
        () => db.query('SELECT token FROM workspace_capability LIMIT 1').all(),
        'sqlite-duplicate-column',
      ),
    ).toThrow(/no such table/u);
  });

  test('propagates an unrecognised failure unwrapped, preserving its identity', () => {
    const original = new TypeError('target is not a function');
    let seen: Error | null = null;
    try {
      tolerate(() => {
        throw original;
      }, 'enoent');
    } catch (caught) {
      seen = caught instanceof Error ? caught : null;
    }
    expect(seen).toBe(original);
  });

  test('every ExpectedFailure name is reachable from a real provoked error', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT)');
    db.run('CREATE TABLE u (id TEXT)');
    const provoked: Array<{ name: ExpectedFailure; cause: Error }> = [
      { name: 'sqlite-missing-table', cause: thrown(() => db.query('SELECT 1 FROM absent').all()) },
      { name: 'sqlite-duplicate-column', cause: thrown(() => db.run('ALTER TABLE t ADD COLUMN a TEXT')) },
      { name: 'sqlite-table-exists', cause: thrown(() => db.run('ALTER TABLE u RENAME TO t')) },
      { name: 'enoent', cause: thrown(() => readFileSync('/proc/self/absent-91827364')) },
      { name: 'esrch', cause: thrown(() => process.kill(0x7fffffff, 0)) },
      { name: 'malformed-input', cause: thrown(() => JSON.parse('{oops')) },
    ];
    // A registry whose names outnumber the errors anyone can provoke is a list of guesses. Asserting
    // the count here means adding a name without a provoked error fails this test.
    expect(provoked.length).toBe(6);
    for (const { name, cause } of provoked) {
      expect(classify({ cause })).toBe(name);
    }
  });
});

describe('tolerateAsync', () => {
  test('absorbs the declared rejection and propagates the rest', async () => {
    const absent = async (): Promise<string> => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    expect(await tolerateAsync(absent, 'enoent')).toBeUndefined();
    await expect(tolerateAsync(absent, 'esrch')).rejects.toThrow(/ENOENT/u);
  });

  test('awaits inside the try, so a rejection is caught rather than escaping', async () => {
    const rejects = async (): Promise<number> => {
      await Promise.resolve();
      throw new SyntaxError('bad payload');
    };
    expect(await tolerateAsync(rejects, 'malformed-input')).toBeUndefined();
  });
});

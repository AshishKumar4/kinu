import { describe, expect, test } from 'bun:test';
import { fakeStorage } from './support/devbox-harness';

describe('fake storage transactions hold the runtime contract', () => {
  test('a throw inside the frame discards its writes', async () => {
    const storage = fakeStorage();
    await expect(
      storage.handle.transaction(async (transaction) => {
        await transaction.put('devbox:candidate-control:bounded-layers', { version: 1 });
        throw new Error('head CAS lost its race');
      }),
    ).rejects.toThrow('head CAS lost its race');
    expect(storage.rows.has('devbox:candidate-control:bounded-layers')).toBe(false);
  });

  test('sequential read-modify-writes all commit', async () => {
    const storage = fakeStorage();
    await storage.handle.put('k', 'v0');
    for (const value of ['v1', 'v2', 'v3']) {
      await storage.handle.transaction(async (transaction) => {
        const seen = await transaction.get('k');
        if (seen === undefined) throw new Error('missing row');
        await transaction.put('k', value);
      });
    }
    expect(storage.rows.get('k')).toBe('v3');
  });

  test('disjoint concurrent writes both commit', async () => {
    const storage = fakeStorage();
    const first = storage.handle.transaction(async (transaction) => {
      await transaction.get('a');
      await transaction.put('a', '1');
    });
    const second = storage.handle.transaction(async (transaction) => {
      await transaction.get('b');
      await transaction.put('b', '2');
    });
    await Promise.all([first, second]);
    expect(storage.rows.get('a')).toBe('1');
    expect(storage.rows.get('b')).toBe('2');
  });

  test('a concurrent write to the same key fails the second committer', async () => {
    const storage = fakeStorage();
    await storage.handle.put('k', 'v0');
    const first = storage.handle.transaction(async (transaction) => {
      await transaction.get('k');
      await transaction.put('k', 'v1');
    });
    const second = storage.handle.transaction(async (transaction) => {
      await transaction.get('k');
      await transaction.put('k', 'v2');
    });
    await first;
    await expect(second).rejects.toThrow('transaction conflict');
    expect(storage.rows.get('k')).toBe('v1');
  });
});

// The tri-state fetch transitions every web-UI surface reads through: a
// failed fetch must stay distinguishable from an empty result.
import { describe, test, expect } from 'bun:test';
import {
  beginLoad, loadSucceeded, loadFailed, lastValue, describeError, mapResource,
  type AsyncResource,
} from '../src/hooks/use-async-resource';

const LOADING: AsyncResource<number[]> = { status: 'loading' };

describe('async resource transitions', () => {
  test('a fresh load is loading, not empty', () => {
    expect(beginLoad(LOADING)).toEqual({ status: 'loading' });
    expect(lastValue(LOADING)).toBeNull();
  });

  test('a failure is never an empty result', () => {
    const state = loadFailed(LOADING, { cause: new Error('boom') });
    expect(state.status).toBe('error');
    expect(state).toMatchObject({ message: 'boom', last: null });
    expect(lastValue(state)).toBeNull();
  });

  test('a failure carries the last loaded value so a blip cannot blank a view', () => {
    const ready = loadSucceeded([1, 2, 3]);
    const state = loadFailed(ready, { cause: new Error('offline') });
    expect(lastValue(state)).toEqual([1, 2, 3]);
    // …and keeps carrying it across a second failure.
    expect(lastValue(loadFailed(state, { cause: new Error('offline again') }))).toEqual([1, 2, 3]);
  });

  test('revalidating and retrying keep the last loaded value on screen', () => {
    expect(beginLoad(loadSucceeded([1]))).toEqual({ status: 'ready', value: [1] });
    expect(beginLoad(loadFailed(LOADING, { cause: 'nope' }))).toEqual({ status: 'loading' });
    const stale = loadFailed(loadSucceeded([1]), { cause: 'offline' });
    expect(beginLoad(stale)).toBe(stale);
    expect(lastValue(beginLoad(stale))).toEqual([1]);
  });

  test('a successful load clears the error', () => {
    const recovered = loadSucceeded<number[]>([]);
    expect(recovered).toEqual({ status: 'ready', value: [] });
    expect(lastValue(recovered)).toEqual([]);
  });

  test('error text survives non-Error rejections', () => {
    expect(describeError({ cause: new Error('rpc closed') })).toBe('rpc closed');
    expect(describeError({ cause: 'string reason' })).toBe('string reason');
    expect(describeError({ cause: new Error('') })).toBe('request failed');
    expect(describeError({ cause: undefined })).toBe('request failed');
    expect(describeError({ cause: { code: 500 } })).toBe('request failed');
  });

  test('a mapped resource keeps the read state and maps only what is on screen', () => {
    const lengths = (rows: number[]) => rows.length;

    expect(mapResource(loadSucceeded([1, 2, 3]), lengths)).toEqual({ status: 'ready', value: 3 });

    expect(mapResource(LOADING, lengths)).toEqual({ status: 'loading' });

    // A failure passes through with its message, but the stale value it still
    // carries is the mapped one — the view reads `last`, not the old shape.
    const stale = loadFailed(loadSucceeded([1, 2, 3]), { cause: new Error('offline') });
    expect(mapResource(stale, lengths)).toEqual({ status: 'error', message: 'offline', last: 3 });

    const cold = loadFailed<number[]>(LOADING, { cause: new Error('offline') });
    expect(mapResource(cold, lengths)).toEqual({ status: 'error', message: 'offline', last: null });
  });
});

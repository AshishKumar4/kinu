// The tri-state fetch transitions every web-UI surface reads through: a
// failed fetch must stay distinguishable from an empty result.
import { describe, test, expect } from 'bun:test';
import {
  beginLoad, loadSucceeded, loadFailed, lastValue, describeError,
  type AsyncResource,
} from '../src/hooks/use-async-resource.ts';

const LOADING: AsyncResource<number[]> = { status: 'loading' };

describe('async resource transitions', () => {
  test('a fresh load is loading, not empty', () => {
    expect(beginLoad(LOADING)).toEqual({ status: 'loading' });
    expect(lastValue(LOADING)).toBeNull();
  });

  test('a failure is never an empty result', () => {
    const state = loadFailed(LOADING, new Error('boom'));
    expect(state.status).toBe('error');
    expect(state).toMatchObject({ message: 'boom', last: null });
    expect(lastValue(state)).toBeNull();
  });

  test('a failure carries the last loaded value so a blip cannot blank a view', () => {
    const ready = loadSucceeded([1, 2, 3]);
    const state = loadFailed(ready, new Error('offline'));
    expect(lastValue(state)).toEqual([1, 2, 3]);
    // …and keeps carrying it across a second failure.
    expect(lastValue(loadFailed(state, new Error('offline again')))).toEqual([1, 2, 3]);
  });

  test('revalidating keeps a loaded value on screen; retrying after a failure does not', () => {
    expect(beginLoad(loadSucceeded([1]))).toEqual({ status: 'ready', value: [1] });
    expect(beginLoad(loadFailed(LOADING, 'nope'))).toEqual({ status: 'loading' });
  });

  test('a successful load clears the error', () => {
    const recovered = loadSucceeded<number[]>([]);
    expect(recovered).toEqual({ status: 'ready', value: [] });
    expect(lastValue(recovered)).toEqual([]);
  });

  test('error text survives non-Error rejections', () => {
    expect(describeError(new Error('rpc closed'))).toBe('rpc closed');
    expect(describeError('string reason')).toBe('string reason');
    expect(describeError(new Error(''))).toBe('request failed');
    expect(describeError(undefined)).toBe('request failed');
    expect(describeError({ code: 500 })).toBe('request failed');
  });
});

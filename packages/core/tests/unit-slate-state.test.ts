import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { KinuError, type ErrorCode } from '../src/obs/error';
import { initSlateStateTable, routeSlateStorageCall, SqliteSlateStateStore } from '../src/slates/state';
import type { JsonValue } from '../src/utils/json';
import { createTestWorkspace, makeSqlExec } from './helpers';

function storeOn(db: Database) {
  initSlateStateTable((ddl: string) => db.exec(ddl));

  return new SqliteSlateStateStore(makeSqlExec(db));
}

test('a slate value round-trips and a missing key answers null', () => {
  const ws = createTestWorkspace();

  try {
    const store = storeOn(ws.db);

    expect(store.get('notes', 'k')).toBeNull();
    store.put('notes', 'k', { a: 1 });
    expect(store.get('notes', 'k')).toEqual({ value: { a: 1 } });
    store.put('notes', 'k', 'again');
    expect(store.get('notes', 'k')).toEqual({ value: 'again' });
    // A second slate's keyspace is its own.
    expect(store.get('other', 'k')).toBeNull();
    expect(store.delete('notes', 'k')).toBe(true);
    expect(store.delete('notes', 'k')).toBe(false);
    expect(store.get('notes', 'k')).toBeNull();
  } finally {
    ws.db.close();
  }
});

test('list orders by key and a prefix bounds the range without a LIKE', () => {
  const ws = createTestWorkspace();

  try {
    const store = storeOn(ws.db);

    for (const [key, value] of [['cfg/b', 2], ['cfg/a', 1], ['cfg/c', 3], ['data', 4]] as const) {
      store.put('notes', key, value);
    }

    expect(store.list('notes', {})).toEqual([['cfg/a', 1], ['cfg/b', 2], ['cfg/c', 3], ['data', 4]]);
    expect(store.list('notes', { prefix: 'cfg/' })).toEqual([['cfg/a', 1], ['cfg/b', 2], ['cfg/c', 3]]);
    // A prefix that is itself a key keeps it, and a LIKE metacharacter is literal.
    store.put('notes', 'cfg', 0);
    expect(store.list('notes', { prefix: 'cfg' })).toEqual([['cfg', 0], ['cfg/a', 1], ['cfg/b', 2], ['cfg/c', 3]]);
    expect(store.list('notes', { prefix: 'cf%' })).toEqual([]);
    expect(store.list('notes', { prefix: 'cfg/', limit: 2 })).toEqual([['cfg/a', 1], ['cfg/b', 2]]);
  } finally {
    ws.db.close();
  }
});

test('routeSlateStorageCall refuses by class: bad input versus a member it does not offer', () => {
  const route = (member: string, args: JsonValue[] = []) =>
    routeSlateStorageCall({ member, args, invocation: null });

  expect(route('get', ['k'])).toEqual({ op: 'get', key: 'k' });
  expect(route('put', ['k', { a: 1 }])).toEqual({ op: 'put', key: 'k', value: { a: 1 } });
  expect(route('delete', ['k'])).toEqual({ op: 'delete', key: 'k' });
  expect(route('list', [{ prefix: 'p', limit: 5 }])).toEqual({ op: 'list', prefix: 'p', limit: 5 });

  const fails = (member: string, args: JsonValue[], code: ErrorCode) => {
    try {
      route(member, args);
      expect.unreachable(`${member} should refuse`);
    } catch (cause) {
      if (!(cause instanceof KinuError)) throw cause;

      expect(cause.code).toBe(code);
    }
  };

  expect(() => route('get', [])).toThrow('one key');
  fails('get', [], 'bad_input');
  fails('get', [''], 'bad_input');
  fails('put', ['k'], 'bad_input');
  fails('put', ['k', 'v', 'extra'], 'bad_input');
  fails('put', ['x'.repeat(513), 'v'], 'bad_input');
  fails('list', [{ limit: 1001 }], 'bad_input');
  fails('list', ['not-an-object'], 'bad_input');
  fails('clear', [], 'denied');
  expect(() => route('clear')).toThrow('storage offers get, put, delete and list');
});

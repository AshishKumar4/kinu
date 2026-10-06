import type { AgentContext } from 'agents';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { type JsonValue, type SqlValue } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../../core/tests/helpers';
import { SCRIPT_EXPORTS } from './programmatic-host';

/** The Durable Object state every fixture here constructs; shared with
 *  `helpers/hosted-workspace.ts` so the platform surface cannot drift. */
export function makeCtx(db: Database, id = 'harness-actor', objectName = id): AgentContext {
  const canonicalSql = makeSqlExec(db);

  const sqlExec = (query: string, ...bindings: SqlValue[]) => {
    const rows = canonicalSql.exec(query, ...bindings).toArray();

    return {
      toArray: () => rows,
      // workerd's cursor count, read by the SDK's Streams right after a write and before any other statement.
      get rowsWritten(): number {
        return present(db.query<{ n: number }, []>('SELECT changes() AS n').get(), 'the changes() row').n;
      },
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };

  // Real KV storage: `_cf_initAsFacet` puts `cf_agents_parent_path` here and the
  // owner's inspection reads it back before traversing the hop.
  const kv = new Map<string, JsonValue>();

  const context = {
    storage: {
      sql: { exec: sqlExec },
      // The synchronous face of the same pairs, as a SQLite-backed object's: the namespace name a destroy keeps.
      kv: {
        get: (key: string): JsonValue | undefined => kv.get(key),
        put: (key: string, value: JsonValue): void => { kv.set(key, value); },
        delete: (key: string): boolean => kv.delete(key),
      },
      // Real: the durable filesystem's atomicity rests on it; Nimbus refuses to boot without it.
      transactionSync: <T>(closure: () => T): T => db.transaction(closure)(),
      get: async (key: string): Promise<JsonValue | undefined> => kv.get(key),
      put: async (key: string, value: JsonValue): Promise<void> => { kv.set(key, value); },
      // Nimbus's per-actor shell state; delete answers whether a row was there, as the platform's does.
      delete: async (key: string) => kv.delete(key),
      list: async (options: { prefix: string }): Promise<Map<string, JsonValue>> => {
        const entries = new Map<string, JsonValue>();

        for (const [key, value] of kv) {
          if (key.startsWith(options.prefix)) entries.set(key, value);
        }

        return entries;
      },
      transaction: async <T,>(body: (txn: {
        get(key: string): Promise<JsonValue | undefined>;
        put(key: string, value: JsonValue): Promise<void>;
        delete(key: string): Promise<boolean>;
      }) => Promise<T>): Promise<T> => body({
        get: async (key) => kv.get(key),
        put: async (key, value) => { kv.set(key, value); },
        delete: async (key) => kv.delete(key),
      }),
      sync: async () => undefined,
      deleteAll: async () => {
        // workerd's `storage.deleteAll()` empties both the KV pairs and every SQLite table.
        const tables = db.prepare<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        ).all();

        // IF EXISTS: dropping an FTS table drops its shadow tables with it.
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
        kv.clear();
      },
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    id: { toString: () => id, name: objectName },
    waitUntil: () => {},
    blockConcurrencyWhile: <Result>(fn: () => Promise<Result>): Promise<Result> => fn(),
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    abort: () => {},
    // The script's exports, whose supervisor entrypoint the hosted runtime requires.
    exports: SCRIPT_EXPORTS,
  };

  const partialContext: Partial<AgentContext> = {};
  Object.assign(partialContext, context);

  // SAFETY: the Agent constructor contract stores this locally constructed
  // context, and actor schema initialization only calls the implemented SQL,
  // transaction, identity, alarm, and concurrency members above.
  return partialContext as AgentContext;
}

/** What a binding may hand out a stub to: a Durable Object, or a class a suite declares to model one. */
interface StubTarget {
  readonly constructor: unknown;
}

/**
 * workerd's stub resolution, as the platform documents it rather than as `sealRpcSurface`
 * implements it: a name resolves when some prototype below `Object.prototype` holds it and the
 * instance does not shadow it with an own property.
 */
export function rpcReachableFrom(target: StubTarget): string[] {
  const prototypes: object[] = [];

  for (let proto = Object.getPrototypeOf(target); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    prototypes.push(proto);
  }

  return [...new Set(prototypes.flatMap((proto) => Object.getOwnPropertyNames(proto)))]
    .filter((name) => name !== 'constructor' && !Object.hasOwn(target, name))
    .sort();
}

/** The Durable Object stub a binding hands out: a method off the object's RPC surface is refused
 *  in workerd's own words; every method it serves is appended to `served`. */
export function stubOf<T extends object>(target: T, served?: string[]): T {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`The RPC receiver does not implement the method "${name}".`);
  };

  return new Proxy(target, {
    get: (held, name) => {
      // A stub is not a thenable: `await stub` yields the stub.
      if (name === 'then') return undefined;

      if (!v.is(v.string(), name) || !rpcReachableFrom(held).includes(name)) return refuse(String(name));

      for (let owner: object | null = Object.getPrototypeOf(held); owner !== null; owner = Object.getPrototypeOf(owner)) {
        const method = v.safeParse(v.function(), Object.getOwnPropertyDescriptor(owner, name)?.value);

        if (method.success) {
          served?.push(name);

          return method.output.bind(held);
        }
      }

      return refuse(name);
    },
  });
}


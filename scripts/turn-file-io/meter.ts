/** Probe-only SQL and RPC accounting. Snapshot queries do not pass through the SQL meter. */
import { SqlMeter, type OperationCost } from '../../packages/cf-backend/tests/workerd/sql-meter';
import * as v from 'valibot';

export interface Slice {
  readonly label: string;
  readonly sql: OperationCost;
  readonly rpc: Readonly<Record<string, number>>;
}

const CountsSchema = v.record(v.string(), v.number());

export const SliceSchema = v.object({
  label: v.string(),
  sql: v.object({
    tables: v.record(v.string(), v.object({ rowsRead: v.number(), rowsWritten: v.number(), statements: v.number(), rowsScanned: v.number() })),
    dbBytes: v.number(), storedRows: CountsSchema, storedBytes: CountsSchema, requestBytes: v.nullable(v.number()),
  }),
  rpc: CountsSchema,
});

/** Every concrete receiver has its framework constructor; its public methods have different arguments. */
export interface RpcReceiver { readonly constructor: Function }

const MethodSchema = v.custom<Function>((value) => typeof value === 'function');

/** Instruments actual receiver entries; no multiplier or source-code call-count estimate. */
export function instrument(proto: RpcReceiver, prefix: string, owner: (receiver: RpcReceiver) => Meter | undefined): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const method: unknown = descriptor?.value;

    if (name === 'constructor' || name.startsWith('perf') || typeof method !== 'function') continue;
    const callable = v.parse(MethodSchema, method);

    Object.defineProperty(proto, name, { ...descriptor, value: function (this: RpcReceiver, ...args: unknown[]) {
      owner(this)?.rpc(`${prefix}.${name}`);

      return callable.apply(this, args);
    } });
  }
}

export class Meter {
  readonly sql: SqlMeter;
  private active = false;
  private calls: Record<string, number> = {};

  constructor(storage: SqlStorage) {
    const exec = storage.exec.bind(storage);
    this.sql = new SqlMeter({ exec, get databaseSize() { return storage.databaseSize; } });
    storage.exec = (query, ...bindings) => this.sql.exec(query, ...bindings);
  }

  rpc(name: string): void {
    if (this.active && !name.includes('perf')) this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  begin(): void {
    this.sql.begin();
    this.calls = {};
    this.active = true;
  }

  cut(label: string, resume: boolean): Slice {
    const sql = this.sql.end(null);
    const rpc = this.calls;
    this.active = false;

    if (resume) this.begin();

    return { label, sql, rpc };
  }
}

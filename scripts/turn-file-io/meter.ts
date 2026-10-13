/** Probe-only SQL and RPC accounting. Snapshot queries do not pass through the SQL meter. */
import { SqlMeter, type OperationCost } from '../../packages/cf-backend/tests/workerd/sql-meter';
import * as v from 'valibot';
import type { HostedSession } from '@nimbus-sh/worker/workspace-host';

export interface Slice {
  readonly label: string;
  readonly sql: OperationCost;
  readonly rpc: Readonly<Record<string, number>>;
  readonly writes: Readonly<Record<string, { readonly rows: number; readonly bytes: number }>>;
  readonly queryReads: readonly { readonly query: string; readonly statements: number; readonly rowsRead: number }[];
}

const CountsSchema = v.record(v.string(), v.number());

export const SliceSchema = v.object({
  label: v.string(),
  sql: v.object({
    tables: v.record(v.string(), v.object({ rowsRead: v.number(), rowsWritten: v.number(), statements: v.number(), rowsScanned: v.number() })),
    dbBytes: v.number(), storedRows: CountsSchema, storedBytes: CountsSchema, requestBytes: v.nullable(v.number()),
  }),
  rpc: CountsSchema,
  writes: v.record(v.string(), v.object({ rows: v.number(), bytes: v.number() })),
  queryReads: v.array(v.object({ query: v.string(), statements: v.number(), rowsRead: v.number() })),
});

const CONVERSATION = /^(?:session_messages|stream_parts|actor_contexts|actor_context_selection|context_revisions|context_memberships|context_proposals|context_proposal_entries|actor_requests|request_renders|conversation_entries|conversation_entry_parts)$/u;

const NamesSchema = v.array(v.object({ name: v.string() }));

const WritesSchema = v.array(v.object({ name: v.string(), rows: v.number(), bytes: v.number() }));

/** Every concrete receiver has its framework constructor; its public methods have different arguments. */
export interface RpcReceiver { readonly constructor: Function }

const MethodSchema = v.custom<Function>((value) => typeof value === 'function');

const HostedSessionSchema = v.custom<HostedSession>((value) => typeof value === 'object' && value !== null && '_rpcReadFile' in value && typeof value._rpcReadFile === 'function');

export interface InstrumentHooks {
  readonly internal: readonly string[];
  readonly session?: (returned: HostedSession, meter: Meter) => HostedSession;
}

/** Instruments actual receiver entries; no multiplier or source-code call-count estimate. */
export function instrument(proto: RpcReceiver, prefix: string, owner: (receiver: RpcReceiver) => Meter | undefined, hooks: InstrumentHooks): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const method: unknown = descriptor?.value;

    if (name === 'constructor' || name.startsWith('perf') || hooks.internal.includes(name) || typeof method !== 'function') continue;
    const callable = v.parse(MethodSchema, method);

    Object.defineProperty(proto, name, { ...descriptor, value: function (this: RpcReceiver, ...args: unknown[]) {
      const meter = owner(this);
      meter?.rpc(`${prefix}.${name}`);
      const returned = callable.apply(this, args);

      const session = hooks.session;

      if (session !== undefined && meter !== undefined && (name === 'session' || name === 'stateSession')) {
        return Promise.resolve(returned).then((answer) => session(v.parse(HostedSessionSchema, answer), meter));
      }

      return returned;
    } });
  }
}

export class Meter {
  readonly sql: SqlMeter;
  private active = false;
  private calls: Record<string, number> = {};
  private readonly real: SqlStorage['exec'];
  private ignoredRpc: string | null = null;
  private ran: { readonly query: string; readonly cursor: Pick<SqlStorageCursor<Record<string, SqlStorageValue>>, 'rowsRead'> }[] = [];

  constructor(storage: SqlStorage) {
    const exec = storage.exec.bind(storage);
    this.real = exec;
    this.sql = new SqlMeter({ exec, get databaseSize() { return storage.databaseSize; } });
    storage.exec = <Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
      if (!this.active) return exec<Row>(query, ...bindings);
      const cursor = this.sql.exec<Row>(query, ...bindings);
      this.ran.push({ query, cursor });

      return cursor;
    };
  }

  rpc(name: string): void {
    if (name === this.ignoredRpc) { this.ignoredRpc = null;

 return; }

    if (this.active && !name.includes('perf')) this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  ignoreNextRpc(name: string): void { this.ignoredRpc = name; }

  begin(): void {
    this.real('CREATE TABLE IF NOT EXISTS perf_write_audit (name TEXT, bytes INTEGER)');
    this.real('CREATE TABLE IF NOT EXISTS perf_write_scope (enabled INTEGER)');

    if (this.real('SELECT 1 FROM perf_write_scope').toArray().length === 0) this.real('INSERT INTO perf_write_scope VALUES (0)');
    const names = v.parse(NamesSchema, this.real("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).filter(({ name }) => CONVERSATION.test(name));

    for (const { name } of names) {
      const columns = v.parse(NamesSchema, this.real(`SELECT name FROM pragma_table_info('${name}')`).toArray());
      const bytes = columns.map((column) => `coalesce(octet_length(NEW."${column.name}"), 0)`).join(' + ');

      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const payload = operation === 'DELETE' ? '0' : bytes;
        this.real(`CREATE TRIGGER IF NOT EXISTS perf_audit_${name}_${operation} AFTER ${operation} ON "${name}"
          WHEN (SELECT enabled FROM perf_write_scope) = 1 BEGIN INSERT INTO perf_write_audit VALUES ('${name}', ${payload}); END`);
      }
    }

    this.real('DELETE FROM perf_write_audit');
    this.real('UPDATE perf_write_scope SET enabled = 1');
    this.sql.begin();
    this.calls = {};
    this.ran = [];
    this.active = true;
  }

  cut(label: string, resume: boolean): Slice {
    this.real('UPDATE perf_write_scope SET enabled = 0');
    const sql = this.sql.end(null);
    const rpc = this.calls;
    const read = new Map<string, { query: string; statements: number; rowsRead: number }>();

    for (const { query, cursor } of this.ran) {
      const counted = read.get(query) ?? { query, statements: 0, rowsRead: 0 };
      counted.statements++;
      counted.rowsRead += cursor.rowsRead;
      read.set(query, counted);
    }

    const queryReads = [...read.values()].sort((a, b) => b.rowsRead - a.rowsRead).slice(0, 10);
    const writes = Object.fromEntries(v.parse(WritesSchema, this.real('SELECT name, COUNT(*) AS rows, SUM(bytes) AS bytes FROM perf_write_audit GROUP BY name').toArray()).map(({ name, rows, bytes }) => [name, { rows, bytes }]));
    this.active = false;

    if (resume) this.begin();

    return { label, sql, rpc, writes, queryReads };
  }
}

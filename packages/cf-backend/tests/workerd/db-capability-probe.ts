/**
 * The `db` capability on real Durable Object SQLite, reached from a program
 * running in the real dynamic-Worker sandbox.
 *
 * WHY THIS IS A PLATFORM TEST. Two of the mechanisms `db` is built on are the
 * platform's to provide, and `bun:sqlite` having them says nothing whatever
 * about workerd:
 *
 *   1. `Storage.transactionSync` over `ctx.storage`. The all-or-nothing batch —
 *      and, more importantly, the guarantee that a mutation's `db_op` evidence
 *      rolls back WITH it — is that transaction and nothing else. A workerd
 *      transaction that committed the rows of the operations before the failing
 *      one would leave a partially applied batch in production with every unit
 *      test green.
 *   2. `UPDATE`/`DELETE`/`INSERT … RETURNING`. That is how a row count crosses
 *      the `SqlExecutor` seam, which answers rows and never a change count.
 *      Durable Object SQLite is the runtime that has to answer them.
 *
 * And the program is executed by the REAL `@cloudflare/codemode`
 * DynamicWorkerExecutor over `env.LOADER`, so the arguments the store validates
 * are the ones that actually survive the isolate boundary: JSON, with bytes as
 * base64 and a refusal as a value the program branches on.
 *
 * The subject is the PRODUCTION store and provider — `createAppDataStore`,
 * `createDbCodemodeProvider`, `initWorkspaceSchema` — over `ctx.storage`. Only
 * the SqlExecutor adapter is local, and it is the tagged-template protocol
 * `bindAgentSql` bridges in production.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { createCodeTool } from '@cloudflare/codemode/ai';
import {
  bindActorHandle, createAppDataStore, createDbCodemodeProvider, initWorkspaceSchema,
  RunEventRecorder, WORKSPACE_RUN_ID,
  WorkspaceActorDirectory,
  type ActorHandle, type AppDataStore, type CodemodeProvider, type SqlExec, type SqlExecutor,
} from '@kinu.run/core';
import { KinuSandboxExecutor } from '../../src/codemode-sandbox';

/** The two issued actors this probe runs programs as. */
interface ProbeActors {
  readonly main: ActorHandle;
  readonly scout: ActorHandle;
}

/** What one probe run reports back across the RPC boundary. */
export interface DbProbeAnswer {
  /** The program's own return value, JSON-encoded — a `Map` or a domain object
   *  is not structured-cloneable through a Durable Object stub. */
  readonly answer: string;
  /** Rows of `app_<name>` as the DATABASE holds them, per actor, so the
   *  assertion is not the program agreeing with itself. */
  readonly rows: readonly { readonly actor: string; readonly key: string }[];
  /** `sqlite_master` table names, for the before/after of an attack. */
  readonly tables: readonly string[];
  /** Every `db_op` event the run recorded, in order. */
  readonly evidence: readonly string[];
}

export class DbCapabilityProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the same assertion `bindAgentSql` (runtime.ts) makes, at the same
  // boundary and for the same reason. `SqlExecutor` and the platform's
  // `sql.exec` are one tagged-template protocol; `SqlExecutor` additionally
  // admits `boolean`, which this store never binds (every value it writes is
  // text, integer, real, blob or null), and `ArrayBuffer`, which Durable Object
  // SQLite binds at runtime and does not type. The Agents SDK is not hosted in
  // this worker, which is why the bridge is here.
  private readonly sql = ((
    query: TemplateStringsArray, ...values: SqlStorageValue[]
  ) => this.ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

  private readonly execRaw = (ddl: string): void => { this.ctx.storage.sql.exec(ddl); };

  /**
   * The dynamic-SQL peer of the bridge above, for the schema entry point.
   *
   * A boolean becomes 0/1 rather than being refused, which is not a silent
   * conversion of meaning: SQLite has no boolean type and stores a bound one
   * exactly this way. Declaring the adapter's parameter as the platform's
   * narrower value type instead would make it unassignable to `SqlExec`.
   */
  private readonly exec: SqlExec = {
    exec: (query, ...bindings) => this.ctx.storage.sql.exec(
      query,
      // A boolean is admitted by `SqlExec` and not by the platform's own value
      // type, so it is parsed here rather than shape-checked.
      ...bindings.map((value) => (v.is(v.boolean(), value) ? Number(value) : value)),
    ),
  };

  private ready = false;
  private main: ActorHandle | undefined;
  private scout: ActorHandle | undefined;

  /** The workspace, its schema and two issued actors — main and a real
   *  subordinate of it, both from the production directory, both over THIS
   *  object's one database. */
  private open(): ProbeActors {
    if (!this.ready) {
      // `initWorkspaceSchema` creates workspace_identity and the actor roster
      // itself (initWorkspaceOwnershipTables + initWorkspaceActorTable), so the
      // probe adds only the identity ROW the directory reads for ownership.
      initWorkspaceSchema({ execRaw: this.execRaw, sql: this.sql, exec: this.exec });
      void this.sql`INSERT OR IGNORE INTO workspace_identity (id, name) VALUES (${'ws-db-probe'}, ${'db-probe'})`;
      const directory = new WorkspaceActorDirectory(this.sql, { workspaceId: 'ws-db-probe', ownerUserId: '' });
      const main = directory.createMain({ name: 'db-probe' });
      this.main = main;
      this.scout = directory.create({
        parent: main, name: 'scout', kind: 'subordinate', lifetime: 'durable', creationId: 'scout',
      });
      this.ready = true;
    }
    const main = this.main;
    const scout = this.scout;
    if (main === undefined || scout === undefined) throw new Error('the probe workspace was not opened');
    return { main, scout };
  }

  private store(actor: ActorHandle): AppDataStore {
    return createAppDataStore({
      sql: this.sql,
      actor,
      transactionSync: (write) => this.ctx.storage.transactionSync(write),
      events: () => new RunEventRecorder(this.sql, actor),
      runId: () => WORKSPACE_RUN_ID,
    });
  }

  /**
   * Run one model-authored program in the real sandbox, as the named actor.
   *
   * `db` is the ONLY namespace bound, so a program that reached anything else
   * would fail on a ReferenceError rather than quietly using another path.
   */
  async program(code: string, as: 'main' | 'scout'): Promise<DbProbeAnswer> {
    const actors = this.open();
    const actor = as === 'main' ? actors.main : actors.scout;
    const provider: CodemodeProvider = createDbCodemodeProvider(this.store(actor));
    const tool = createCodeTool({
      description: 'probe',
      tools: [provider],
      executor: new KinuSandboxExecutor({ loader: this.env.LOADER, egress: null }),
    });
    const execute = tool.execute;
    if (execute === undefined) throw new Error('the codemode tool is not callable');
    const answer = await execute({ code }, { toolCallId: 'db-probe', messages: [] });
    return {
      answer: JSON.stringify(answer ?? null),
      rows: this.rows(),
      tables: this.tables(),
      evidence: this.evidence(actor),
    };
  }

  /** Whether the actor-scoped table this suite writes exists, and whose rows it
   *  holds. Read through neither the store nor the provider. */
  private rows(): readonly { readonly actor: string; readonly key: string }[] {
    const present = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${'app_ledger'}`;
    if (present.length === 0) return [];
    return this.sql<{ actor: string; key: string }>`
      SELECT actor_id AS actor, "key" AS key FROM app_ledger ORDER BY actor_id, "key"`;
  }

  private tables(): readonly string[] {
    return this.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      .map((row) => row.name);
  }

  private evidence(actor: ActorHandle): readonly string[] {
    return new RunEventRecorder(this.sql, actor)
      .read(WORKSPACE_RUN_ID, { limit: 100 })
      .flatMap((event) => (event.type === 'db_op'
        ? [`${event.op}:${event.table}:${event.scope}:${event.rowsAffected}:${String(event.batch)}`]
        : []));
  }

  /** Bind a handle whose identity is NOT in the directory, so the probe can
   *  show that a stale binding is refused before any statement runs — the
   *  hosted equivalent of a dismissed actor still holding a store. */
  async staleActor(): Promise<string> {
    this.open();
    let live = true;
    const stale = bindActorHandle(this.sql, {
      actorId: 'actor-gone', workspaceId: 'ws-db-probe', parentActorId: null,
      name: 'gone', storageKey: 'agent:gone',
    }, () => {
      if (!live) throw new Error('actor actor-gone is no longer bound');
    });
    const store = this.store(stale);
    store.createTable({
      name: 'ledger', scope: 'actor', columns: [{ name: 'key', type: 'text', primaryKey: true }],
    });
    live = false;
    try {
      store.apply({ op: 'insert', table: 'ledger', rows: [{ key: 'after-dismissal' }] });
      return 'the write was admitted';
    }
    catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }
}

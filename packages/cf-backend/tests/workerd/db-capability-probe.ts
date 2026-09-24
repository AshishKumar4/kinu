/**
 * The `db` capability on real Durable Object SQLite, run from the real dynamic-Worker sandbox. Defends platform
 * behaviour bun:sqlite cannot: `transactionSync` rolling back a failed batch with its `db_op` evidence, and `… RETURNING` row counts.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { createCodeTool } from '@cloudflare/codemode/ai';
import {
  bindActorHandle, createAppDataStore, createDbCodemodeProvider, initWorkspaceSchema,
  RunEventRecorder, WORKSPACE_RUN_ID,
  WorkspaceActorDirectory,
  type ActorHandle, type AppDataStore, type CodemodeProvider, type SqlExec, type SqlExecutor, type SqlValue,
} from '@kinu.run/core';
import { KinuSandboxExecutor } from '../../src/codemode-sandbox';

interface ProbeActors {
  readonly main: ActorHandle;
  readonly scout: ActorHandle;
}

/** What one probe run reports back across the RPC boundary. */
export interface DbProbeAnswer {
  /** JSON-encoded: a `Map` or domain object is not structured-cloneable through a Durable Object stub. */
  readonly answer: string;
  /** Rows as the database holds them, so the assertion is not the program agreeing with itself. */
  readonly rows: readonly { readonly actor: string; readonly key: string }[];
  readonly tables: readonly string[];
  readonly evidence: readonly string[];
}

export class DbCapabilityProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  private readonly execRaw = (ddl: string): void => { this.ctx.storage.sql.exec(ddl); };

  /** A boolean becomes 0/1, as SQLite stores a bound one; the platform's narrower value type would be unassignable to `SqlExec`. */
  private readonly exec: SqlExec = {
    exec: (query, ...bindings) => this.ctx.storage.sql.exec(
      query,
      ...bindings.map((value) => (v.is(v.boolean(), value) ? Number(value) : value)),
    ),
  };

  private ready = false;
  private main: ActorHandle | undefined;
  private scout: ActorHandle | undefined;

  private open(): ProbeActors {
    if (!this.ready) {
      // `initWorkspaceSchema` creates the identity and roster tables; the probe adds only the identity row.
      initWorkspaceSchema({ execRaw: this.execRaw, sql: this.sql, exec: this.exec, transactionSync: (write) => this.ctx.storage.transactionSync(write) });
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

  /** `db` is the only namespace bound, so reaching anything else fails with a ReferenceError. */
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

  /** Read through neither the store nor the provider. */
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

  /** A handle whose identity is not in the directory: a stale binding is refused before any statement runs. */
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

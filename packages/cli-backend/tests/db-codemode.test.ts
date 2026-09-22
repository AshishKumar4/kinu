// `db.*` through the real local codemode sandbox: JSON marshalling, base64 blobs,
// refusals as values, and `db.batch` rollback across that boundary.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createAppDataStore, createDbCodemodeProvider, initWorkspaceSchema,
  RunEventRecorder, WORKSPACE_RUN_ID,
  type ActorHandle, type JsonValue, type SqlExecutor,
} from '@kinu.run/core';
import { createTestActors, toolExecute, type TestActors } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { localTransactions, makeWorkspaceSchemaSql } from '../src/runtime';

interface ExecuteToolResult {
  result: JsonValue | undefined;
  logs?: string[];
  error?: string;
}

interface Sandbox {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly actors: TestActors;
  run(code: string, actor?: ActorHandle): Promise<ExecuteToolResult>;
  close(): void;
}

function sandbox(): Sandbox {
  const db = new Database(':memory:');
  // Production adapters: `makeSql` decides whether a `RETURNING` write executes on this backend.
  const schemaSql = makeWorkspaceSchemaSql(db);
  // The workspace's own `localTransactions`: a copied primitive would agree with production by construction.
  const transactions = localTransactions(db).storage;

  if (transactions === undefined) {
    throw new Error('the local workspace exposes no synchronous transaction, so batch atomicity cannot be measured');
  }

  const { transactionSync } = transactions;

  const sql = schemaSql.sql;
  initWorkspaceSchema(schemaSql);
  const actors = createTestActors(sql, schemaSql.execRaw);

  return {
    db, sql, actors,
    run: (code, actor = actors.main) => {
      const store = createAppDataStore({
        sql, actor,
        transactionSync,
        events: () => new RunEventRecorder(sql, actor),
        runId: () => WORKSPACE_RUN_ID,
      });

      // `extraProviders` is the production seam for codemode namespaces; `surface.providers` takes executors.
      const factory = createNodeCodemodeToolFactory({ extraProviders: [createDbCodemodeProvider(store)] });
      const tool = factory({ native: {}, craftedTools: () => ({}), providers: [] });

      return toolExecute(tool)({ code });
    },
    close: () => db.close(),
  };
}

describe('db.* in the local codemode sandbox', () => {
  test('a program declares a table, fills it and reads it back in one call', async () => {
    const s = sandbox();

    try {
      const out = await s.run(`
        // Record this run's findings so the next turn can query them
        await db.createTable({ name: 'findings', scope: 'actor', columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'severity', type: 'integer' },
          { name: 'detail', type: 'json' },
        ] });
        await db.insert('findings', [
          { id: 'f1', severity: 3, detail: { file: 'a.ts', lines: [1, 2] } },
          { id: 'f2', severity: 1, detail: null },
        ]);
        await db.update('findings', { severity: 5 }, { id: 'f1' });
        return {
          rows: await db.select('findings', { orderBy: [{ column: 'id' }] }),
          high: await db.count('findings', { severity: { op: '>=', value: 4 } }),
          tables: (await db.listTables()).map((table) => table.name + ':' + table.scope),
        };
      `);

      expect(out.error).toBeUndefined();
      expect(out.result).toEqual({
        rows: [
          { id: 'f1', severity: 5, detail: { file: 'a.ts', lines: [1, 2] } },
          { id: 'f2', severity: 1, detail: null },
        ],
        high: 1,
        tables: ['findings:actor'],
      });
      expect(s.sql<{ actor_id: string; id: string; severity: number }>`
        SELECT actor_id, id, severity FROM app_findings ORDER BY id`).toEqual([
        { actor_id: s.actors.main.actorId, id: 'f1', severity: 5 },
        { actor_id: s.actors.main.actorId, id: 'f2', severity: 1 },
      ]);
    }
    finally { s.close(); }
  });

  test('bytes survive the JSON boundary as base64 and are stored as a blob', async () => {
    const s = sandbox();

    try {
      const out = await s.run(`
        // Keep a small binary artefact beside its name
        await db.createTable({ name: 'artefacts', scope: 'actor', columns: [
          { name: 'name', type: 'text', primaryKey: true },
          { name: 'bytes', type: 'blob' },
        ] });
        // A literal base64 whose bytes include 0x00 and 0x80-0xFF: a value that
        // came back through any text path could not compare equal.
        const encoded = 'AAECf4D//g==';
        await db.insert('artefacts', [{ name: 'logo', bytes: encoded }]);
        const [row] = await db.select('artefacts');
        return { sent: encoded, back: row.bytes, same: row.bytes === encoded };
      `);

      expect(out.error).toBeUndefined();
      expect(out.result).toMatchObject({ same: true });
      expect(s.sql<{ kind: string; size: number }>`
        SELECT typeof(bytes) AS kind, length(bytes) AS size FROM app_artefacts`).toEqual([
        { kind: 'blob', size: 7 },
      ]);
    }
    finally { s.close(); }
  });

  test('an all-or-nothing batch rolls back and the program keeps running', async () => {
    const s = sandbox();

    try {
      const out = await s.run(`
        // Write three rows atomically, then observe the refusal of a bad batch
        await db.createTable({ name: 'ledger', scope: 'actor', columns: [
          { name: 'key', type: 'text', primaryKey: true },
          { name: 'amount', type: 'integer' },
        ] });
        const landed = await db.batch([
          { op: 'insert', table: 'ledger', rows: [{ key: 'a', amount: 1 }] },
          { op: 'insert', table: 'ledger', rows: [{ key: 'b', amount: 2 }] },
        ]);
        const refused = await db.batch([
          { op: 'insert', table: 'ledger', rows: [{ key: 'c', amount: 3 }] },
          { op: 'update', table: 'ledger', set: { amount: 'not a number' }, where: {} },
        ]);
        return {
          landed,
          refusalReason: refused.reason,
          failedIndex: refused.failedIndex,
          keys: (await db.select('ledger', { columns: ['key'], orderBy: [{ column: 'key' }] })).map((row) => row.key),
        };
      `);

      expect(out.error).toBeUndefined();
      expect(out.result).toEqual({
        landed: [{ rowsAffected: 1 }, { rowsAffected: 1 }],
        refusalReason: 'bad_input',
        failedIndex: 1,
        keys: ['a', 'b'],
      });
    }
    finally { s.close(); }
  });

  test('a program handles a refusal and the enclosing call still succeeds', async () => {
    const s = sandbox();

    try {
      const out = await s.run(`
        // Try the host's own tables, then do the work that is actually allowed
        const attempts = {};
        for (const target of ['conversation_entries', 'workspace_actors', 'agent_data_tables']) {
          const answer = await db.select(target);
          attempts[target] = answer.reason;
        }
        attempts.injection = (await db.select('notes; DROP TABLE conversation_entries')).reason;
        attempts.drop = (await db.dropTable('conversation_entries')).reason;
        await db.createTable({ name: 'mine', scope: 'actor', columns: [{ name: 'k', type: 'text' }] });
        await db.insert('mine', [{ k: 'ok' }]);
        return { attempts, mine: await db.count('mine') };
      `);

      expect(out.error).toBeUndefined();
      expect(out.result).toEqual({
        attempts: {
          conversation_entries: 'missing',
          workspace_actors: 'missing',
          agent_data_tables: 'missing',
          injection: 'bad_input',
          drop: 'missing',
        },
        mine: 1,
      });
      expect(s.sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_entries', 'workspace_actors', 'agent_data_tables')
        ORDER BY name`.map((row) => row.name))
        .toEqual(['agent_data_tables', 'conversation_entries', 'workspace_actors']);
    }
    finally { s.close(); }
  });

  test('two actors run the same program over one database and see only their own rows', async () => {
    const s = sandbox();

    try {
      const program = `
        // Claim a slot under a name every agent uses
        await db.createTable({ name: 'slots', scope: 'actor', columns: [
          { name: 'slot', type: 'text', primaryKey: true },
          { name: 'owner', type: 'text' },
        ] });
        await db.insert('slots', [{ slot: 'primary', owner: OWNER }]);
        return await db.select('slots');
      `;

      const scout = s.actors.sibling('scout');
      const mine = await s.run(program.replace('OWNER', "'main'"));
      const theirs = await s.run(program.replace('OWNER', "'scout'"), scout);

      expect(mine.result).toEqual([{ slot: 'primary', owner: 'main' }]);
      expect(theirs.result).toEqual([{ slot: 'primary', owner: 'scout' }]);
      expect(s.sql<{ n: number }>`SELECT COUNT(*) AS n FROM app_slots`[0]?.n).toBe(2);

      const refusal = {
        success: false, reason: 'denied',
        error: `table \`slots\` was declared by another agent (${s.actors.main.actorId}); delete your own rows instead`,
      };

      await expect(s.run(`return await db.dropTable('slots');`, scout)).rejects.toEqual(expect.objectContaining({
        outcome: { ...refusal, failures: [{ ...refusal, tool: 'db', action: 'dropTable' }] },
      }));
      expect(s.sql<{ n: number }>`SELECT COUNT(*) AS n FROM app_slots`[0]?.n).toBe(2);
    }
    finally { s.close(); }
  });

  test('every landed mutation leaves one db_op event and a refused one leaves none', async () => {
    const s = sandbox();

    try {
      const refusal = {
        success: false, reason: 'bad_input', failedIndex: 1,
        error: 'batch operation 1 was refused, so none of the batch landed: db.batch operation 1 (insert events): UNIQUE constraint failed: app_events.actor_id, app_events.k',
      };

      await expect(s.run(`
        // Two writes that land and one batch that does not
        await db.createTable({ name: 'events', scope: 'actor', columns: [{ name: 'k', type: 'text', primaryKey: true }] });
        await db.insert('events', [{ k: 'a' }]);
        await db.deleteRows('events', { k: 'a' });
        return await db.batch([
          { op: 'insert', table: 'events', rows: [{ k: 'b' }] },
          { op: 'insert', table: 'events', rows: [{ k: 'b' }] },
        ]);
      `)).rejects.toEqual(expect.objectContaining({
        outcome: { ...refusal, failures: [{ ...refusal, tool: 'db', action: 'batch' }] },
      }));

      expect(s.sql<{ n: number }>`SELECT COUNT(*) AS n FROM app_events`[0]?.n).toBe(0);

      const recorded = new RunEventRecorder(s.sql, s.actors.main)
        .read(WORKSPACE_RUN_ID, { limit: 50 })
        .flatMap((event) => (event.type === 'db_op' ? [`${event.op}:${event.rowsAffected}:${String(event.batch)}`] : []));

      expect(recorded).toEqual(['createTable:0:null', 'insert:1:null', 'delete:1:null']);
    }
    finally { s.close(); }
  });
});

/**
 * `db` in the dynamic-Worker sandbox over Durable Object SQLite: `transactionSync` and `… RETURNING` are workerd's to provide,
 * and `bun:sqlite` says nothing about them. Each test uses its own object id so earlier tables cannot decide a later assertion.
 */
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

const LEDGER = `await db.createTable({ name: 'ledger', scope: 'actor', columns: [
  { name: 'key', type: 'text', primaryKey: true },
  { name: 'amount', type: 'integer' },
  { name: 'blob_col', type: 'blob' },
  { name: 'detail', type: 'json' },
] });`;

const AnswerSchema = v.object({ result: JsonValueSchema });

function probe(id: string) {
  return env.DB_CAPABILITY_PROBE.get(env.DB_CAPABILITY_PROBE.idFromName(id));
}

function resultOf(answer: string): JsonValue {
  return v.parse(AnswerSchema, JSON.parse(answer)).result;
}


describe('the db capability on Durable Object SQLite', () => {
  test('a mid-batch actor revocation rolls back an observed write and its db_op evidence', async () => {
    const run = await probe('revoked-mid-batch').revokedBatch();
    expect(run.reason).not.toBeNull();
    expect(run.beforeRevocation.rows).toEqual([{ actor: 'actor-fenced', key: 'first' }]);
    expect(run.beforeRevocation.evidence).toEqual(['createTable:ledger:actor:0:null', 'insert:ledger:actor:1:2']);
    expect(run.rows).toEqual([]);
    expect(run.evidence).toEqual(['createTable:ledger:actor:0:null']);
  });

  test('a program declares, writes, reads and counts over the workspace database', async () => {
    const run = await probe('crud').program(`
      // Record this run's ledger so a later turn can query it
      ${LEDGER}
      await db.insert('ledger', [
        { key: 'a', amount: 1, blob_col: 'AAECf4D//g==', detail: { tag: 'first' } },
        { key: 'b', amount: 2, blob_col: null, detail: [1, 2] },
      ]);
      const updated = await db.update('ledger', { amount: 9 }, { key: 'a' });
      const removed = await db.deleteRows('ledger', { key: { op: 'in', values: ['b'] } });
      return {
        updated, removed,
        rows: await db.select('ledger'),
        total: await db.count('ledger'),
      };
    `, 'main');

    expect(resultOf(run.answer)).toEqual({
      updated: { rowsAffected: 1 },
      removed: { rowsAffected: 1 },
      rows: [{ key: 'a', amount: 9, blob_col: 'AAECf4D//g==', detail: { tag: 'first' } }],
      total: 1,
    });
    expect(run.rows).toEqual([{ actor: expect.any(String), key: 'a' }]);
    expect(run.evidence).toEqual([
      'createTable:ledger:actor:0:null',
      'insert:ledger:actor:2:null',
      'update:ledger:actor:1:null',
      'delete:ledger:actor:1:null',
    ]);
  });

  test('a failing batch leaves neither rows nor evidence of rows', async () => {
    const run = await probe('batch').program(`
      // Two ledger rows and a third that collides, in one transaction
      ${LEDGER}
      const refused = await db.batch([
        { op: 'insert', table: 'ledger', rows: [{ key: 'a', amount: 1 }] },
        { op: 'insert', table: 'ledger', rows: [{ key: 'b', amount: 2 }] },
        { op: 'insert', table: 'ledger', rows: [{ key: 'a', amount: 3 }] },
      ]);
      const landed = await db.batch([
        { op: 'insert', table: 'ledger', rows: [{ key: 'c', amount: 4 }] },
        { op: 'update', table: 'ledger', set: { amount: 5 }, where: { key: 'c' } },
      ]);
      return { refusal: refused.reason, failedIndex: refused.failedIndex, landed, rows: await db.select('ledger') };
    `, 'main');

    expect(resultOf(run.answer)).toEqual({
      refusal: 'bad_input',
      failedIndex: 2,
      landed: [{ rowsAffected: 1 }, { rowsAffected: 1 }],
      rows: [{ key: 'c', amount: 5, blob_col: null, detail: null }],
    });
    expect(run.evidence).toEqual([
      'createTable:ledger:actor:0:null',
      'insert:ledger:actor:1:2',
      'update:ledger:actor:1:2',
    ]);
    expect(run.rows.map((row) => row.key)).toEqual(['c']);
  });

  test('two actors of one object hold the same key without seeing each other', async () => {
    const claim = (owner: string) => `
      // Claim the ledger slot every agent claims
      ${LEDGER}
      await db.insert('ledger', [{ key: 'shared', amount: ${owner === 'main' ? '1' : '2'} }]);
      return { mine: await db.select('ledger'), tables: (await db.listTables()).map((t) => t.name) };
    `;

    const mine = await probe('isolation').program(claim('main'), 'main');
    const theirs = await probe('isolation').program(claim('scout'), 'scout');

    expect(resultOf(mine.answer)).toMatchObject({ mine: [{ key: 'shared', amount: 1 }] });
    expect(resultOf(theirs.answer)).toMatchObject({ mine: [{ key: 'shared', amount: 2 }] });
    expect(theirs.rows).toHaveLength(2);
    expect(new Set(theirs.rows.map((row) => row.actor)).size).toBe(2);
    expect(theirs.rows.every((row) => row.key === 'shared')).toBe(true);

    const refused = await probe('isolation').program(`return await db.dropTable('ledger');`, 'scout');
    expect(resultOf(refused.answer)).toMatchObject({ reason: 'denied' });
    expect(refused.tables).toContain('app_ledger');
    expect(refused.rows).toHaveLength(2);
  });

  test('the host tables of this object are unreachable, by name and by schema operation', async () => {
    const run = await probe('attack').program(`
      // Probe the host's own tables, then do the work that is allowed
      const reached = {};
      const hosts = ['conversation_entries', 'session_messages', 'workspace_actors',
        'workspace_identity', 'agent_data_tables', 'run_events', 'sqlite_master'];
      for (const target of hosts) {
        reached[target] = (await db.select(target)).reason;
      }
      reached.dropHost = (await db.dropTable('workspace_actors')).reason;
      reached.injection = (await db.createTable({ name: 'x; DROP TABLE conversation_entries', scope: 'actor', columns: [{ name: 'k', type: 'text' }] })).reason;
      reached.actorColumn = (await db.createTable({ name: 'sneaky', scope: 'actor', columns: [{ name: 'actor_id', type: 'text' }] })).reason;
      ${LEDGER}
      await db.insert('ledger', [{ key: 'allowed' }]);
      return { reached, mine: await db.count('ledger') };
    `, 'main');

    expect(resultOf(run.answer)).toEqual({
      reached: {
        conversation_entries: 'missing',
        session_messages: 'missing',
        workspace_actors: 'missing',
        workspace_identity: 'missing',
        agent_data_tables: 'missing',
        run_events: 'missing',
        sqlite_master: 'missing',
        dropHost: 'missing',
        injection: 'bad_input',
        actorColumn: 'bad_input',
      },
      mine: 1,
    });

    for (const name of [
      'conversation_entries', 'session_messages', 'workspace_actors', 'workspace_identity',
      'agent_data_tables', 'run_events',
    ]) {
      expect(run.tables).toContain(name);
    }

    expect(run.tables.filter((name) => name.startsWith('app_'))).toEqual(['app_ledger']);
    expect(run.tables.some((name) => name.includes('DROP'))).toBe(false);
  });

  test('a batch inside a caller\'s transaction goes with it: a fence or the caller refusing after it leaves neither rows nor evidence', async () => {
    for (const [id, refusal, said] of [['outer-fence', 'fence', 'mid-revert'], ['outer-caller', 'caller', 'outer transaction failed']] as const) {
      const run = await probe(id).outerBatch(refusal);

      expect(run.reason).toContain(said);
      expect({ rows: run.rows, evidence: run.evidence }).toEqual({ rows: [], evidence: ['createTable:ledger:actor:0:null'] });
    }

    // The denominator: the same batch, with nothing refusing after it, lands with its evidence.
    const landed = await probe('outer-ok').outerBatch('none');

    expect(landed.reason).toBeNull();
    expect(landed.rows.map((row) => row.key)).toEqual(['a', 'b']);
    expect(landed.evidence).toEqual(['createTable:ledger:actor:0:null', 'insert:ledger:actor:1:2', 'insert:ledger:actor:1:2']);
  });

  test('a binding that is no longer current is refused before its statement', async () => {
    expect(await probe('stale').staleActor()).toContain('no longer bound');
  });


  test('db.sql reaches the shared tables only, whatever path its statement takes', async () => {
    const run = await probe('sql-reach').program(`
      // Shared rows, then every way a statement might reach past them
      await db.sql('CREATE TABLE IF NOT EXISTS app_orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, n INTEGER)', []);
      await db.createTable({ name: 'mine', scope: 'actor', columns: [{ name: 'k', type: 'text' }] });
      const wrote = await db.sql('INSERT INTO app_orders (item, n) VALUES (?, ?), (?, ?) RETURNING id', ['tea', 2, 'cake', 1]);
      const read = await db.sql('SELECT item, sum(n) AS total FROM app_orders GROUP BY item ORDER BY total DESC LIMIT 10', []);
      const reached = {};
      const attempts = {
        subquery: 'SELECT item FROM app_orders WHERE id IN (SELECT rowid FROM workspace_actors)',
        cte: 'WITH x AS (SELECT * FROM run_events) SELECT * FROM x',
        join: 'SELECT * FROM app_orders JOIN agent_data_tables',
        insertSelect: 'INSERT INTO app_orders (item) SELECT name FROM workspace_actors',
        createAs: 'CREATE TABLE copy AS SELECT * FROM workspace_actors',
        clearHost: 'DELETE FROM agent_data_tables',
        withDelete: 'WITH x AS (SELECT 1) DELETE FROM workspace_actors WHERE rowid IN (SELECT * FROM x)',
        master: 'SELECT name FROM sqlite_master',
        schema: 'SELECT name FROM sqlite_schema',
        pragmaFunction: "SELECT * FROM pragma_table_info('app_orders')",
        actorTable: 'SELECT * FROM mine',
        actorTableStored: 'SELECT * FROM app_mine',
        second: 'SELECT 1; DELETE FROM app_orders',
        trigger: 'CREATE TRIGGER t AFTER INSERT ON app_orders BEGIN DELETE FROM run_events; END',
        view: 'CREATE VIEW v AS SELECT * FROM workspace_actors',
        index: 'CREATE INDEX ix ON workspace_actors(name)',
        alter: 'ALTER TABLE workspace_actors ADD COLUMN x TEXT',
        drop: 'DROP TABLE app_orders',
        pragma: 'PRAGMA writable_schema = 1',
        attach: "ATTACH DATABASE ':memory:' AS x",
      };
      for (const [name, query] of Object.entries(attempts)) reached[name] = (await db.sql(query, [])).reason ?? 'ran';
      reached.binds = (await db.sql('SELECT ' + Array.from({ length: 101 }, () => '?').join(', '), Array.from({ length: 101 }, (_, at) => at))).reason ?? 'ran';
      const rest = await db.sql('SELECT count(*) AS n FROM app_orders', []);
      return { wrote, read: read.rows, reached, rest: rest.rows };
    `, 'main');

    const result = v.parse(v.object({
      wrote: v.object({ rows: v.array(v.object({ id: v.number() })), rowsAffected: v.number() }),
      read: v.array(v.object({ item: v.string(), total: v.number() })),
      reached: v.record(v.string(), v.string()),
      rest: v.array(v.object({ n: v.number() })),
    }), resultOf(run.answer));

    expect(result.wrote).toEqual({ rows: [{ id: 1 }, { id: 2 }], rowsAffected: 2 });
    expect(result.read).toEqual([{ item: 'tea', total: 2 }, { item: 'cake', total: 1 }]);
    expect(Object.entries(result.reached).filter(([, reason]) => reason !== 'bad_input' && reason !== 'denied')).toEqual([]);
    expect(Object.keys(result.reached)).toHaveLength(21);
    expect(result.rest).toEqual([{ n: 2 }]);
    // The host's tables stand as they were.
    expect(run.tables).toContain('workspace_actors');
    expect(run.tables.filter((name) => name.startsWith('app_')).sort()).toEqual(['app_mine', 'app_orders']);
  });

  test('every opcode an app statement compiles to is one the db.sql gate admits', async () => {
    const refused = await probe('sql-opcodes').gated([
      'CREATE TABLE app_parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INTEGER)',
      'CREATE TABLE app_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES app_parent(id) ON DELETE CASCADE, note TEXT)',
      'CREATE INDEX app_child_parent ON app_child(parent)',
    ], [
      'SELECT * FROM app_parent WHERE id = 1',
      'SELECT p.name, count(c.id), sum(p.n), avg(p.n), min(p.n), max(p.n), group_concat(c.note) FROM app_parent p LEFT JOIN app_child c ON c.parent = p.id GROUP BY p.name HAVING count(*) > 0 ORDER BY 2 DESC LIMIT 5 OFFSET 1',
      'SELECT name, row_number() OVER (ORDER BY n), lag(n) OVER (PARTITION BY name ORDER BY id), sum(n) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM app_parent',
      'SELECT DISTINCT name FROM app_parent UNION SELECT note FROM app_child INTERSECT SELECT name FROM app_parent EXCEPT SELECT \'x\'',
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x FROM c',
      'WITH big AS MATERIALIZED (SELECT * FROM app_parent WHERE n > 1) SELECT * FROM big JOIN app_child ON app_child.parent = big.id',
      'SELECT * FROM app_parent WHERE name LIKE \'a%\' AND n BETWEEN 1 AND 9 AND id NOT IN (SELECT parent FROM app_child) AND EXISTS (SELECT 1 FROM app_child)',
      'SELECT CASE WHEN n > 1 THEN \'big\' ELSE \'small\' END, coalesce(name, \'\'), length(name), upper(name), substr(name, 1, 2), abs(n), round(n / 3.0, 2), CAST(n AS TEXT), typeof(n), json_extract(name, \'$.a\'), datetime(\'now\'), printf(\'%d\', n) FROM app_parent',
      'VALUES (1, 2), (3, 4)',
      'INSERT INTO app_parent (name, n) VALUES (\'a\', 1), (\'b\', 2)',
      'INSERT INTO app_parent (name, n) VALUES (\'a\', 1) ON CONFLICT(name) DO UPDATE SET n = n + excluded.n',
      'INSERT OR REPLACE INTO app_parent (id, name) VALUES (1, \'z\')',
      'INSERT OR IGNORE INTO app_parent (name) SELECT note FROM app_child',
      'INSERT INTO app_child (parent, note) VALUES (1, \'n\') RETURNING id, note',
      'REPLACE INTO app_parent (id, name) VALUES (2, \'y\')',
      'UPDATE app_parent SET n = (SELECT count(*) FROM app_child WHERE app_child.parent = app_parent.id) WHERE n IS NULL',
      'UPDATE app_parent SET n = c.k FROM (SELECT parent, count(*) AS k FROM app_child GROUP BY parent) c WHERE c.parent = app_parent.id',
      'UPDATE app_child SET parent = 2 WHERE id = 1',
      'DELETE FROM app_parent WHERE id = 1',
      'DELETE FROM app_child',
      'DELETE FROM app_parent',
      'WITH x AS (SELECT 1) DELETE FROM app_parent WHERE id IN (SELECT * FROM x)',
    ]);

    expect(refused).toEqual([]);
  });
});


/**
 * `db` on the hosted backend, for real: a model-authored program in the
 * dynamic-Worker sandbox, over one Durable Object's own SQLite.
 *
 * The two platform mechanisms under test are named in `db-capability-probe.ts`:
 * `ctx.storage.transactionSync` (which is the whole of the all-or-nothing batch
 * AND of "evidence rolls back with its mutation") and `… RETURNING` (which is
 * how a row count crosses the `SqlExecutor` seam). Both are the runtime's to
 * provide, and every other test of this capability runs against `bun:sqlite`,
 * whose feature set says nothing about workerd's.
 *
 * Each test uses its OWN object id: the probe opens a workspace once per
 * instance, and a shared one would let an earlier program's tables decide a
 * later assertion.
 */
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import { sanitizeToolName } from '@cloudflare/codemode';
import { createDbCodemodeProvider, JsonValueSchema, type AppDataStore, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

const LEDGER = `await db.createTable({ name: 'ledger', scope: 'actor', columns: [
  { name: 'key', type: 'text', primaryKey: true },
  { name: 'amount', type: 'integer' },
  { name: 'blob_col', type: 'blob' },
  { name: 'detail', type: 'json' },
] });`;

/** The sandbox answers `{ result, logs? }`; the probe hands it back as JSON, so
 *  the assertion parses it rather than trusting the string. */
const AnswerSchema = v.object({ result: JsonValueSchema });

function probe(id: string) {
  return env.DB_CAPABILITY_PROBE.get(env.DB_CAPABILITY_PROBE.idFromName(id));
}

function resultOf(answer: string): JsonValue {
  return v.parse(AnswerSchema, JSON.parse(answer)).result;
}

/**
 * The store is never called: this reads the namespace's member NAMES, which
 * `createDbCodemodeProvider` fixes without touching a database.
 */
function memberNames(): readonly string[] {
  const unused: AppDataStore = {
    createTable: () => { throw new Error('not called'); },
    dropTable: () => { throw new Error('not called'); },
    listTables: () => { throw new Error('not called'); },
    schema: () => { throw new Error('not called'); },
    select: () => { throw new Error('not called'); },
    count: () => { throw new Error('not called'); },
    apply: () => { throw new Error('not called'); },
    batch: () => { throw new Error('not called'); },
  };
  return Object.keys(createDbCodemodeProvider(unused).tools);
}

describe('the db capability on Durable Object SQLite', () => {
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
      // Row counts through `RETURNING` on the real runtime.
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
    // The rolled-back operations left NO db_op rows, and the batch that landed
    // left one per operation naming the batch size.
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
    // One physical table, one key value, two rows with different owners.
    expect(theirs.rows).toHaveLength(2);
    expect(new Set(theirs.rows.map((row) => row.actor)).size).toBe(2);
    expect(theirs.rows.every((row) => row.key === 'shared')).toBe(true);

    // The sibling cannot retire the shared physical table while rows of the
    // other actor are in it, and cannot drop a table it did not declare.
    const refused = await probe('isolation').program(`return await db.dropTable('ledger');`, 'scout');
    expect(resultOf(refused.answer)).toMatchObject({ reason: 'denied' });
    expect(refused.tables).toContain('app_ledger');
    expect(refused.rows).toHaveLength(2);
  });

  test('the host tables of this object are unreachable, by name and by schema operation', async () => {
    const run = await probe('attack').program(`
      // Probe the host's own tables, then do the work that is allowed
      const reached = {};
      for (const target of ['messages', 'workspace_actors', 'workspace_identity', 'agent_data_tables', 'run_events', 'sqlite_master']) {
        reached[target] = (await db.select(target)).reason;
      }
      reached.dropHost = (await db.dropTable('workspace_actors')).reason;
      reached.injection = (await db.createTable({ name: 'x; DROP TABLE messages', scope: 'actor', columns: [{ name: 'k', type: 'text' }] })).reason;
      reached.actorColumn = (await db.createTable({ name: 'sneaky', scope: 'actor', columns: [{ name: 'actor_id', type: 'text' }] })).reason;
      ${LEDGER}
      await db.insert('ledger', [{ key: 'allowed' }]);
      return { reached, mine: await db.count('ledger') };
    `, 'main');

    expect(resultOf(run.answer)).toEqual({
      reached: {
        messages: 'missing',
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
    // Every host table the program reached for is still there, and no table was
    // created under an injected name.
    for (const name of ['messages', 'workspace_actors', 'workspace_identity', 'agent_data_tables', 'run_events']) {
      expect(run.tables).toContain(name);
    }
    expect(run.tables.filter((name) => name.startsWith('app_'))).toEqual(['app_ledger']);
    expect(run.tables.some((name) => name.includes('DROP'))).toBe(false);
  });

  test('a binding that is no longer current is refused before its statement', async () => {
    expect(await probe('stale').staleActor()).toContain('no longer bound');
  });

  /**
   * The guard for the defect this file found: `deleteRows` is spelled that way
   * because the hosted sandbox RENAMES a member whose name is a JavaScript
   * reserved word before it registers the host dispatcher, while the sandbox
   * proxy dispatches whatever the program typed — so `db.delete` answered
   * `Tool "delete" not found` on the real runtime while every local test
   * passed. Asserted against the vendor's OWN rule rather than a copy of its
   * word list, so a member added later cannot reintroduce it.
   */
  test('no member of the namespace is a name this sandbox would rename', () => {
    const names = memberNames();
    expect(names).toContain('deleteRows');
    expect(names).not.toContain('delete');
    expect(names.filter((name) => sanitizeToolName(name) !== name)).toEqual([]);
  });
});

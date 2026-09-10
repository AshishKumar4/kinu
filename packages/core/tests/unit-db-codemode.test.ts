/**
 * The `db` capability, over ONE real workspace database holding TWO issued
 * actors.
 *
 * Every case runs against a single `initWorkspaceSchema` SQLite with a main
 * actor and a real subordinate of it, both from the production
 * `WorkspaceActorDirectory` — the shape the scoping exists for and the only one
 * that can falsify it. With a database per actor the isolation assertions all
 * pass vacuously, because the rows were never in the same table.
 *
 * The logical keys COLLIDE on purpose: both actors declare the same table name
 * and write the same primary key, so "the ids happen to differ" is not
 * available as a reason the rows stay apart.
 *
 * What is asserted here is behaviour a consumer observes — rows read back,
 * refusals classified, events recorded, `sqlite_master` unchanged — never the
 * text of a statement. The one place SQL is inspected is `PRAGMA table_info`,
 * because "the actor id leads the primary key" is a property of the physical
 * table and of nothing else.
 */

import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors, testActorHandle, type TestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import {
  createAppDataStore, createDbCodemodeProvider, initAgentDataTables,
  type AppDataStore, type AppOp,
} from '../src/tools/db-codemode';
import { RunEventRecorder, parseStoredRunEvent } from '../src/events/recorder';
import { codemodeCapabilitiesFor, narrowToolSurface, TOOL_REACH } from '../src/tools/registry';
import { inWorkMode, providersInWorkMode } from '../src/execution/work-mode';
import { archiveSqlFromDatabase, restoreWorkspaceArchive, writeWorkspaceArchive } from '../src/index';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { RunEvent } from '../src/events/types';
import type { SqlExec, SqlExecutor, SqlValue } from '../src/types/primitives';

/** What `PRAGMA table_info` answers, narrowed to the two columns the key
 *  assertion is about. */
const ColumnInfoSchema = v.object({ name: v.string(), pk: v.number() });

interface World {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly actors: TestActors;
  readonly a: ActorHandle;
  readonly b: ActorHandle;
  store(actor: ActorHandle): AppDataStore;
  events(actor: ActorHandle): RunEvent[];
  /** Every TABLE this database holds. Indexes are excluded because SQLite
   *  mints an autoindex for a declared key, and the subject of a
   *  before/after comparison is which tables exist. */
  tables(): string[];
  close(): void;
}

const RUN = 'run-db';

/** One production-schema database, two issued actors, one SQL handle. */
function world(): World {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db) });
  const actors = createTestActors(sql, execRaw);
  const store = (actor: ActorHandle): AppDataStore => createAppDataStore({
    sql, actor,
    transactionSync: (write) => db.transaction(write)(),
    events: () => new RunEventRecorder(sql, actor),
    runId: () => RUN,
  });
  return {
    db, sql, exec: makeSqlExec(db), actors, a: actors.main, b: actors.sibling('scout'), store,
    events: (actor) => new RunEventRecorder(sql, actor).read(RUN, { limit: 100 }),
    tables: () => sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      .map((row) => row.name),
    close: () => db.close(),
  };
}

/**
 * The catalogue's physical name, OBSERVED rather than restated.
 *
 * `initAgentDataTables` is the production call every workspace schema makes,
 * and on an empty database it creates exactly one table — that table is the
 * catalogue. Reading the name out of the database instead of writing it here
 * ties "the table the schema creates" to "the table no logical name reaches",
 * which is the property the case below is about; a second copy of the string
 * would agree with the module by construction and could not catch it moving.
 */
function catalogueTable(): string {
  const probe = new Database(':memory:');
  try {
    initAgentDataTables(makeExecRaw(probe));
    const created = makeSql(probe)<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'`.map((row) => row.name);
    expect(created).toHaveLength(1);
    return created[0]!;
  }
  finally { probe.close(); }
}

const NOTES = {
  name: 'notes',
  scope: 'actor',
  columns: [
    { name: 'slug', type: 'text', primaryKey: true },
    { name: 'body', type: 'text' },
    { name: 'rank', type: 'integer' },
  ],
} as const;

const SHARED = {
  name: 'findings',
  scope: 'workspace',
  columns: [
    { name: 'id', type: 'text', primaryKey: true },
    { name: 'note', type: 'text' },
  ],
} as const;

describe('db value fidelity', () => {
  test('text, integer, real, blob, json and null round-trip through SQLite', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable({
        name: 'kinds',
        scope: 'actor',
        columns: [
          { name: 'k', type: 'text', primaryKey: true },
          { name: 'count', type: 'integer' },
          { name: 'ratio', type: 'real' },
          { name: 'bytes', type: 'blob' },
          { name: 'detail', type: 'json' },
          { name: 'absent', type: 'text' },
        ],
      });
      // Base64 with a byte no UTF-8 decoder would survive, so a blob that came
      // back through a text path could not read as equal.
      const bytes = 'AAECf4D//g==';
      store.apply({
        op: 'insert',
        table: 'kinds',
        rows: [{
          k: 'one',
          count: 42,
          ratio: 0.5,
          bytes,
          detail: { nested: [1, 'two', null, { deep: true }] },
          absent: null,
        }],
      });

      const [row] = store.select('kinds');
      expect(row).toEqual({
        k: 'one',
        count: 42,
        ratio: 0.5,
        bytes,
        detail: { nested: [1, 'two', null, { deep: true }] },
        absent: null,
      });
      // A blob column really holds bytes: SQLite's own type function is the
      // witness, not our decoder agreeing with our encoder.
      const stored = w.sql<{ kind: string; size: number }>`
        SELECT typeof(bytes) AS kind, length(bytes) AS size FROM app_kinds`[0];
      expect(stored).toEqual({ kind: 'blob', size: 7 });
    }
    finally { w.close(); }
  });

  test('a value the declared column cannot hold is refused, and the row is not written', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a', rank: 1.5 }] }))
        .toThrow(/integer/);
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 7 }] }))
        .toThrow(/text/);
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a', body: { not: 'text' } }] }))
        .toThrow(/text/);
      expect(store.count('notes')).toBe(0);
    }
    finally { w.close(); }
  });

  test('a not-null column omitted by a row is named, and base64 that is not base64 is refused', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable({
        name: 'strict',
        scope: 'actor',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'required', type: 'text', notNull: true },
          { name: 'blob_col', type: 'blob' },
        ],
      });
      expect(() => store.apply({ op: 'insert', table: 'strict', rows: [{ id: 'a' }] }))
        .toThrow(/required/);
      expect(() => store.apply({ op: 'insert', table: 'strict', rows: [{ id: 'a', required: null }] }))
        .toThrow(/not null/);
      expect(() => store.apply({ op: 'insert', table: 'strict', rows: [{ id: 'a', required: 'x', blob_col: 'not base64!!' }] }))
        .toThrow(/base64/);
      expect(store.count('strict')).toBe(0);
    }
    finally { w.close(); }
  });
});

describe('two actors, one database', () => {
  test('an actor-scope table hides a sibling\'s rows from select, count, update and delete', () => {
    const w = world();
    try {
      const first = w.store(w.a);
      const second = w.store(w.b);
      first.createTable(NOTES);
      // The SAME logical table and the SAME primary key from both actors.
      second.createTable(NOTES);
      first.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'shared-key', body: 'mine', rank: 1 }] });
      second.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'shared-key', body: 'theirs', rank: 2 }] });

      expect(first.select('notes')).toEqual([{ slug: 'shared-key', body: 'mine', rank: 1 }]);
      expect(second.select('notes')).toEqual([{ slug: 'shared-key', body: 'theirs', rank: 2 }]);
      expect(first.count('notes')).toBe(1);
      expect(second.count('notes')).toBe(1);
      // One physical table, two rows: the isolation is the predicate, not
      // separate storage.
      expect(w.sql<{ n: number }>`SELECT COUNT(*) AS n FROM app_notes`[0]?.n).toBe(2);

      // A blanket update and a blanket delete reach only the caller's rows.
      expect(first.apply({ op: 'update', table: 'notes', set: { body: 'edited' }, where: {} }).rowsAffected).toBe(1);
      expect(second.select('notes')).toEqual([{ slug: 'shared-key', body: 'theirs', rank: 2 }]);
      expect(first.apply({ op: 'delete', table: 'notes', where: {} }).rowsAffected).toBe(1);
      expect(second.count('notes')).toBe(1);
      expect(first.count('notes')).toBe(0);
    }
    finally { w.close(); }
  });

  test('the actor id leads the primary key, and a declared unique column is scoped too', () => {
    const w = world();
    try {
      const first = w.store(w.a);
      const second = w.store(w.b);
      first.createTable({
        name: 'labels',
        scope: 'actor',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'label', type: 'text', unique: true },
        ],
      });

      // The physical key, off the table itself. `PRAGMA table_info` is the one
      // place this suite reads schema rather than behaviour, because "the actor
      // id LEADS the key" is a property of the table and of nothing else.
      const key = w.exec.exec(`PRAGMA table_info(app_labels)`).toArray()
        .map((column) => v.parse(ColumnInfoSchema, column))
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk);
      expect(key).toEqual([{ name: 'actor_id', pk: 1 }, { name: 'id', pk: 2 }]);

      first.apply({ op: 'insert', table: 'labels', rows: [{ id: 'a', label: 'only-one' }] });
      // A sibling's identical unique value is admitted: a workspace-wide UNIQUE
      // over private rows would let one actor's value refuse another's, and
      // that refusal is itself a disclosure.
      second.apply({ op: 'insert', table: 'labels', rows: [{ id: 'a', label: 'only-one' }] });
      expect(first.count('labels')).toBe(1);
      expect(second.count('labels')).toBe(1);
      // Within one actor it is still unique, and the failure is classified as
      // the caller's input rather than as a transport fault.
      expect(() => first.apply({ op: 'insert', table: 'labels', rows: [{ id: 'b', label: 'only-one' }] }))
        .toThrow(/constraint/i);
      expect(() => first.apply({ op: 'insert', table: 'labels', rows: [{ id: 'a', label: 'other' }] }))
        .toThrow(/constraint/i);
      expect(first.count('labels')).toBe(1);
    }
    finally { w.close(); }
  });

  test('an actor-scope table with no declared key still scopes its scan by index', () => {
    const w = world();
    try {
      w.store(w.a).createTable({
        name: 'log_lines',
        scope: 'actor',
        columns: [{ name: 'line', type: 'text' }],
      });
      expect(w.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'app_log_lines'`
        .map((row) => row.name)).toEqual(['idx_app_log_lines_owner']);
    }
    finally { w.close(); }
  });

  test('a workspace-scope table is shared, and records who declared it', () => {
    const w = world();
    try {
      const first = w.store(w.a);
      const second = w.store(w.b);
      first.createTable(SHARED);
      first.apply({ op: 'insert', table: 'findings', rows: [{ id: 'f1', note: 'from main' }] });
      second.apply({ op: 'insert', table: 'findings', rows: [{ id: 'f2', note: 'from scout' }] });

      expect(second.select('findings', { orderBy: [{ column: 'id' }] }).map((row) => row.id)).toEqual(['f1', 'f2']);
      expect(first.count('findings')).toBe(2);
      expect(second.schema('findings').createdBy).toBe(w.a.actorId);
      // The catalogue is workspace-wide: the shape of a table is schema, and
      // ownership of it is stated rather than hidden.
      expect(second.listTables().map((table) => ({ name: table.name, scope: table.scope, by: table.createdBy })))
        .toEqual([{ name: 'findings', scope: 'workspace', by: w.a.actorId }]);
    }
    finally { w.close(); }
  });

  test('one actor cannot drop a physical actor-scope table holding a sibling\'s rows', () => {
    const w = world();
    try {
      const first = w.store(w.a);
      const second = w.store(w.b);
      first.createTable(NOTES);
      second.createTable(NOTES);
      second.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'theirs', body: 'keep me' }] });

      expect(() => first.dropTable('notes')).toThrow(/other agents/);
      expect(w.tables()).toContain('app_notes');
      expect(second.count('notes')).toBe(1);

      // A non-declarer cannot drop it at all, whoever holds rows.
      expect(() => second.dropTable('notes')).toThrow(/declared by another agent/);

      // Once the sibling's rows are gone the declarer may retire it, and the
      // catalogue row goes with the table.
      second.apply({ op: 'delete', table: 'notes', where: {} });
      first.dropTable('notes');
      expect(w.tables()).not.toContain('app_notes');
      expect(first.listTables()).toEqual([]);
      expect(() => second.select('notes')).toThrow(/no table/);
    }
    finally { w.close(); }
  });

  test('a retired actor stops reaching its own rows', () => {
    const w = world();
    try {
      const store = w.store(w.b);
      store.createTable(NOTES);
      store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a', body: 'written while live' }] });

      w.actors.directory.apply(w.a, [], {
        action: 'retire',
        name: 'scout',
        reference: { actorId: w.b.actorId, workspaceId: w.b.workspaceId, parentActorId: w.b.parentActorId },
      });

      // Every operation re-validates the binding before its statement, so a
      // read refuses for the same reason a write does.
      expect(() => store.select('notes')).toThrow();
      expect(() => store.count('notes')).toThrow();
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'b' }] })).toThrow();
      expect(() => store.listTables()).toThrow();
      // The rows themselves are retained: dismissal is not deletion.
      expect(w.sql<{ n: number }>`SELECT COUNT(*) AS n FROM app_notes`[0]?.n).toBe(1);
    }
    finally { w.close(); }
  });

  test('a handle whose binding is revoked mid-life is refused before the statement', () => {
    const w = world();
    try {
      let live = true;
      const revocable = testActorHandle(w.sql, { actorId: w.a.actorId, live: () => live });
      const store = createAppDataStore({
        sql: w.sql, actor: revocable,
        transactionSync: (write) => w.db.transaction(write)(),
        events: () => new RunEventRecorder(w.sql, revocable),
        runId: () => RUN,
      });
      store.createTable(NOTES);
      live = false;
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a' }] })).toThrow(/no longer bound/);
      live = true;
      expect(store.count('notes')).toBe(0);
    }
    finally { w.close(); }
  });
});

describe('what db cannot reach', () => {
  test('a host table is not addressable, and sqlite_master is unchanged by trying', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      const before = w.tables();
      // Host tables of every protected family: identity, roster, conversation,
      // credentials, approvals, claims, audit, effect claims, config, and the
      // `db` catalogue itself.
      for (const name of [
        'workspace_identity', 'workspace_actors', 'messages', 'workspace_capability',
        'webhook_secrets', 'deferred_approvals', 'actor_turn_claims', 'run_events',
        'tool_effect_claims', 'effect_tombstones', 'actor_config', 'actor_program_state',
        catalogueTable(), 'sqlite_master', 'sqlite_sequence',
      ]) {
        expect(() => store.select(name)).toThrow();
        expect(() => store.apply({ op: 'delete', table: name, where: {} })).toThrow();
        expect(() => store.dropTable(name)).toThrow();
      }
      // A protected name cannot be declared into the catalogue either: the
      // physical table would be `app_<name>`, which is a different object.
      const identity = store.createTable({
        name: 'workspace_identity',
        scope: 'actor',
        columns: [{ name: 'id', type: 'text', primaryKey: true }],
      });
      expect(identity.name).toBe('workspace_identity');
      expect(w.sql<{ id: string }>`SELECT id FROM workspace_identity`.length).toBe(1);
      expect(w.tables()).toEqual([...before, 'app_workspace_identity'].sort());
    }
    finally { w.close(); }
  });

  test('a name that is not an identifier is refused rather than compiled', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      const before = w.tables();
      for (const name of [
        'notes; DROP TABLE messages',
        'notes" ; DROP TABLE messages --',
        'Notes',
        'app notes',
        '../notes',
        '',
        'a'.repeat(49),
      ]) {
        expect(() => store.createTable({ name, scope: 'actor', columns: [{ name: 'a', type: 'text' }] }))
          .toThrow(/name/);
        expect(() => store.select(name)).toThrow();
      }
      expect(w.tables()).toEqual(before);

      // `sqlite_master` IS a usable LOGICAL name, and that is the point of the
      // prefix rather than a hole in it: the physical table is
      // `app_sqlite_master`, so SQLite's own catalogue is neither shadowed nor
      // reachable, and nothing had to be added to a list of forbidden words.
      store.createTable({ name: 'sqlite_master', scope: 'actor', columns: [{ name: 'a', type: 'text' }] });
      expect(w.tables()).toEqual([...before, 'app_sqlite_master'].sort());
      expect(w.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name = 'app_sqlite_master'`).toHaveLength(1);
    }
    finally { w.close(); }
  });

  test('a column the table never declared is refused everywhere a column is named', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a', body: 'x' }] });

      expect(() => store.select('notes', { columns: ['nope'] })).toThrow(/declares no column/);
      expect(() => store.select('notes', { where: { nope: 1 } })).toThrow(/declares no column/);
      expect(() => store.select('notes', { orderBy: [{ column: 'nope' }] })).toThrow(/declares no column/);
      expect(() => store.count('notes', { nope: 1 })).toThrow(/declares no column/);
      expect(() => store.apply({ op: 'update', table: 'notes', set: { nope: 1 }, where: {} })).toThrow(/declares no column/);
      expect(() => store.apply({ op: 'insert', table: 'notes', rows: [{ nope: 1 }] })).toThrow(/declares no column/);
    }
    finally { w.close(); }
  });

  test('the host\'s own actor column can neither be declared nor named', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      expect(() => store.createTable({
        name: 'sneaky',
        scope: 'actor',
        columns: [{ name: 'actor_id', type: 'text', primaryKey: true }],
      })).toThrow(/actor_id/);
      store.createTable(NOTES);
      store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a' }] });
      // Naming the injected column is a column the table does not declare, on
      // every surface — including a read that would have exposed the owner.
      expect(() => store.select('notes', { columns: ['actor_id'] })).toThrow(/actor_id/);
      expect(() => store.select('notes', { where: { actor_id: w.b.actorId } })).toThrow(/actor_id/);
      expect(() => store.apply({ op: 'update', table: 'notes', set: { actor_id: w.b.actorId }, where: {} }))
        .toThrow(/actor_id/);
      // Nor is it returned by an unprojected read.
      expect(Object.keys(store.select('notes')[0] ?? {})).toEqual(['slug', 'body', 'rank']);
    }
    finally { w.close(); }
  });

  test('a physical table outside the catalogue is not adopted as agent data', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      // A host table, or a leftover of one, that happens to carry the agent
      // prefix. Declaring over it would hand its rows to the caller.
      w.db.exec(`CREATE TABLE app_secrets (token TEXT)`);
      w.db.exec(`INSERT INTO app_secrets (token) VALUES ('sk-live')`);
      expect(() => store.createTable({
        name: 'secrets',
        scope: 'actor',
        columns: [{ name: 'token', type: 'text' }],
      })).toThrow(/outside the agent-data catalogue/);
      expect(() => store.select('secrets')).toThrow(/no table/);
      expect(w.sql<{ token: string }>`SELECT token FROM app_secrets`[0]?.token).toBe('sk-live');
      expect(store.listTables()).toEqual([]);
    }
    finally { w.close(); }
  });

  test('a differing redeclaration is refused and leaves the catalogue describing the real table', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a', body: 'kept' }] });

      expect(() => store.createTable({
        name: 'notes',
        scope: 'workspace',
        columns: [{ name: 'slug', type: 'text', primaryKey: true }],
      })).toThrow(/already exists/);
      expect(() => store.createTable({
        name: 'notes',
        scope: 'actor',
        columns: [{ name: 'slug', type: 'integer', primaryKey: true }],
      })).toThrow(/already exists/);
      // Column ORDER is part of the shape, because the physical table has one.
      expect(() => store.createTable({
        name: 'notes',
        scope: 'actor',
        columns: [
          { name: 'body', type: 'text' },
          { name: 'slug', type: 'text', primaryKey: true },
          { name: 'rank', type: 'integer' },
        ],
      })).toThrow(/already exists/);

      // Neither the catalogue nor the data moved, and the identical
      // declaration is still accepted.
      expect(store.schema('notes')).toMatchObject({ scope: 'actor', createdBy: w.a.actorId });
      expect(store.select('notes')).toEqual([{ slug: 'a', body: 'kept', rank: null }]);
      expect(store.createTable(NOTES).name).toBe('notes');
      expect(store.select('notes')).toEqual([{ slug: 'a', body: 'kept', rank: null }]);
      expect(w.events(w.a).filter((event) => event.type === 'db_op' && event.op === 'createTable')).toHaveLength(1);
    }
    finally { w.close(); }
  });

  test('predicates take values, not fragments, and like only compares text', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      store.apply({
        op: 'insert',
        table: 'notes',
        rows: [
          { slug: 'a', body: '100% sure', rank: 1 },
          { slug: 'b', body: 'maybe', rank: 2 },
          { slug: 'c', body: null, rank: 3 },
        ],
      });

      // A string that would be an operator if it were text got bound as a value.
      expect(store.count('notes', { slug: "a' OR '1'='1" })).toBe(0);
      expect(store.count('notes', { body: { op: 'like', value: '100\\%%' } })).toBe(1);
      expect(store.count('notes', { rank: { op: '>=', value: 2 } })).toBe(2);
      expect(store.count('notes', { slug: { op: 'in', values: ['a', 'c'] } })).toBe(2);
      expect(store.count('notes', { slug: { op: 'in', values: [] } })).toBe(0);
      expect(store.count('notes', { body: { op: 'isNull' } })).toBe(1);
      expect(store.count('notes', { body: { op: 'notNull' } })).toBe(2);
      expect(() => store.count('notes', { rank: { op: 'like', value: '1' } })).toThrow(/like/);
      expect(() => store.count('notes', { rank: { op: 'drop', value: 1 } })).toThrow();
      expect(store.select('notes', { orderBy: [{ column: 'rank', dir: 'desc' }], limit: 2 })
        .map((row) => row.slug)).toEqual(['c', 'b']);
      expect(store.select('notes', { orderBy: [{ column: 'rank' }], limit: 1, offset: 2 })
        .map((row) => row.slug)).toEqual(['c']);
    }
    finally { w.close(); }
  });
});

describe('batch atomicity and evidence', () => {
  const ops = (extra: AppOp): readonly AppOp[] => [
    { op: 'insert', table: 'notes', rows: [{ slug: 'first', body: 'one' }] },
    { op: 'insert', table: 'notes', rows: [{ slug: 'second', body: 'two' }] },
    extra,
  ];

  test('a failing operation rolls the whole batch back and names its index', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      // The third operation collides with the first on the primary key, so it
      // is SQLite that refuses rather than a pre-flight check.
      let failedIndex: unknown;
      try {
        store.batch(ops({ op: 'insert', table: 'notes', rows: [{ slug: 'first', body: 'again' }] }));
      }
      catch (cause) {
        failedIndex = cause instanceof Error && 'failedIndex' in cause ? cause.failedIndex : undefined;
      }
      expect(failedIndex).toBe(2);
      expect(store.count('notes')).toBe(0);
      // No ghost evidence: a mutation that did not happen recorded nothing,
      // including for the two operations that had already succeeded.
      expect(w.events(w.a).filter((event) => event.type === 'db_op' && event.op === 'insert')).toEqual([]);
    }
    finally { w.close(); }
  });

  test('a batch that lands writes one evidence row per operation, all naming the batch', () => {
    const w = world();
    try {
      const store = w.store(w.a);
      store.createTable(NOTES);
      const results = store.batch(ops({ op: 'update', table: 'notes', set: { rank: 9 }, where: {} }));
      expect(results.map((result) => result.rowsAffected)).toEqual([1, 1, 2]);
      expect(store.select('notes', { orderBy: [{ column: 'slug' }] }).map((row) => row.rank)).toEqual([9, 9]);

      const written = w.events(w.a).filter((event) => event.type === 'db_op' && event.op !== 'createTable');
      expect(written).toMatchObject([
        { type: 'db_op', op: 'insert', table: 'notes', scope: 'actor', rowsAffected: 1, batch: 3 },
        { type: 'db_op', op: 'insert', table: 'notes', scope: 'actor', rowsAffected: 1, batch: 3 },
        { type: 'db_op', op: 'update', table: 'notes', scope: 'actor', rowsAffected: 2, batch: 3 },
      ]);
      // Through the durable parser, not the in-memory value: the evidence has
      // to read back off the row.
      const stored = w.sql<{ payload: string }>`SELECT payload FROM run_events WHERE type = 'db_op' ORDER BY event_index`
        .map((row) => parseStoredRunEvent(row.payload));
      expect(stored.flatMap((event) => (event.type === 'db_op' ? [event.batch] : []))).toEqual([null, 3, 3, 3]);
    }
    finally { w.close(); }
  });

  test('a batch rolls back when the EVIDENCE write fails, and publishes nothing', () => {
    const w = world();
    try {
      const seen: RunEvent[] = [];
      let failEvidence = false;
      // A genuinely unwritable log: the recorder is the production class over a
      // SQL handle that refuses the one statement it persists with. Nothing
      // about the store is replaced.
      const cutting: SqlExecutor = <Row = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): Row[] => {
        if (failEvidence && query.join('?').includes('INSERT INTO run_events')) {
          throw new Error('the event log is unwritable');
        }
        return w.sql<Row>(query, ...values);
      };
      const recorder = new RunEventRecorder(cutting, w.a);
      recorder.observe((event) => { seen.push(event); });
      const store = createAppDataStore({
        sql: w.sql, actor: w.a,
        transactionSync: (write) => w.db.transaction(write)(),
        events: () => recorder,
        runId: () => RUN,
      });
      store.createTable(NOTES);
      seen.length = 0;
      failEvidence = true;

      expect(() => store.batch([
        { op: 'insert', table: 'notes', rows: [{ slug: 'a' }] },
        { op: 'insert', table: 'notes', rows: [{ slug: 'b' }] },
      ])).toThrow(/unwritable/);
      failEvidence = false;
      // Neither the data nor a notification survived: evidence and effect are
      // one transaction.
      expect(store.count('notes')).toBe(0);
      expect(seen).toEqual([]);
    }
    finally { w.close(); }
  });

  test('a live subscriber hears a committed mutation exactly once', () => {
    const w = world();
    try {
      const heard: string[] = [];
      const recorder = new RunEventRecorder(w.sql, w.a);
      recorder.observe((event) => { if (event.type === 'db_op') heard.push(`${event.op}:${event.rowsAffected}`); });
      const store = createAppDataStore({
        sql: w.sql, actor: w.a,
        transactionSync: (write) => w.db.transaction(write)(),
        events: () => recorder,
        runId: () => RUN,
      });
      store.createTable(NOTES);
      store.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'a' }, { slug: 'b' }] });
      expect(heard).toEqual(['createTable:0', 'insert:2']);
    }
    finally { w.close(); }
  });
});

describe('role and Plan authority', () => {
  test('db is a declared namespace a role can lose and can name', () => {
    expect(TOOL_REACH.db).toEqual({ native: false, codemode: 'db', replay: 'claimed' });
    expect(codemodeCapabilitiesFor([{ name: 'db' }])).toEqual(['db']);
    expect(narrowToolSurface(['execute_tools']).allowsNamespace('db')).toBe(false);
    expect(narrowToolSurface(['execute_tools', 'db']).allowsNamespace('db')).toBe(true);
    expect(narrowToolSurface(undefined).allowsNamespace('db')).toBe(true);
    expect(narrowToolSurface(['execute_tools']).narrowProviders([{ name: 'db' }, { name: 'state' }]))
      .toEqual([{ name: 'state' }]);
  });

  test('Plan writes its own research state and is denied the workspace\'s', async () => {
    const w = world();
    try {
      const store = w.store(w.a);
      const provider = providersInWorkMode('plan', [createDbCodemodeProvider(store)]);
      const db = provider[0]?.tools;
      if (db === undefined) throw new Error('no db namespace');

      // Private research state: declare an actor-scope table and write it.
      expect(await inWorkMode('plan', () => db.createTable.execute(NOTES)))
        .toMatchObject({ name: 'notes', scope: 'actor' });
      expect(await inWorkMode('plan', () => db.insert.execute('notes', [{ slug: 'a', body: 'planning' }])))
        .toEqual({ rowsAffected: 1 });
      expect(await inWorkMode('plan', () => db.update.execute('notes', { body: 'still planning' }, {})))
        .toEqual({ rowsAffected: 1 });
      expect(await inWorkMode('plan', () => db.select.execute('notes')))
        .toEqual([{ slug: 'a', body: 'still planning', rank: null }]);
      expect(await inWorkMode('plan', () => db.count.execute('notes'))).toBe(1);
      expect(await inWorkMode('plan', () => db.listTables.execute())).toHaveLength(1);

      // A workspace mutation is external to the actor, and Plan does not make
      // those — declaring the shared table included.
      expect(await inWorkMode('plan', () => db.createTable.execute(SHARED)))
        .toMatchObject({ reason: 'denied' });
      expect(await inWorkMode('plan', () => db.dropTable.execute('notes')))
        .toMatchObject({ reason: 'denied' });
      expect(w.tables()).toContain('app_notes');
      expect(w.tables()).not.toContain('app_findings');

      // The same members on a Build turn are permitted, which is what makes
      // the refusals above a mode decision rather than an absent capability.
      store.createTable(SHARED);
      expect(store.apply({ op: 'insert', table: 'findings', rows: [{ id: 'f1' }] }).rowsAffected).toBe(1);
      // And a workspace table already declared still refuses a Plan write.
      expect(await inWorkMode('plan', () => db.insert.execute('findings', [{ id: 'f2' }])))
        .toMatchObject({ reason: 'denied' });
      expect(store.count('findings')).toBe(1);
    }
    finally { w.close(); }
  });

  test('a refusal is data a program can branch on, and carries its class', async () => {
    const w = world();
    try {
      const store = w.store(w.a);
      const db = createDbCodemodeProvider(store).tools;
      expect(await db.select.execute('messages')).toMatchObject({ reason: 'missing' });
      expect(await db.createTable.execute({ name: 'x', scope: 'actor', columns: [] }))
        .toMatchObject({ reason: 'bad_input' });
      expect(await db.select.execute('notes; DROP TABLE messages')).toMatchObject({ reason: 'bad_input' });
      await db.createTable.execute(NOTES);
      const batch = await db.batch.execute([
        { op: 'insert', table: 'notes', rows: [{ slug: 'a' }] },
        { op: 'insert', table: 'notes', rows: [{ slug: 'a' }] },
      ]);
      expect(batch).toMatchObject({ reason: 'bad_input', failedIndex: 1 });
      expect(store.count('notes')).toBe(0);
    }
    finally { w.close(); }
  });

  test('the declaration the model reads names the namespace once and states its scoping', () => {
    const w = world();
    try {
      const provider = createDbCodemodeProvider(w.store(w.a));
      expect(provider.name).toBe('db');
      const types = provider.types ?? '';
      expect(types.match(/export declare const db:/gu)).toHaveLength(1);
      expect(types).toContain("scope: 'actor'");
      expect(types).toContain('No operation takes SQL');
      // No second name for the same capability.
      expect(types).not.toContain('env.db');
      expect(Object.keys(provider.tools).sort()).toEqual([
        'batch', 'count', 'createTable', 'deleteRows', 'dropTable', 'insert', 'listTables', 'schema', 'select', 'update',
      ]);
    }
    finally { w.close(); }
  });
});

describe('agent data in the one workspace snapshot', () => {
  test('the catalogue and both actors\' rows export and restore into an empty database', async () => {
    const w = world();
    try {
      const first = w.store(w.a);
      const second = w.store(w.b);
      first.createTable(NOTES);
      second.createTable(NOTES);
      first.createTable(SHARED);
      first.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'k', body: 'main row', rank: 1 }] });
      second.apply({ op: 'insert', table: 'notes', rows: [{ slug: 'k', body: 'scout row', rank: 2 }] });
      first.apply({ op: 'insert', table: 'findings', rows: [{ id: 'f1', note: 'shared' }] });

      const lines = await writeWorkspaceArchive(archiveSqlFromDatabase(w.db), {
        workspace: 'db-archive', source: 'local', now: 1,
      });
      const target = new Database(':memory:');
      try {
        await restoreWorkspaceArchive(archiveSqlFromDatabase(target), lines);
        const restoredSql = makeSql(target);
        // The catalogue comes back through a production store bound to the
        // RESTORED database, so what is asserted is that the `db` capability
        // still resolves both declarations there — not that bytes reached a
        // table this test names. `listTables` orders by creation time, so the
        // comparison sorts by name and does not rest on two writes landing in
        // different milliseconds.
        const restoredActor = testActorHandle(restoredSql, { actorId: w.a.actorId });
        const restored = createAppDataStore({
          sql: restoredSql, actor: restoredActor,
          transactionSync: (write) => target.transaction(write)(),
          events: () => new RunEventRecorder(restoredSql, restoredActor),
          runId: () => RUN,
        });
        expect(restored.listTables()
          .map(({ name, scope }) => ({ name, scope }))
          .sort((left, right) => left.name.localeCompare(right.name))).toEqual([
          { name: 'findings', scope: 'workspace' },
          { name: 'notes', scope: 'actor' },
        ]);
        // And the capability reads its own row out of the restored physical
        // table, scoped to the actor the store is bound to.
        expect(restored.select('notes')).toEqual([{ slug: 'k', body: 'main row', rank: 1 }]);
        // The rows come back with their owners, so the restored workspace's
        // isolation is the same isolation.
        expect(restoredSql<{ actor_id: string; body: string }>`
          SELECT actor_id, body FROM app_notes ORDER BY body`).toEqual([
          { actor_id: w.a.actorId, body: 'main row' },
          { actor_id: w.b.actorId, body: 'scout row' },
        ]);
        expect(restoredSql<{ note: string }>`SELECT note FROM app_findings`).toEqual([{ note: 'shared' }]);
      }
      finally { target.close(); }
    }
    finally { w.close(); }
  });
});

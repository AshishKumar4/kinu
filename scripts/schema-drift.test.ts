import { describe, expect, test } from 'bun:test';
import {
  ddlIn,
  driftViolations,
  genesisForNewTable,
  lockKey,
  lockUpdate,
  survey,
  type GenesisLock,
  type TableDdl,
  viewDriftViolations,
} from './schema-drift';
import { readSources } from './sources';
import type { Names } from './sql-text';
import { statementsOf } from './vendor-schema';

const USER_DEVICES_GENESIS = [
  'id', 'token_hash', 'label', 'os', 'hostname', 'created_at', 'connected_at', 'last_seen_at',
  'revoked_at',
];

/** The shape the production 500 shipped in: six device-hardening columns in
 *  the DDL that the storage created at genesis never had. */
const DRIFTED_DEVICES: TableDdl = {
  table: 'user_devices',
  file: 'packages/cf-backend/src/user/schema.ts',
  parts: [...USER_DEVICES_GENESIS, 'prev_token_hash', 'expires_at', 'last_ip', 'last_agent',
    'replaced_at', 'unstopped_at'],
};

const DEVICES_LOCK: GenesisLock = {
  [lockKey(DRIFTED_DEVICES.table, DRIFTED_DEVICES.file)]: USER_DEVICES_GENESIS,
};

describe('schema-drift DDL census', () => {
  // Every shape below was measured in this tree, and the previous regex — which
  // required the closing paren on a line of its own and read the table name as
  // `\w+` — reported on 114 of the 126 statements it claimed.
  test('reads a one-line DDL, nested parens and comment prose carrying commas', () => {
    const parsed = ddlIn('fixture.ts', `
      execRaw('CREATE TABLE IF NOT EXISTS flat (id TEXT PRIMARY KEY, n INTEGER)');
      sql.exec(\`
        CREATE TABLE IF NOT EXISTS nested (
          id    INTEGER PRIMARY KEY CHECK (id = 1),
          -- Provenance of the accept, and the record that a socket took the slot.
          made  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (id, made)
        )
      \`);
    `).tables;

    expect(parsed).toEqual([
      { table: 'flat', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY', 'n INTEGER'] },
      {
        table: 'nested', file: 'fixture.ts',
        parts: ['id INTEGER PRIMARY KEY CHECK (id = 1)', 'made INTEGER NOT NULL DEFAULT (unixepoch() * 1000)', 'PRIMARY KEY (id, made)'],
      },
    ]);
  });

  test('a prose mention of the statement is not a table', () => {
    // `CREATE TABLE IF NOT EXISTS is a no-op …` was censused as a table named
    // `is`; two more sentences produced `will` and `quietly`.
    expect(ddlIn('fixture.ts', `
      // CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists.
      /** CREATE TABLE IF NOT EXISTS will not add a column to an older workspace. */
    `)).toEqual({ tables: [], views: [], runtimeNamed: 0 });
  });

  test('reads a body built from a template constant and from a generated column block', () => {
    const parsed = ddlIn('fixture.ts', `
      const USAGE = { token_input: 'INTEGER', neurons: 'REAL' } as const;
      const BLOCK = Object.entries(USAGE).map(([c, t]) => \`  \${c} \${t}\`).join(',\\n');
      const JOURNAL_DDL = \`(
        id TEXT PRIMARY KEY,
      \${BLOCK}
      )\`;
      execRaw(\`CREATE TABLE IF NOT EXISTS journal \${JOURNAL_DDL}\`);
      execRaw(\`CREATE TABLE IF NOT EXISTS inline (
        id TEXT PRIMARY KEY,
      \${Object.entries(USAGE).map(([c, t]) => \`  \${c} \${t},\`).join('\\n')}
        tail TEXT
      )\`);
    `).tables;

    expect(parsed).toEqual([
      { table: 'journal', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY', 'token_input TEXT', 'neurons TEXT'] },
      { table: 'inline', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY', 'token_input TEXT', 'neurons TEXT', 'tail TEXT'] },
    ]);
  });

  test('fails closed on an interpolation it cannot resolve; a table named at runtime is counted apart', () => {
    expect(() => ddlIn('fixture.ts', `
      execRaw(\`CREATE TABLE IF NOT EXISTS mystery (
        id TEXT PRIMARY KEY,
      \${buildColumns()}
      )\`);
    `)).toThrow(/mystery has a body part this cannot read/u);

    expect(ddlIn('fixture.ts', `
      execRaw(\`CREATE TABLE IF NOT EXISTS \${quoted(spec.name)} (\${columns.join(', ')})\`);
    `)).toEqual({ tables: [], views: [], runtimeNamed: 1 });
  });

  test('a table declared twice in one file carries the union of both statements', () => {
    expect(ddlIn('fixture.ts', `
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, first INTEGER)');
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, second INTEGER)');
    `).tables).toEqual([{ table: 'both', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY', 'first INTEGER', 'second INTEGER'] }]);
  });

  test('a view is its whole definition, read to the end of the template it opens', () => {
    expect(ddlIn('fixture.ts', `
      execRaw(\`CREATE VIEW IF NOT EXISTS scores AS
        SELECT *, CASE WHEN parent_id IS NULL THEN value
          -- The root keeps its mean.
          ELSE 0 END AS own
        FROM nodes\`);
    `).views).toEqual([{
      table: 'scores', file: 'fixture.ts',
      parts: ['SELECT *, CASE WHEN parent_id IS NULL THEN value ELSE 0 END AS own FROM nodes'],
    }]);
  });

  test('fails closed on a view definition that interpolates a value', () => {
    expect(() => ddlIn('fixture.ts', `
      execRaw(\`CREATE VIEW IF NOT EXISTS built AS SELECT \${columns} FROM nodes\`);
    `)).toThrow(/view built has a definition this cannot read/u);

    // A definition ends where its statement does, never at the next statement's text.
    expect(ddlIn('fixture.ts', `
      execRaw('CREATE VIEW IF NOT EXISTS quoted AS SELECT 1');
      execRaw(\`CREATE INDEX IF NOT EXISTS idx_later ON later(id)\`);
    `).views).toEqual([{ table: 'quoted', file: 'fixture.ts', parts: ['SELECT 1'] }]);
  });

  test('RED: every spelling SQLite accepts is a table, and a DDL body is read as SQL', () => {
    // Each of these was invisible to the regex census, or read short of its body.
    const parsed = ddlIn('fixture.ts', `
      execRaw('create table if not exists lower_case (id text primary key)');
      execRaw('CREATE TABLE IF NOT EXISTS main."quoted" (id TEXT PRIMARY KEY)');
      execRaw('CREATE /* one owner */ TABLE IF NOT EXISTS commented (id TEXT PRIMARY KEY)');
      execRaw('CREATE TABLE plain (id TEXT PRIMARY KEY)');
      execRaw("CREATE TABLE IF NOT EXISTS dashes (sep TEXT DEFAULT '--', n INTEGER)");
      const COLUMNS = \`(id TEXT PRIMARY KEY, n INTEGER)\`;
      const BODY = COLUMNS;
      execRaw(\`CREATE TABLE IF NOT EXISTS two_steps \${BODY}\`);
    `).tables;

    expect(parsed).toEqual([
      { table: 'lower_case', file: 'fixture.ts', parts: ['id text primary key'] },
      { table: 'quoted', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY'] },
      { table: 'commented', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY'] },
      { table: 'plain', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY'] },
      { table: 'dashes', file: 'fixture.ts', parts: ['sep TEXT DEFAULT \'--\'', 'n INTEGER'] },
      { table: 'two_steps', file: 'fixture.ts', parts: ['id TEXT PRIMARY KEY', 'n INTEGER'] },
    ]);
  });

  test('RED: a view spelled in lower case or behind a comment is a view', () => {
    expect(ddlIn('fixture.ts', `
      execRaw(\`create view if not exists lower_view as select 1 as one\`);
      execRaw(\`CREATE -- one owner
        VIEW IF NOT EXISTS commented_view AS SELECT 2 AS two\`);
    `).views).toEqual([
      { table: 'lower_view', file: 'fixture.ts', parts: ['select 1 as one'] },
      { table: 'commented_view', file: 'fixture.ts', parts: ['SELECT 2 AS two'] },
    ]);
  });
});

describe('schema-drift genesis comparison', () => {
  test('RED: a column added after genesis names the table and every column', () => {
    const violations = driftViolations([DRIFTED_DEVICES], DEVICES_LOCK);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe('user_devices@packages/cf-backend/src/user/schema.ts');
    expect(violations[0]?.detail).toContain('unstopped_at');
    expect(violations[0]?.detail).toContain('prev_token_hash');
    expect(violations[0]?.detail).toContain('added after genesis');
  });

  test('RED: a column removed after genesis is the other direction of the same drift', () => {
    const narrowed: TableDdl = { ...DRIFTED_DEVICES, parts: ['id', 'token_hash'] };
    const detail = driftViolations([narrowed], DEVICES_LOCK)[0]?.detail ?? '';

    expect(detail).toContain('removed after genesis');
    expect(detail).toContain('revoked_at');
    expect(detail).not.toContain('added after genesis');
  });

  test('GREEN: a DDL that matches its genesis, in any column order', () => {
    const reordered: TableDdl = {
      ...DRIFTED_DEVICES, parts: [...USER_DEVICES_GENESIS].reverse(),
    };

    expect(driftViolations([reordered], DEVICES_LOCK)).toEqual([]);
  });

  test('RED: a table with no genesis entry is a violation, never an empty comparison', () => {
    const violations = driftViolations([DRIFTED_DEVICES], {});

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('no entry in scripts/schema-genesis.lock.json');
  });

  test('RED: a changed CHECK on a shipped table is drift, though every column is still there', () => {
    // 5f2881a86 widened `name_origin`'s CHECK. Every column matched its genesis,
    // so the column-only gate was green, and every account older than the
    // deploy refused the new value (2026-09-22).
    const key = lockKey('user_workspaces', 'packages/core/src/state/user-schema.ts');
    const genesis = ['name TEXT PRIMARY KEY', "name_origin TEXT NOT NULL CHECK (name_origin IN ('auto', 'user'))"];

    const widened: TableDdl = {
      table: 'user_workspaces', file: 'packages/core/src/state/user-schema.ts',
      parts: ['name TEXT PRIMARY KEY', "name_origin TEXT NOT NULL CHECK (name_origin IN ('auto', 'provisional', 'user'))"],
    };

    const detail = driftViolations([widened], { [key]: genesis })[0]?.detail ?? '';

    expect(detail).toContain('a definition changed after genesis');
    expect(detail).toContain("('auto', 'provisional', 'user')");
    expect(detail).not.toContain('added after genesis');
    expect(lockUpdate([widened], { [key]: genesis }, () => widened.parts).refused).toHaveLength(1);
  });
});

describe('schema-drift genesis lock', () => {
  test('locks a table that has no entry', () => {
    const update = lockUpdate([DRIFTED_DEVICES], {}, () => USER_DEVICES_GENESIS);

    expect(update.added).toEqual(['user_devices@packages/cf-backend/src/user/schema.ts']);
    expect(update.refused).toEqual([]);
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: refuses to WIDEN an existing entry, which would excuse the added columns', () => {
    const update = lockUpdate([DRIFTED_DEVICES], DEVICES_LOCK, () => DRIFTED_DEVICES.parts);

    expect(update.added).toEqual([]);
    expect(update.refused).toHaveLength(1);
    expect(update.refused[0]).toContain('unstopped_at');
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: refuses to NARROW an existing entry, which would report columns the table shipped with', () => {
    const update = lockUpdate([DRIFTED_DEVICES], DEVICES_LOCK, () => ['id', 'token_hash']);

    expect(update.refused).toHaveLength(1);
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: a widened table is refused even through the namesake-filtering genesis --lock actually calls', () => {
    // The deployed call shape is `lockUpdate(tables, lock, (t) =>
    // genesisForNewTable(t, lock))`, and `genesisForNewTable` answers the
    // intersection of the locked namesakes — for a table that HAS an entry,
    // that intersection is the entry's own list. A widen under it must still
    // be refused against `table.parts`, or `--lock` launders a shipped-table
    // change into silence.
    const update = lockUpdate(
      [DRIFTED_DEVICES], DEVICES_LOCK,
      (table) => genesisForNewTable(table, DEVICES_LOCK),
    );

    expect(update.added).toEqual([]);
    expect(update.refused).toHaveLength(1);
    expect(update.refused[0]).toContain('unstopped_at');
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: a DDL moved to another file inherits the narrowest locked genesis', () => {
    // Relocate the statement and the new key would lock at TODAY's shape,
    // excusing the six columns the move carried with it.
    const moved: TableDdl = {
      table: 'user_devices',
      file: 'packages/cf-backend/src/user/device-schema.ts',
      parts: DRIFTED_DEVICES.parts,
    };

    expect(genesisForNewTable(moved, DEVICES_LOCK)).toEqual(USER_DEVICES_GENESIS);
  });

  test('a genuinely new table with no namesake locks at its own shape', () => {
    const fresh: TableDdl = {
      table: 'schema_drift_probe',
      file: 'packages/cf-backend/src/user/absent.ts',
      parts: ['id', 'made_at'],
    };

    expect(genesisForNewTable(fresh, DEVICES_LOCK)).toEqual(['id', 'made_at']);
  });
});

describe('schema-drift over this tree', () => {
  test('the product SQL corpus never names the retired actor table or indexes', () => {
    const sources = readSources();

    const retired = ({ tables, indexes }: Names) => tables.has('messages')
      || [...indexes].some((index) => index.startsWith('conversation_rev_messages_') || index.startsWith('idx_msg_'));

    const violations = [...sources].flatMap(([file, source]) =>
      statementsOf(file, source)
        .filter(({ names }) => retired(names))
        .map(({ line }) => `${file}:${line}`));

    expect(sources.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);

    console.log(`actor schema: scanned SQL templates in ${sources.size} product files; blind: runtime-built SQL and test-only fixtures`);
  });

  test('every table is locked, censused and equal to its genesis', () => {
    const state = survey();

    expect(state.violations).toEqual([]);
    // The census is the governed set: a gate whose corpus quietly shrinks is the
    // defect this file exists to make impossible. 115 is the count at the reset
    // genesis, after `crafted_tools` lost its two duplicate declarations and
    // kept one owner (`@kinu.run/agent-utils`), and after `agent_views` left
    // with the views DSL (0dba3bd8c). A table that leaves lowers this number
    // in the same commit, with its reason here.
    expect(state.tables.length).toBeGreaterThanOrEqual(115);
    // The three event-log views and `search_node_scores`.
    expect(state.views.length).toBeGreaterThanOrEqual(4);
  });

  test('RED: a constraint planted on any table of this tree fails the gate for that table alone', () => {
    // The direction this gate claims, proven on every table it governs rather
    // than on a fixture: one definition gains a CHECK, and the verdict names it.
    const state = survey();

    for (const table of state.tables) {
      const [first, ...rest] = table.parts;

      if (first === undefined) throw new Error(`${table.table} parsed no parts`);
      const planted: TableDdl = { ...table, parts: [`${first} CHECK (1 = 1)`, ...rest] };
      const violations = driftViolations([planted], state.lock);

      expect(violations.map(({ key }) => key)).toEqual([lockKey(table.table, table.file)]);
      expect(violations[0]?.detail).toContain('a definition changed after genesis');
    }
  });

  test('RED: a change planted in any view of this tree fails the gate for that view alone', () => {
    const state = survey();

    for (const view of state.views) {
      const planted: TableDdl = { ...view, parts: view.parts.map((part) => `${part} LIMIT 1`) };
      const violations = viewDriftViolations([planted], state.lock);

      expect(violations.map(({ key }) => key)).toEqual([lockKey(view.table, view.file)]);
      expect(violations[0]?.detail).toContain('CREATE VIEW IF NOT EXISTS never replaces a view');
    }
  });
});

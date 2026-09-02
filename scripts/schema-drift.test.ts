import { describe, expect, test } from 'bun:test';
import {
  driftViolations,
  genesisForNewTable,
  inspectBackfillCalls,
  lockKey,
  lockUpdate,
  moverViolations,
  parseTables,
  readGenesisLock,
  survey,
  tablesIn,
  type GenesisLock,
  type TableDdl,
} from './schema-drift';

const USER_DEVICES_GENESIS = [
  'id', 'token_hash', 'label', 'os', 'hostname', 'created_at', 'connected_at', 'last_seen_at',
  'revoked_at',
];

/** The shape the production 500 shipped in: the six device-hardening columns in
 *  the DDL, none of them declared anywhere. */
const DRIFTED_DEVICES: TableDdl = {
  table: 'user_devices',
  file: 'packages/cf-backend/src/user/schema.ts',
  columns: [...USER_DEVICES_GENESIS, 'prev_token_hash', 'expires_at', 'last_ip', 'last_agent',
    'replaced_at', 'unstopped_at'],
};

const DEVICES_LOCK: GenesisLock = {
  [lockKey(DRIFTED_DEVICES.table, DRIFTED_DEVICES.file)]: USER_DEVICES_GENESIS,
};

describe('schema-drift TypeScript call discovery', () => {
  test('reads multiline callbacks, trailing commas, named objects and object spreads by AST', () => {
    const inspected = inspectBackfillCalls(new Map([['fixture.ts', `
      const SHARED = { first: 'TEXT' } as const;
      reconcileColumns(
        sql,
        (ddl) => { exec(ddl); },
        'alpha',
        { ...SHARED, second: 'INTEGER' },
      );
      reconcileSqlExecColumns(sql, 'beta', {
        third: 'TEXT',
      });
      ensureColumn(sql, 'gamma', 'fourth');
    `]]));

    expect(inspected.reconcileCalls).toBe(2);
    expect([...inspected.named].sort()).toEqual([
      'alpha.first', 'alpha.second', 'beta.third', 'gamma.fourth',
    ]);
  });

  test('fails closed when a column object is dynamically generated', () => {
    expect(() => inspectBackfillCalls(new Map([['fixture.ts', `
      const columns = Object.fromEntries([['added', 'TEXT']]);
      reconcileColumns(sql, execRaw, 'alpha', columns);
    `]]))).toThrow(/CallExpression, not an object or named object/u);
  });

  test('counts calls, never a same-named declaration or mention', () => {
    expect(() => inspectBackfillCalls(new Map([['fixture.ts', `
      function reconcileColumns() {}
      const mention = 'reconcileColumns(';
    `]]))).toThrow(/parsed no column reconciliation calls/u);
  });
});

describe('schema-drift DDL census', () => {
  // Every shape below was measured in this tree, and the previous regex — which
  // required the closing paren on a line of its own and read the table name as
  // `\w+` — reported on 114 of the 126 statements it claimed.
  test('reads a one-line DDL, nested parens and comment prose carrying commas', () => {
    const parsed = parseTables('fixture.ts', `
      execRaw('CREATE TABLE IF NOT EXISTS flat (id TEXT PRIMARY KEY, n INTEGER)');
      sql.exec(\`
        CREATE TABLE IF NOT EXISTS nested (
          id    INTEGER PRIMARY KEY CHECK (id = 1),
          -- Provenance of the accept, and the record that a socket took the slot.
          made  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (id, made)
        )
      \`);
    `);

    expect(parsed).toEqual([
      { table: 'flat', file: 'fixture.ts', columns: ['id', 'n'] },
      { table: 'nested', file: 'fixture.ts', columns: ['id', 'made'] },
    ]);
  });

  test('a prose mention of the statement is not a table', () => {
    // `CREATE TABLE IF NOT EXISTS is a no-op …` was censused as a table named
    // `is`; two more sentences produced `will` and `quietly`.
    expect(parseTables('fixture.ts', `
      // CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists.
      /** CREATE TABLE IF NOT EXISTS will not add a column to an older workspace. */
    `)).toEqual([]);
  });

  test('reads a body built from a template constant and from a generated column block', () => {
    const parsed = parseTables('fixture.ts', `
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
    `);

    expect(parsed).toEqual([
      { table: 'journal', file: 'fixture.ts', columns: ['id', 'token_input', 'neurons'] },
      { table: 'inline', file: 'fixture.ts', columns: ['id', 'token_input', 'neurons', 'tail'] },
    ]);
  });

  test('fails closed on an interpolation it cannot resolve', () => {
    expect(() => parseTables('fixture.ts', `
      execRaw(\`CREATE TABLE IF NOT EXISTS mystery (
        id TEXT PRIMARY KEY,
      \${buildColumns()}
      )\`);
    `)).toThrow(/mystery has a body part this cannot read/u);
  });

  test('a table declared twice in one file carries the union of both statements', () => {
    // outcomes.ts and imports.ts each create their table twice: once to finish an
    // interrupted rebuild, once on the ordinary path.
    expect(parseTables('fixture.ts', `
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, first INTEGER)');
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, second INTEGER)');
    `)).toEqual([{ table: 'both', file: 'fixture.ts', columns: ['id', 'first', 'second'] }]);
  });
});

describe('schema-drift genesis comparison', () => {
  test('RED: a column added after genesis with no backfill names the table and the column', () => {
    const violations = driftViolations([DRIFTED_DEVICES], new Set(), DEVICES_LOCK);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe('user_devices@packages/cf-backend/src/user/schema.ts');
    expect(violations[0]?.detail).toContain('unstopped_at');
    expect(violations[0]?.detail).toContain('prev_token_hash');
  });

  test('GREEN: the same tree once the columns are declared beside the DDL', () => {
    const declared = new Set([
      'user_devices.prev_token_hash', 'user_devices.expires_at', 'user_devices.last_ip',
      'user_devices.last_agent', 'user_devices.replaced_at', 'user_devices.unstopped_at',
    ]);

    expect(driftViolations([DRIFTED_DEVICES], declared, DEVICES_LOCK)).toEqual([]);
  });

  test('RED: a partial declaration still names the columns left out', () => {
    // Production reported `unstopped_at`; staging reported `last_ip` from an
    // older table. A reconcile naming one column moves the 500 to the next one.
    const partial = new Set(['user_devices.unstopped_at']);
    const detail = driftViolations([DRIFTED_DEVICES], partial, DEVICES_LOCK)[0]?.detail ?? '';

    expect(detail).toContain('last_ip');
    expect(detail).not.toContain('[unstopped_at');
  });

  test('RED: a table with no genesis entry is a violation, never an empty comparison', () => {
    const violations = driftViolations([DRIFTED_DEVICES], new Set(), {});

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('no entry in scripts/schema-genesis.lock.json');
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
    const update = lockUpdate([DRIFTED_DEVICES], DEVICES_LOCK, () => DRIFTED_DEVICES.columns);

    expect(update.added).toEqual([]);
    expect(update.refused).toHaveLength(1);
    expect(update.refused[0]).toContain('unstopped_at');
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: refuses to NARROW an existing entry, which would demand a pointless backfill', () => {
    const update = lockUpdate([DRIFTED_DEVICES], DEVICES_LOCK, () => ['id', 'token_hash']);

    expect(update.refused).toHaveLength(1);
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('the tree lock records the genesis this repository actually shipped', () => {
    // 8dab4c8e6, 2026-06-12. Verified against `git show` rather than recalled:
    // the six columns absent here are the six the production 500 named.
    expect(readGenesisLock()['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: a DDL moved to a path with no history inherits the narrowest locked genesis', () => {
    // The hole a per-run `git log -S` had, in its remaining form: relocate the
    // statement and the new key would lock at TODAY's shape, excusing the six
    // columns the move carried with it.
    const moved: TableDdl = {
      table: 'user_devices',
      file: 'packages/cf-backend/src/user/device-schema.ts',
      columns: DRIFTED_DEVICES.columns,
    };

    expect(genesisForNewTable(moved, DEVICES_LOCK)).toEqual(USER_DEVICES_GENESIS);
  });

  test('a genuinely new table with no history and no namesake locks at its own shape', () => {
    const fresh: TableDdl = {
      table: 'schema_drift_probe',
      file: 'packages/cf-backend/src/user/absent.ts',
      columns: ['id', 'made_at'],
    };

    expect(genesisForNewTable(fresh, DEVICES_LOCK)).toEqual(['id', 'made_at']);
  });
});

describe('schema-drift runtime-mover excuse', () => {
  const MOVER_SOURCES = new Map([
    ['packages/core/src/identity/schema.ts', `
      const FORK_LINEAGE_DDL = 'CREATE TABLE IF NOT EXISTS fork_lineage (id INTEGER PRIMARY KEY)';
      export function initAllTables(execRaw, sql) { execRaw(FORK_LINEAGE_DDL); }
      export function migrateWorkspaceStorage(sql, execRaw) { adoptLegacyForkLineage(sql, execRaw); }
      function adoptLegacyForkLineage(sql, execRaw) {}
    `],
    ['packages/core/src/identity/open.ts', `
      import { initAllTables, migrateWorkspaceStorage } from './schema';
      export function openWorkspace(db) {
        initAllTables(execRaw, sql);
        migrateWorkspaceStorage(sql, execRaw);
      }
    `],
  ]);

  test('GREEN: the mover is called in the declaring module and runs after the init', () => {
    expect(moverViolations(MOVER_SOURCES)).toEqual([]);
  });

  test('RED: the excuse dies with the mover call', () => {
    const withoutMover = new Map(MOVER_SOURCES);
    withoutMover.set('packages/core/src/identity/schema.ts', `
      const FORK_LINEAGE_DDL = 'CREATE TABLE IF NOT EXISTS fork_lineage (id INTEGER PRIMARY KEY)';
      export function initAllTables(execRaw, sql) { execRaw(FORK_LINEAGE_DDL); }
      export function migrateWorkspaceStorage(sql, execRaw) {}
      function adoptLegacyForkLineage(sql, execRaw) {}
    `);
    const violations = moverViolations(withoutMover);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe('fork_lineage.mover');
    expect(violations[0]?.detail).toContain('no call to adoptLegacyForkLineage');
  });

  test('RED: the mover reading a table that does not exist yet is an ordering failure', () => {
    const inverted = new Map(MOVER_SOURCES);
    inverted.set('packages/core/src/identity/open.ts', `
      import { initAllTables, migrateWorkspaceStorage } from './schema';
      export function openWorkspace(db) {
        migrateWorkspaceStorage(sql, execRaw);
        initAllTables(execRaw, sql);
      }
    `);
    const violations = moverViolations(inverted);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.key).toBe('fork_lineage.order@packages/core/src/identity/open.ts');
  });

  test('a declaration or a mention is not a call', () => {
    const mentionOnly = new Map(MOVER_SOURCES);
    mentionOnly.set('packages/core/src/identity/schema.ts', `
      const FORK_LINEAGE_DDL = 'CREATE TABLE IF NOT EXISTS fork_lineage (id INTEGER PRIMARY KEY)';
      export function initAllTables(execRaw, sql) { execRaw(FORK_LINEAGE_DDL); }
      export function migrateWorkspaceStorage(sql, execRaw) {}
      /** adoptLegacyForkLineage moves the row. */
      function adoptLegacyForkLineage(sql, execRaw) {}
    `);

    expect(moverViolations(mentionOnly)[0]?.key).toBe('fork_lineage.mover');
  });
});

describe('schema-drift over this tree', () => {
  test('every table is locked, censused and free of undeclared drift', () => {
    const state = survey();

    expect(state.violations).toEqual([]);
    // The census is the governed set: a gate whose corpus quietly shrinks is the
    // defect this file exists to make impossible.
    expect(state.tables.length).toBeGreaterThanOrEqual(118);
    expect(Object.keys(state.lock).length).toBeGreaterThanOrEqual(state.tables.length);
    expect(state.backfill.reconcileCalls).toBeGreaterThanOrEqual(29);
  });

  test('the census reads every CREATE TABLE IF NOT EXISTS the corpus holds', () => {
    // MEASURES == GOVERNS, checked rather than claimed: every statement in the
    // corpus that names a table appears in the census.
    const state = survey();
    const censused = new Set(state.tables.map(({ table, file }) => lockKey(table, file)));
    const declared = tablesIn(new Map(state.tables.map(({ file }) => [file, ''])));

    expect(declared).toEqual([]);
    for (const { table, file } of state.tables) expect(censused.has(lockKey(table, file))).toBe(true);
  });
});

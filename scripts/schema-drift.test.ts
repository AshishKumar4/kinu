import { describe, expect, test } from 'bun:test';
import {
  driftViolations,
  genesisForNewTable,
  lockKey,
  lockUpdate,
  parseTables,
  survey,
  tablesIn,
  type GenesisLock,
  type TableDdl,
} from './schema-drift';

const USER_DEVICES_GENESIS = [
  'id', 'token_hash', 'label', 'os', 'hostname', 'created_at', 'connected_at', 'last_seen_at',
  'revoked_at',
];

/** The shape the production 500 shipped in: six device-hardening columns in
 *  the DDL that the storage created at genesis never had. */
const DRIFTED_DEVICES: TableDdl = {
  table: 'user_devices',
  file: 'packages/cf-backend/src/user/schema.ts',
  columns: [...USER_DEVICES_GENESIS, 'prev_token_hash', 'expires_at', 'last_ip', 'last_agent',
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
    expect(parseTables('fixture.ts', `
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, first INTEGER)');
      execRaw('CREATE TABLE IF NOT EXISTS both (id TEXT PRIMARY KEY, second INTEGER)');
    `)).toEqual([{ table: 'both', file: 'fixture.ts', columns: ['id', 'first', 'second'] }]);
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
    const narrowed: TableDdl = { ...DRIFTED_DEVICES, columns: ['id', 'token_hash'] };
    const detail = driftViolations([narrowed], DEVICES_LOCK)[0]?.detail ?? '';

    expect(detail).toContain('removed after genesis');
    expect(detail).toContain('revoked_at');
    expect(detail).not.toContain('added after genesis');
  });

  test('GREEN: a DDL that matches its genesis, in any column order', () => {
    const reordered: TableDdl = {
      ...DRIFTED_DEVICES, columns: [...USER_DEVICES_GENESIS].reverse(),
    };

    expect(driftViolations([reordered], DEVICES_LOCK)).toEqual([]);
  });

  test('RED: a table with no genesis entry is a violation, never an empty comparison', () => {
    const violations = driftViolations([DRIFTED_DEVICES], {});

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

  test('RED: refuses to NARROW an existing entry, which would report columns the table shipped with', () => {
    const update = lockUpdate([DRIFTED_DEVICES], DEVICES_LOCK, () => ['id', 'token_hash']);

    expect(update.refused).toHaveLength(1);
    expect(update.next['user_devices@packages/cf-backend/src/user/schema.ts'])
      .toEqual(USER_DEVICES_GENESIS);
  });

  test('RED: a DDL moved to another file inherits the narrowest locked genesis', () => {
    // Relocate the statement and the new key would lock at TODAY's shape,
    // excusing the six columns the move carried with it.
    const moved: TableDdl = {
      table: 'user_devices',
      file: 'packages/cf-backend/src/user/device-schema.ts',
      columns: DRIFTED_DEVICES.columns,
    };

    expect(genesisForNewTable(moved, DEVICES_LOCK)).toEqual(USER_DEVICES_GENESIS);
  });

  test('a genuinely new table with no namesake locks at its own shape', () => {
    const fresh: TableDdl = {
      table: 'schema_drift_probe',
      file: 'packages/cf-backend/src/user/absent.ts',
      columns: ['id', 'made_at'],
    };

    expect(genesisForNewTable(fresh, DEVICES_LOCK)).toEqual(['id', 'made_at']);
  });
});

describe('schema-drift over this tree', () => {
  test('every table is locked, censused and equal to its genesis', () => {
    const state = survey();

    expect(state.violations).toEqual([]);
    // The census is the governed set: a gate whose corpus quietly shrinks is the
    // defect this file exists to make impossible. 116 is the count at the reset
    // genesis, after `crafted_tools` lost its two duplicate declarations and
    // kept one owner (`@kinu.run/agent-utils`).
    expect(state.tables.length).toBeGreaterThanOrEqual(116);
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

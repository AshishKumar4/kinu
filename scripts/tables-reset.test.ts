// The tables reset's plan and its reach: which tables a release changed (from the two genesis locks, never a list),
// what each object holds of them, and that every object is asked under a pass this run wrote and then deleted.
import { expect, test } from 'bun:test';
import { sha256Hex } from '@kinu.run/core';
import { censusLines, changedTables, confirmation, planLines, reachAll, undetectableChanges, type Reached, type TablesTarget } from './tables-reset';

const FROM = {
  'device_joins@packages/core/src/state/user-schema.ts': ['device_id TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL'],
  'device_consent_requests@packages/core/src/safety/device-consent.ts': ['consent_id TEXT PRIMARY KEY'],
  'device_connect_tickets@packages/core/src/state/user-schema.ts': ['ticket_hash TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL', 'used_at INTEGER'],
  'driver_lease@packages/core/src/execution/driver-lease.ts': ['id TEXT PRIMARY KEY', 'pid INTEGER NOT NULL'],
  'user_profile@packages/core/src/state/user-schema.ts': ['id INTEGER PRIMARY KEY', 'email TEXT NOT NULL'],
  'notes@packages/core/src/a.ts': ['id TEXT PRIMARY KEY', 'kind TEXT CHECK(kind IN (\'a\'))'],
};

const TO = {
  ...FROM,
  'device_joins@packages/core/src/state/user-schema.ts': ['device_id TEXT PRIMARY KEY', 'ticket_hash TEXT NOT NULL UNIQUE', 'workspace TEXT', 'expires_at INTEGER NOT NULL'],
  'driver_lease@packages/core/src/execution/driver-lease.ts': ['id TEXT PRIMARY KEY', 'pid INTEGER NOT NULL', 'generation TEXT NOT NULL'],
  'device_consent_asks@packages/core/src/safety/device-consent.ts': ['consent_id TEXT PRIMARY KEY'],
  'device_connect_tickets@packages/core/src/state/user-schema.ts': ['ticket_hash TEXT PRIMARY KEY', 'expires_at INTEGER NOT NULL'],
};

const { 'device_consent_requests@packages/core/src/safety/device-consent.ts': _removed, ...CANDIDATE } = TO;

test('the changed tables come from the two locks: removed, only columns dropped, remade, and added', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);

  expect(changed).toEqual([
    { table: 'device_connect_tickets', change: 'columns', columns: ['ticket_hash', 'expires_at'], dropped: ['used_at'] },
    { table: 'device_consent_requests', change: 'removed', columns: [], dropped: [] },
    { table: 'device_joins', change: 'remade', columns: ['device_id', 'ticket_hash', 'workspace', 'expires_at'], dropped: [] },
    { table: 'driver_lease', change: 'remade', columns: ['id', 'pid', 'generation'], dropped: [] },
  ]);
  expect(added).toEqual(['device_consent_asks']);
});

test('a change that keeps every column name is one no object can tell apart, and is named', () => {
  const widened = { ...FROM, 'notes@packages/core/src/a.ts': ['id TEXT PRIMARY KEY', 'kind TEXT CHECK(kind IN (\'a\', \'b\'))'] };

  expect(undetectableChanges(changedTables(FROM, widened).changed, FROM)).toEqual(['notes']);
  expect(undetectableChanges(changedTables(FROM, CANDIDATE).changed, FROM)).toEqual([]);
});

test('a column dropped beside another change remakes its table', () => {
  const both = { ...FROM, 'device_connect_tickets@packages/core/src/state/user-schema.ts': ['ticket_hash TEXT PRIMARY KEY', 'expires_at INTEGER'] };

  expect(changedTables(FROM, both).changed).toEqual([{ table: 'device_connect_tickets', change: 'remade', columns: ['ticket_hash', 'expires_at'], dropped: [] }]);
});

const ACCOUNT: Reached = {
  className: 'UserDO', id: 'a'.repeat(64),
  answer: {
    name: null, census: [{ table: 'user_profile', rows: 1 }, { table: 'device_joins', rows: 2 }], dropped: [],
    held: [{ table: 'device_joins', rows: 2, stale: true, keepsRows: false }, { table: 'device_connect_tickets', rows: 4, stale: true, keepsRows: true }],
  },
};

const WORKSPACE: Reached = {
  className: 'OrchestratorAgent', id: 'b'.repeat(64),
  answer: { name: 'jarvis', census: [{ table: 'device_consent_requests', rows: 3 }], held: [{ table: 'device_consent_requests', rows: 3, stale: true, keepsRows: false }], dropped: [] },
};

const LOST: Reached = { className: 'OrchestratorAgent', id: 'c'.repeat(64), error: 'reached by id before any named start' };

test('a census is one sorted line per object and table, an unreachable object one line of its own', () => {
  expect(censusLines([WORKSPACE, LOST, ACCOUNT])).toEqual([
    `OrchestratorAgent\t${'c'.repeat(64)}\t!unreachable\treached by id before any named start`,
    'OrchestratorAgent\tjarvis\tdevice_consent_requests\t3',
    `UserDO\t${'a'.repeat(64)}\tdevice_joins\t2`,
    `UserDO\t${'a'.repeat(64)}\tuser_profile\t1`,
  ]);
});

test('the plan names each table\'s class, its change and its rows per object, and what no object holds', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);
  const lines = planLines(changed, added, [ACCOUNT, WORKSPACE, LOST]);

  expect(lines).toEqual([
    'LOSSLESS (columns dropped, rows kept): ',
    `  device_connect_tickets [UserDO]: drop column(s) used_at on UserDO ${'a'.repeat(64)}; its 4 row(s) kept`,
    'LOSES DATA (tables dropped): ',
    '  device_consent_requests [OrchestratorAgent]: drop the table on OrchestratorAgent jarvis: 3 row(s) lost',
    `  device_joins [UserDO]: drop and remake the table on UserDO ${'a'.repeat(64)}: 2 row(s) lost`,
    'held by no UserDO or OrchestratorAgent object (a table only a CLI-local database holds is outside this step):',
    '  driver_lease (remade)',
    'added, made by each object\'s init: device_consent_asks',
    'UNREACHED:',
    `  OrchestratorAgent ${'c'.repeat(64)}: reached by id before any named start`,
  ]);
  expect(confirmation(changed)).toBe('reset tables device_consent_requests,device_joins,driver_lease columns device_connect_tickets.used_at');
});

test('every object is asked under a pass this run wrote, in batches, waiting out the pass\'s propagation, and the pass is deleted', async () => {
  const admitted: string[] = [];
  const forgotten: string[] = [];
  const batches: number[] = [];
  let refusals = 1;

  const target: TablesTarget = {
    objects: async (className) => (className === 'UserDO' ? Array.from({ length: 120 }, (_, at) => at.toString(16).padStart(64, '0')) : []),
    admit: (digest) => { admitted.push(digest); },
    forget: (digest) => { forgotten.push(digest); },
    ops: async (pass, body) => {
      expect(admitted).toEqual([sha256Hex(pass)]);

      if (refusals-- > 0) return { status: 401, text: 'not yet' };
      batches.push(body.ids.length);

      return { status: 200, text: JSON.stringify({ objects: body.ids.map((id) => ({ id, answer: { name: null, census: [], held: [], dropped: [] } })) }) };
    },
  };

  const reached = await reachAll(target, { tables: [], drop: false });

  expect(reached).toHaveLength(120);
  expect(batches).toEqual([50, 50, 20]);
  expect(forgotten).toEqual(admitted);
}, 30_000);

test('the pass is deleted when a batch fails', async () => {
  const forgotten: string[] = [];

  const target: TablesTarget = {
    objects: async () => ['d'.repeat(64)],
    admit: () => {},
    forget: (digest) => { forgotten.push(digest); },
    ops: async () => ({ status: 500, text: 'broken' }),
  };

  await expect(reachAll(target, { tables: [], drop: false })).rejects.toThrow('/ops/tables answered 500');
  expect(forgotten).toHaveLength(1);
});

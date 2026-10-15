// The tables reset's plan and its reach: which tables a release changed (from the two genesis locks, never a list),
// what each object holds of them, and that every object is asked under a pass this run wrote and then deleted.
import { expect, test } from 'bun:test';
import { sha256Hex } from '@kinu.run/core';
import { censusDiff, censusLines, changedTables, confirmation, planLines, reachAll, type Reached, type TablesTarget } from './tables-reset';

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

test('the changed tables come from the two locks: removed, reshaped, and added', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);

  expect(changed).toEqual([
    { table: 'device_connect_tickets', change: 'reshaped' },
    { table: 'device_consent_requests', change: 'removed' },
    { table: 'device_joins', change: 'reshaped' },
    { table: 'driver_lease', change: 'reshaped' },
  ]);
  expect(added).toEqual(['device_consent_asks']);
});

const ACCOUNT: Reached = {
  className: 'UserDO', id: 'a'.repeat(64),
  answer: {
    name: null, stamp: 'behind', census: [{ table: 'user_profile', rows: 1 }, { table: 'device_joins', rows: 2 }], dropped: [], rebuilt: [],
    held: [{ table: 'device_joins', rows: 2, stale: true, keepsRows: false }, { table: 'device_connect_tickets', rows: 4, stale: true, keepsRows: true }],
  },
};

const WORKSPACE: Reached = {
  className: 'OrchestratorAgent', id: 'b'.repeat(64),
  answer: {
    name: 'jarvis', stamp: 'current', census: [{ table: 'device_consent_requests', rows: 3 }], dropped: [], rebuilt: [],
    held: [{ table: 'device_consent_requests', rows: 3, stale: true, keepsRows: false }],
    agents: [{
      name: 'main', stamp: 'behind', census: [{ table: 'session_messages', rows: 9 }], dropped: [], rebuilt: [],
      held: [{ table: 'device_consent_requests', rows: 1, stale: true, keepsRows: false }],
    }],
  },
};

const LOST: Reached = { className: 'OrchestratorAgent', id: 'c'.repeat(64), error: 'reached by id before any named start' };

test('a census is one sorted line per object and table, an unreachable object one line of its own', () => {
  expect(censusLines([WORKSPACE, LOST, ACCOUNT])).toEqual([
    `OrchestratorAgent\t${'c'.repeat(64)}\t!unreachable\treached by id before any named start`,
    'OrchestratorAgent\tjarvis\tdevice_consent_requests\t3',
    `UserDO\t${'a'.repeat(64)}\tdevice_joins\t2`,
    `UserDO\t${'a'.repeat(64)}\tuser_profile\t1`,
    'agent\tjarvis/main\tsession_messages\t9',
  ]);
});

test('the plan names each table\'s class, its change and its rows per object, and what no object holds', () => {
  const { changed, added } = changedTables(FROM, CANDIDATE);
  const lines = planLines(changed, added, [ACCOUNT, WORKSPACE, LOST]);

  expect(lines).toEqual([
    'LOSSLESS (rebuild, rows kept): ',
    `  device_connect_tickets [UserDO]: rebuild on UserDO ${'a'.repeat(64)}; its 4 row(s) kept`,
    'LOSES DATA (tables dropped): ',
    '  device_consent_requests [OrchestratorAgent, agent]: drop the table on OrchestratorAgent jarvis: 3 row(s) lost',
    '  device_consent_requests [OrchestratorAgent, agent]: drop the table on agent jarvis/main: 1 row(s) lost',
    `  device_joins [UserDO]: drop and remake the table on UserDO ${'a'.repeat(64)}: 2 row(s) lost`,
    'STAMPED (behind this build, refused until reached): 1 UserDO, 1 agent',
    'held by no account, workspace or agent database (a CLI-local table is outside this step):',
    '  driver_lease (reshaped)',
    'added, made by each database\'s init: device_consent_asks',
    'UNREACHED:',
    `  OrchestratorAgent ${'c'.repeat(64)}: reached by id before any named start`,
  ]);
  expect(confirmation([ACCOUNT, WORKSPACE, LOST])).toBe('reset tables rebuild device_connect_tickets drop device_consent_requests,device_joins');
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

      return { status: 200, text: JSON.stringify({ objects: body.ids.map((id) => ({ id, answer: { name: null, stamp: 'current', census: [], held: [], dropped: [], rebuilt: [] } })) }) };
    },
  };

  const reached = await reachAll(target, { tables: [], drop: false });

  expect(reached).toHaveLength(120);
  expect(batches).toEqual([50, 50, 20]);
  expect(forgotten).toEqual(admitted);
});

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

test('the census diff splits what the release meant to move from what it did not', () => {
  const before = ['UserDO\tu1\tdevice_joins\t2', 'UserDO\tu1\tuser_profile\t1', 'OrchestratorAgent\tjarvis\tsession_messages\t9'];
  const after = ['UserDO\tu1\tdevice_joins\t0', 'UserDO\tu1\tuser_profile\t1', 'OrchestratorAgent\tjarvis\tsession_messages\t8'];

  expect(censusDiff(before, after, new Set(['device_joins']))).toEqual({
    meant: ['UserDO u1 device_joins: 2 → 0'],
    unmeant: ['OrchestratorAgent jarvis session_messages: 9 → 8'],
  });
});
